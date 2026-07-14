import { afterEach, describe, expect, it } from "vitest";
import { stripeAuth, stripeHttpOptions } from "../../src/stripe/http-options";
import { encodeStripeForm } from "../../src/stripe/form-encoding";
import { HttpClient } from "../../src/core/http";
import {
  resolvePayweaveConfig,
  STRIPE_API_VERSION,
  STRIPE_BASE_URL,
} from "../../src/core/config";
import { PayweaveConfigError } from "../../src/core/errors";
import { createMswServer } from "../../src/testing/msw";
import type { SetupServer } from "msw/node";

function resolvedStripe(sub: Record<string, unknown> = {}) {
  const resolved = resolvePayweaveConfig({ stripe: { secretKey: "sk_test_x", ...sub } });
  return resolved.providerConfigs.stripe!;
}

describe("stripeAuth", () => {
  async function applied(opts: Parameters<typeof stripeAuth>[0]): Promise<Headers> {
    const headers = new Headers();
    await stripeAuth(opts).applyAuth({ headers });
    return headers;
  }

  it("sets Authorization: Bearer and pins Stripe-Version to the SDK default", async () => {
    const headers = await applied({ secretKey: "sk_test_x" });
    expect(headers.get("authorization")).toBe("Bearer sk_test_x");
    expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(headers.get("stripe-account")).toBeNull();
  });

  it("honors an apiVersion override", async () => {
    const headers = await applied({ secretKey: "sk_test_x", apiVersion: "2026-01-01.dahlia" });
    expect(headers.get("stripe-version")).toBe("2026-01-01.dahlia");
  });

  it("sets Stripe-Account only when a Connect accountId is given", async () => {
    const headers = await applied({ secretKey: "rk_live_x", accountId: "acct_123" });
    expect(headers.get("stripe-account")).toBe("acct_123");
  });
});

describe("stripeHttpOptions", () => {
  it("wires baseUrl, provider, transport passthrough, and the form bodyEncoder", () => {
    const logger = () => undefined;
    const fetchImpl = async () => {
      throw new Error("unused");
    };
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x", timeoutMs: 5000, maxRetries: 1 },
      fetch: fetchImpl,
      logger,
    }).providerConfigs.stripe!;

    const options = stripeHttpOptions(resolved);
    expect(options.baseUrl).toBe(STRIPE_BASE_URL);
    expect(options.provider).toBe("stripe");
    expect(options.timeoutMs).toBe(5000);
    expect(options.maxRetries).toBe(1);
    expect(options.fetch).toBe(fetchImpl);
    expect(options.logger).toBe(logger);
    expect(options.bodyEncoder).toBe(encodeStripeForm);
  });

  it("rejects a non-stripe resolved config", () => {
    const paystack = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
    }).providerConfigs.paystack!;
    expect(() => stripeHttpOptions(paystack)).toThrow(PayweaveConfigError);
    expect(() => stripeHttpOptions(paystack)).toThrow(/"paystack"/);
  });

  it("rejects a hand-built stripe config with no secretKey", () => {
    const broken = { ...resolvedStripe(), secretKey: undefined };
    expect(() => stripeHttpOptions(broken)).toThrow(PayweaveConfigError);
  });
});

describe("stripe HttpClient over the network edge (MSW)", () => {
  let server: SetupServer | undefined;
  afterEach(() => server?.close());

  it("sends bracket-notation form bodies with auth + version headers — never JSON", async () => {
    server = await createMswServer([
      {
        method: "post",
        url: "https://api.stripe.com/v1/checkout/sessions",
        json: { id: "cs_test_1", object: "checkout.session" },
      },
    ]);
    const captured: Request[] = [];
    server.events.on("request:start", ({ request }) => {
      captured.push(request.clone());
    });
    server.listen({ onUnhandledRequest: "error" });

    const resolved = resolvedStripe({ accountId: "acct_42" });
    const http = new HttpClient(stripeHttpOptions(resolved));
    const res = await http.request<{ id: string }>({
      method: "POST",
      path: "/v1/checkout/sessions",
      body: {
        mode: "payment",
        line_items: [{ price: "price_1", quantity: 2 }],
        metadata: { pwv_reference: "ref 1" },
      },
      idempotencyKey: "idem-stripe-1",
    });

    expect(res.id).toBe("cs_test_1");
    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.headers.get("authorization")).toBe("Bearer sk_test_x");
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("stripe-account")).toBe("acct_42");
    expect(req.headers.get("idempotency-key")).toBe("idem-stripe-1");

    const raw = await req.text();
    // Acceptance: bracket-notation form body, and no JSON
    // body ever leaves the Stripe client.
    expect(raw).toBe(
      "mode=payment&line_items[0][price]=price_1&line_items[0][quantity]=2" +
        "&metadata[pwv_reference]=ref%201",
    );
    expect(raw.includes("{")).toBe(false);
    // The form body round-trips through a standard urlencoded parser.
    const parsed = new URLSearchParams(raw);
    expect(parsed.get("line_items[0][quantity]")).toBe("2");
    expect(parsed.get("metadata[pwv_reference]")).toBe("ref 1");
  });
});
