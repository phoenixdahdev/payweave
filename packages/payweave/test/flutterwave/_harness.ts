/**
 * Shared test harness for Flutterwave v3 resource tests. Builds a real
 * {@link FlutterwaveClient} backed by a real {@link HttpClient} pointed at the
 * live v3 base URL, and mocks the network edge with MSW (never stubs
 * HttpClient/fetch). Captures outgoing requests so tests can assert
 * method/path/headers/body. Mirrors the Paystack harness.
 */
import type { SetupServer } from "msw/node";
import { HttpClient, bearer } from "../../src/core/http";
import { FLW_V3_BASE_URL } from "../../src/core/config";
import { FlutterwaveClient } from "../../src/flutterwave/client";
import { createMswServer, type MockRoute } from "../../src/testing/msw";
import type { Logger } from "../../src/core/logger";

/** Structural query-lookup — the subset of `URLSearchParams` tests read. */
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

export interface FlutterwaveHarness {
  client: FlutterwaveClient;
  server: SetupServer;
  /** All requests captured so far, most recent last. */
  requests: () => Promise<CapturedRequest[]>;
  /** The single captured request (asserts exactly one was made). */
  lastRequest: () => Promise<CapturedRequest>;
  close: () => void;
}

/**
 * Spin up a Flutterwave v3 client + MSW server for the given mock routes.
 * The caller `close()`s in a finally/afterEach.
 */
export async function makeFlutterwave(
  routes: MockRoute[],
  opts: { secretKey?: string; encryptionKey?: string; logger?: Logger } = {},
): Promise<FlutterwaveHarness> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

  const http = new HttpClient({
    baseUrl: FLW_V3_BASE_URL,
    auth: bearer(opts.secretKey ?? "FLWSECK_TEST-harness"),
    provider: "flutterwave",
    version: "v3",
    maxRetries: 0,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const client = new FlutterwaveClient(http, "v3", opts.encryptionKey);

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
