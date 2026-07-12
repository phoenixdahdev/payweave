/**
 * Shared test harness for the unified layer (Surface B). Builds a real
 * {@link UnifiedNamespace} backed by a real {@link HttpClient} pointed at the
 * provider's live base URL, and mocks the network edge with MSW (never stubs
 * HttpClient/fetch). Mirrors the Paystack/Flutterwave resource harnesses;
 * captures outgoing requests so tests can assert method/path/query/body.
 *
 * ORDER MATTERS: `server.listen()` must run BEFORE the {@link HttpClient} is
 * constructed, because the client captures the global `fetch` reference at
 * construction time — MSW patches that global on `listen()`. Building the client
 * first would capture the un-patched fetch and escape interception.
 */
import type { SetupServer } from "msw/node";
import { HttpClient, bearer } from "../../src/core/http";
import { PAYSTACK_BASE_URL, FLW_V3_BASE_URL } from "../../src/core/config";
import { createPaystackUnified, createFlutterwaveUnified } from "../../src/unified/index";
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

/** Spin up a Paystack unified namespace + MSW server for the given routes. */
export async function makePaystackUnified(routes: MockRoute[]): Promise<UnifiedHarness> {
  const { server, raw } = await startServer(routes);
  // Construct the client AFTER listen() so it captures MSW's patched fetch.
  const http = new HttpClient({
    baseUrl: PAYSTACK_BASE_URL,
    auth: bearer("sk_test_harness"),
    provider: "paystack",
    maxRetries: 0,
  });
  return harness(server, raw, createPaystackUnified(http));
}

/** Spin up a Flutterwave v3 unified namespace + MSW server for the given routes. */
export async function makeFlutterwaveUnified(routes: MockRoute[]): Promise<UnifiedHarness> {
  const { server, raw } = await startServer(routes);
  const http = new HttpClient({
    baseUrl: FLW_V3_BASE_URL,
    auth: bearer("FLWSECK_TEST-harness"),
    provider: "flutterwave",
    version: "v3",
    maxRetries: 0,
  });
  return harness(server, raw, createFlutterwaveUnified(http, "v3"));
}
