/**
 * Shared test harness for the unified layer (Surface B). Builds the unified
 * ops THROUGH `createPayweave` (PW-502 — the whole suite passing unchanged is
 * the proof that the new client routes identically to the direct per-provider
 * factories), and mocks the network edge with MSW (never stubs
 * HttpClient/fetch). Captures outgoing requests so tests can assert
 * method/path/query/body. `makeLegacyPaystackUnified` keeps one explicit
 * old-factory path covered until PW-504 delegates it.
 *
 * ORDER MATTERS: `server.listen()` must run BEFORE the client is constructed,
 * because HttpClient captures the global `fetch` reference at construction
 * time — MSW patches that global on `listen()`. Building the client first
 * would capture the un-patched fetch and escape interception.
 */
import type { SetupServer } from "msw/node";
import { createPayweave, createPaystack } from "../../src/index";
import type { UnifiedNamespace } from "../../src/unified/index";
import { createMswServer, type MockRoute } from "../../src/testing/msw";

/** Structural lookups — the subset of URLSearchParams / Headers tests read. */
export interface QueryLookup {
  get(name: string): string | null;
  has(name: string): boolean;
}
export interface HeaderLookup {
  get(name: string): string | null;
}

/** A captured outgoing request (parsed for assertions). */
export interface CapturedRequest {
  method: string;
  url: string;
  path: string;
  search: QueryLookup;
  headers: HeaderLookup;
  /** JSON-parsed body (or the raw string / undefined when absent). */
  body: unknown;
}

export interface UnifiedHarness {
  unified: UnifiedNamespace;
  server: SetupServer;
  requests: () => Promise<CapturedRequest[]>;
  lastRequest: () => Promise<CapturedRequest>;
  close: () => void;
}

async function parse(req: Request): Promise<CapturedRequest> {
  const url = new URL(req.url);
  let body: unknown;
  const text = await req.text();
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    method: req.method,
    url: req.url,
    path: url.pathname,
    search: url.searchParams,
    headers: req.headers,
    body,
  };
}

async function startServer(routes: MockRoute[]): Promise<{ server: SetupServer; raw: Request[] }> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });
  return { server, raw };
}

function harness(server: SetupServer, raw: Request[], unified: UnifiedNamespace): UnifiedHarness {
  return {
    unified,
    server,
    requests: () => Promise.all(raw.map(parse)),
    lastRequest: async () => {
      const all = await Promise.all(raw.map(parse));
      if (all.length !== 1) throw new Error(`expected exactly 1 request, saw ${all.length}`);
      return all[0]!;
    },
    close: () => server.close(),
  };
}

/** Spin up Paystack unified ops (via `createPayweave`) + MSW for the given routes. */
export async function makePaystackUnified(routes: MockRoute[]): Promise<UnifiedHarness> {
  const { server, raw } = await startServer(routes);
  // Construct the client AFTER listen() so it captures MSW's patched fetch.
  // The client ROOT satisfies UnifiedNamespace (§3 — ops moved to the root).
  const client = createPayweave({ paystack: { secretKey: "sk_test_harness", maxRetries: 0 } });
  return harness(server, raw, client);
}

/** Spin up Flutterwave v3 unified ops (via `createPayweave`) + MSW for the given routes. */
export async function makeFlutterwaveUnified(routes: MockRoute[]): Promise<UnifiedHarness> {
  const { server, raw } = await startServer(routes);
  const client = createPayweave({
    flutterwave: { secretKey: "FLWSECK_TEST-harness", maxRetries: 0 },
  });
  return harness(server, raw, client);
}

/**
 * Old-factory control: the same Paystack unified surface built through the
 * legacy `createPaystack` facade (`sdk.unified.*`). Kept so at least one
 * unified test exercises the pre-PW-502 construction path until PW-504 turns
 * the old factories into delegating aliases.
 */
export async function makeLegacyPaystackUnified(routes: MockRoute[]): Promise<UnifiedHarness> {
  const { server, raw } = await startServer(routes);
  const sdk = createPaystack({ secretKey: "sk_test_harness", maxRetries: 0 });
  return harness(server, raw, sdk.unified);
}
