/**
 * Shared test harness for Paystack resource tests. Builds a real
 * {@link PaystackClient} backed by a real {@link HttpClient} pointed at the
 * live Paystack base URL, and mocks the network edge with MSW (never stubs
 * HttpClient/fetch). Captures outgoing requests so tests can assert
 * method/path/headers/body.
 */
import type { SetupServer } from "msw/node";
import { HttpClient, bearer } from "../../src/core/http";
import { PAYSTACK_BASE_URL } from "../../src/core/config";
import { PaystackClient } from "../../src/paystack/client";
import { createMswServer, type MockRoute } from "../../src/testing/msw";

/**
 * Structural query-lookup — the subset of `URLSearchParams` tests read. Defined
 * locally so the declaration-rollup step (api-extractor) never has to follow the
 * global `URLSearchParams`/`Headers` symbols (same reason core does this for
 * `Headers`/`Request`). The real globals are assignable to these.
 */
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

export interface PaystackHarness {
  client: PaystackClient;
  server: SetupServer;
  /** All requests captured so far, most recent last. */
  requests: () => Promise<CapturedRequest[]>;
  /** The single captured request (asserts exactly one was made). */
  lastRequest: () => Promise<CapturedRequest>;
  close: () => void;
}

/**
 * Spin up a Paystack client + MSW server for the given mock routes.
 * The caller `close()`s in a finally/afterEach.
 */
export async function makePaystack(
  routes: MockRoute[],
  opts: { secretKey?: string } = {},
): Promise<PaystackHarness> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  // request:start fires synchronously at the start of msw's handling pipeline,
  // before the client's awaited call resolves. Clone with no await so the push
  // is synchronous and the request body stays readable.
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

  const http = new HttpClient({
    baseUrl: PAYSTACK_BASE_URL,
    auth: bearer(opts.secretKey ?? "sk_test_harness"),
    provider: "paystack",
    maxRetries: 0,
  });
  const client = new PaystackClient(http);

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

  return {
    client,
    server,
    requests: () => Promise.all(raw.map(parse)),
    lastRequest: async () => {
      const all = await Promise.all(raw.map(parse));
      if (all.length !== 1) {
        throw new Error(`expected exactly 1 request, saw ${all.length}`);
      }
      return all[0]!;
    },
    close: () => server.close(),
  };
}
