/**
 * Shared test harness for Stripe resource tests. Builds a real
 * {@link StripeClient} backed by a real {@link HttpClient} constructed through
 * the production wiring (`resolvePayweaveConfig` → `stripeHttpOptions`: bearer
 * auth, pinned Stripe-Version, form bodyEncoder) pointed at the live Stripe
 * base URL, and mocks the network edge with MSW (never stubs HttpClient/fetch).
 *
 * Unlike the Paystack harness, `parse()` decodes request bodies as
 * `application/x-www-form-urlencoded` via `URLSearchParams` — and THROWS when
 * a body arrives with a JSON content type or JSON-looking payload, so any test
 * that lets a JSON body leave the Stripe client fails loudly (providers.md §6
 * acceptance criterion).
 */
import type { SetupServer } from "msw/node";
import { HttpClient } from "../../src/core/http";
import { resolvePayweaveConfig } from "../../src/core/config";
import { stripeHttpOptions } from "../../src/stripe/http-options";
import { StripeClient } from "../../src/stripe/client";
import { createMswServer, type MockRoute } from "../../src/testing/msw";

/** Placeholder secret for tests only — never a real key, never in fixtures. */
export const TEST_SECRET_KEY = "sk_test_harness";

/**
 * Structural lookups — the subset of `URLSearchParams`/`Headers` tests read
 * (kept structural for the same api-extractor reason as the Paystack harness).
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
  /** The raw body string exactly as sent (empty string when absent). */
  rawBody: string;
  /** Bracket-notation form pairs decoded via `URLSearchParams` (empty when no body). */
  form: QueryLookup;
}

export interface StripeHarness {
  client: StripeClient;
  server: SetupServer;
  /** All requests captured so far, most recent last. */
  requests: () => Promise<CapturedRequest[]>;
  /** The single captured request (asserts exactly one was made). */
  lastRequest: () => Promise<CapturedRequest>;
  close: () => void;
}

/**
 * Spin up a Stripe client + MSW server for the given mock routes.
 * The caller `close()`s in a finally/afterEach.
 */
export async function makeStripe(
  routes: MockRoute[],
  opts: { secretKey?: string; accountId?: string; maxRetries?: number } = {},
): Promise<StripeHarness> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  // request:start fires synchronously at the start of msw's handling pipeline,
  // before the client's awaited call resolves. Clone with no await so the push
  // is synchronous and the request body stays readable.
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

  const resolved = resolvePayweaveConfig({
    stripe: {
      secretKey: opts.secretKey ?? TEST_SECRET_KEY,
      ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
      maxRetries: opts.maxRetries ?? 0,
    },
  }).providerConfigs.stripe!;
  const client = new StripeClient(new HttpClient(stripeHttpOptions(resolved)));

  async function parse(req: Request): Promise<CapturedRequest> {
    const url = new URL(req.url);
    const text = await req.text();
    if (text !== "") {
      // The §6 acceptance criterion: no JSON body ever leaves the Stripe
      // client. A JSON content type or JSON-looking payload fails the test.
      const contentType = req.headers.get("content-type") ?? "";
      if (!contentType.includes("application/x-www-form-urlencoded")) {
        throw new Error(
          `Stripe request body must be application/x-www-form-urlencoded, saw "${contentType}".`,
        );
      }
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        throw new Error(`Stripe request body looks like JSON, not form data: ${text}`);
      }
    }
    return {
      method: req.method,
      url: req.url,
      path: url.pathname,
      search: url.searchParams,
      headers: req.headers,
      rawBody: text,
      form: new URLSearchParams(text),
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
