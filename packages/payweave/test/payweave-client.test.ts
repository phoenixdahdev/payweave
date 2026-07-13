/**
 * PW-502 — `createPayweave` + `PayweaveClient` runtime behavior
 * (unified-config.md §3, §9 criterion 1). Network calls are mocked at the edge
 * with MSW (never stubbing HttpClient/fetch); webhook vectors come from
 * `signWebhook`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SetupServer } from "msw/node";
import {
  createPayweave,
  PaystackClient,
  FlutterwaveClient,
  StripeClient,
} from "../src/index";
import {
  PayweaveError,
  PayweaveConfigError,
  PayweaveValidationError,
  PayweaveWebhookVerificationError,
} from "../src/core/errors";
import { createMswServer, type MockRoute } from "../src/testing/msw";
import { loadFixture } from "../src/testing/fixtures";
import { signWebhook } from "../src/testing/sign-webhook";

/** A captured outgoing request (parsed for assertions). */
interface CapturedRequest {
  method: string;
  path: string;
  host: string;
  body: unknown;
}

interface EdgeHarness {
  server: SetupServer;
  requests: () => Promise<CapturedRequest[]>;
  close: () => void;
}

/**
 * Start MSW BEFORE the client is constructed — HttpClient captures the global
 * fetch at construction time and MSW patches it on `listen()` (same ordering
 * rule as the unified/_harness).
 */
async function startEdge(routes: MockRoute[]): Promise<EdgeHarness> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

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
    return { method: req.method, path: url.pathname, host: url.host, body };
  }

  return {
    server,
    requests: () => Promise.all(raw.map(parse)),
    close: () => server.close(),
  };
}

let edge: EdgeHarness | undefined;
afterEach(() => {
  edge?.close();
  edge = undefined;
});

describe("createPayweave — construction (§3)", () => {
  it("paystack-only: root props + Surface A namespace, others absent at runtime", () => {
    const client = createPayweave({ paystack: { secretKey: "sk_test_x" } });
    expect(client.providers).toEqual(["paystack"]);
    expect(client.defaultProvider).toBe("paystack");
    expect(client.environment).toBe("test");
    expect(client.paystack).toBeInstanceOf(PaystackClient);
    // §4 assertion 1's runtime half — unconfigured namespaces do not exist.
    expect("stripe" in client).toBe(false);
    expect("flutterwave" in client).toBe(false);
  });

  it("flutterwave v3 (default): mounts the v3 surface", () => {
    const client = createPayweave({ flutterwave: { secretKey: "FLWSECK_TEST-x" } });
    expect(client.providers).toEqual(["flutterwave"]);
    expect(client.flutterwave).toBeInstanceOf(FlutterwaveClient);
    expect(client.flutterwave.version).toBe("v3");
    expect(client.flutterwave.payments).toBeDefined();
    expect("paystack" in client).toBe(false);
  });

  it("flutterwave v4: mounts the v4 surface (explicit env, default test)", () => {
    const client = createPayweave({
      flutterwave: { version: "v4", clientId: "id", clientSecret: "s" },
    });
    expect(client.environment).toBe("test");
    expect(client.flutterwave.version).toBe("v4");
    expect(client.flutterwave.http).toBeDefined();
  });

  it("paystack + flutterwave: canonical provider order and explicit default", () => {
    const client = createPayweave({
      paystack: { secretKey: "sk_test_x" },
      flutterwave: { secretKey: "FLWSECK_TEST-y" },
      defaultProvider: "flutterwave",
    });
    expect(client.providers).toEqual(["paystack", "flutterwave"]);
    expect(client.defaultProvider).toBe("flutterwave");
    expect(client.paystack).toBeInstanceOf(PaystackClient);
    expect(client.flutterwave).toBeInstanceOf(FlutterwaveClient);
  });

  it("stripe-only constructs per §9 criterion 1", () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_x" } });
    expect(client.environment).toBe("test");
    expect(client.defaultProvider).toBe("stripe");
    expect(client.providers).toEqual(["stripe"]);
    expect(client.stripe).toBeInstanceOf(StripeClient);
    expect(client.stripe.http).toBeDefined();
    // `payweave.paystack` is a runtime absence (the compile-time half is in
    // payweave-client.test-d.ts).
    expect("paystack" in client).toBe(false);
    expect(Object.getOwnPropertyDescriptor(client, "paystack")).toBeUndefined();
  });

  it("returns a frozen (readonly) client", () => {
    const client = createPayweave({ paystack: { secretKey: "sk_test_x" } });
    expect(Object.isFrozen(client)).toBe(true);
  });

  it("surfaces resolver errors unchanged (rules 2–4 live in core/config)", () => {
    expect(() => createPayweave({})).toThrow(PayweaveConfigError);
    expect(() =>
      createPayweave({
        paystack: { secretKey: "sk_test_x" },
        flutterwave: { secretKey: "FLWSECK_TEST-y" },
      }),
    ).toThrow(/defaultProvider/);
    expect(() =>
      createPayweave({
        paystack: { secretKey: "sk_live_x" },
        flutterwave: { secretKey: "FLWSECK_TEST-y" },
        defaultProvider: "paystack",
      }),
    ).toThrow(/mixed environments/);
  });
});

describe("createPayweave — unified ops on the client root (§3)", () => {
  it("routes to the defaultProvider and returns the normalized result", async () => {
    edge = await startEdge([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ]);
    const client = createPayweave({ paystack: { secretKey: "sk_test_x", maxRetries: 0 } });

    const res = await client.checkout.create({
      amount: { value: 500000, currency: "NGN" },
      customer: { email: "ada@example.com" },
      reference: "order_1",
    });

    const [req] = await edge.requests();
    expect(req?.method).toBe("POST");
    expect(req?.host).toBe("api.paystack.co");
    expect(req?.path).toBe("/transaction/initialize");
    const body = req?.body as Record<string, unknown>;
    expect(body.amount).toBe(500000);
    // The absent per-call override must never leak into the outgoing body.
    expect("provider" in body).toBe(false);
    expect(res.checkoutUrl).toBe("https://checkout.paystack.com/abc123def");
    expect(res.reference).toBe("order_1");
  });

  it("per-call provider override routes past the default (and is stripped)", async () => {
    edge = await startEdge([
      {
        method: "get",
        url: "https://api.paystack.co/bank",
        json: loadFixture("paystack", "misc", "banks.success"),
      },
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/banks/:country",
        json: loadFixture("flutterwave", "banks", "list.success"),
      },
    ]);
    const client = createPayweave({
      paystack: { secretKey: "sk_test_x", maxRetries: 0 },
      flutterwave: { secretKey: "FLWSECK_TEST-y", maxRetries: 0 },
      defaultProvider: "paystack",
    });

    const viaDefault = await client.banks.list({ country: "nigeria" });
    const viaOverride = await client.banks.list({ country: "NG", provider: "flutterwave" });

    const [first, second] = await edge.requests();
    expect(first?.host).toBe("api.paystack.co");
    expect(first?.path).toBe("/bank");
    expect(second?.host).toBe("api.flutterwave.com");
    expect(second?.path).toBe("/v3/banks/NG");
    expect(viaDefault[0]?.code).toBe("011");
    expect(viaOverride[0]?.code).toBe("044");
  });

  it("throws PayweaveConfigError for a dynamic override to an unconfigured provider", () => {
    const client = createPayweave({ paystack: { secretKey: "sk_test_x" } });
    expect(() =>
      client.verify({ reference: "ref_1", provider: "flutterwave" as never }),
    ).toThrow(PayweaveConfigError);
    expect(() =>
      client.verify({ reference: "ref_1", provider: "flutterwave" as never }),
    ).toThrow(/not configured on this client/);
  });

  it("`payweave.unified` is a deprecated alias for the SAME root functions", async () => {
    const client = createPayweave({ paystack: { secretKey: "sk_test_x", maxRetries: 0 } });
    expect(client.unified.checkout).toBe(client.checkout);
    expect(client.unified.verify).toBe(client.verify);
    expect(client.unified.refunds).toBe(client.refunds);
    expect(client.unified.transfers).toBe(client.transfers);
    expect(client.unified.banks).toBe(client.banks);

    edge = await startEdge([
      {
        method: "get",
        url: "https://api.paystack.co/bank",
        json: loadFixture("paystack", "misc", "banks.success"),
      },
    ]);
    // Alias behaves identically because it IS the same function… but prove the
    // call path works end-to-end through a fresh client that saw MSW's fetch.
    const fresh = createPayweave({ paystack: { secretKey: "sk_test_x", maxRetries: 0 } });
    const banks = await fresh.unified.banks.list({ country: "nigeria" });
    expect(banks).toHaveLength(2);
  });

  it("unified ops routed to stripe: capability-supported-but-unimplemented ops reject (PW-607)", async () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_x" } });
    // checkout.create/verify/refunds.create ARE capability-supported on stripe
    // (providers.md §3.3) but `src/unified/stripe.ts` hasn't landed yet — an
    // honest "not implemented" rejection, distinct from a capability gap.
    const err = await client.verify({ reference: "ref_1" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PayweaveError);
    expect((err as PayweaveError).provider).toBe("stripe");
    expect((err as Error).message).toMatch(/not implemented yet/);
    await expect(
      client.checkout.create({
        amount: { value: 1000, currency: "USD" },
        customer: { email: "ada@example.com" },
      }),
    ).rejects.toThrow(/not implemented yet/);
    await expect(client.refunds.create({ reference: "ref_1" })).rejects.toThrow(
      /not implemented yet/,
    );
  });

  it("unified ops routed to stripe: transfers.create/banks.* throw the typed capability error (PW-607, providers.md §3.3)", () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_x" } });
    // A capability gap fails BEFORE any request would be sent — synchronously,
    // same precedent as `routeTo`'s "not configured" check above.
    expect(() =>
      client.transfers.create({
        amount: 1000,
        currency: "USD",
        recipient: { accountNumber: "000123456", bankCode: "001" },
      }),
    ).toThrow(PayweaveValidationError);
    expect(() =>
      client.transfers.create({
        amount: 1000,
        currency: "USD",
        recipient: { accountNumber: "000123456", bankCode: "001" },
      }),
    ).toThrow(/transfers are not supported on stripe/);
    expect(() => client.banks.list({ country: "US" })).toThrow(PayweaveValidationError);
    expect(() => client.banks.list({ country: "US" })).toThrow(/banks\.list is not supported on stripe/);
    expect(() =>
      client.banks.resolveAccount({ accountNumber: "000123456", bankCode: "001" }),
    ).toThrow(/banks\.resolveAccount is not supported on stripe/);
    // `payweave.unified` is the SAME functions (§3) — the guard applies there too.
    expect(() =>
      client.unified.transfers.create({
        amount: 1000,
        currency: "USD",
        recipient: { accountNumber: "000123456", bankCode: "001" },
      }),
    ).toThrow(/transfers are not supported on stripe/);
  });

  it("`payweave.capabilities()` returns the matrix for configured providers only", () => {
    const client = createPayweave({
      stripe: { secretKey: "sk_test_x" },
      paystack: { secretKey: "sk_test_y" },
      defaultProvider: "paystack",
    });
    const all = client.capabilities();
    expect(Object.keys(all).sort()).toEqual(["paystack", "stripe"]);
    expect(all.stripe?.["transfers.create"]).toEqual({
      supported: false,
      reason: "transfers are not supported on stripe",
    });
    expect(all.paystack?.["transfers.create"]).toEqual({ supported: true });

    const stripeOnly = client.capabilities("stripe");
    expect(stripeOnly["checkout.create"]).toEqual({ supported: true });
    expect(stripeOnly["banks.list"].supported).toBe(false);

    expect(() => client.capabilities("flutterwave" as never)).toThrow(PayweaveConfigError);
    expect(() => client.capabilities("flutterwave" as never)).toThrow(
      /not configured on this client/,
    );
  });
});

describe("createPayweave — Surface A smoke through the mounted namespaces", () => {
  it("payweave.paystack.transactions.initialize hits Paystack unchanged", async () => {
    edge = await startEdge([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ]);
    const client = createPayweave({ paystack: { secretKey: "sk_test_x", maxRetries: 0 } });

    const res = await client.paystack.transactions.initialize({
      email: "buyer@example.com",
      amount: 500000,
    });

    const [req] = await edge.requests();
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/transaction/initialize");
    expect((req?.body as Record<string, unknown>).amount).toBe(500000);
    expect(res.data.authorization_url).toBe("https://checkout.paystack.com/abc123def");
  });

  it("payweave.flutterwave.payments.create hits Flutterwave v3 unchanged", async () => {
    edge = await startEdge([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/payments",
        json: loadFixture("flutterwave", "payments", "create.success"),
      },
    ]);
    const client = createPayweave({
      flutterwave: { secretKey: "FLWSECK_TEST-x", maxRetries: 0 },
    });

    const res = await client.flutterwave.payments.create({
      tx_ref: "pwv_tx_001",
      amount: 5000,
      currency: "NGN",
      redirect_url: "https://example.com/cb",
      customer: { email: "buyer@example.com" },
    });

    const [req] = await edge.requests();
    expect(req?.method).toBe("POST");
    expect(req?.host).toBe("api.flutterwave.com");
    expect(req?.path).toBe("/v3/payments");
    expect(res.data?.link).toBe(
      "https://checkout.flutterwave.com/v3/hosted/pay/pwv_test_link_001",
    );
  });
});

describe("createPayweave — webhooks (multi-provider header dispatch, §5 / PW-503)", () => {
  it("keeps byte-identical single-provider behavior for a paystack-only client's own header", () => {
    const secret = "sk_test_hook";
    const client = createPayweave({ paystack: { secretKey: secret } });
    const signed = signWebhook("paystack", { event: "charge.success", data: { id: 1 } }, secret);

    expect(
      client.webhooks.verify({ rawBody: signed.body, headers: signed.headers }),
    ).toBe(true);
    expect(
      client.webhooks.verify({ rawBody: signed.body + "x", headers: signed.headers }),
    ).toBe(false);

    const event = client.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    expect(event.provider).toBe("paystack");
    expect(event.type).toBe("charge.success");
    expect(() =>
      client.webhooks.constructEvent({ rawBody: signed.body + "x", headers: signed.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("verifies the v3 scheme for a flutterwave-only client; no known header now fails closed", () => {
    const client = createPayweave({
      flutterwave: { secretKey: "FLWSECK_TEST-x", webhookSecret: "hash_1" },
    });
    const signed = signWebhook("flutterwave", { event: "charge.completed" }, "hash_1");
    expect(
      client.webhooks.verify({ rawBody: signed.body, headers: signed.headers }),
    ).toBe(true);
    // §5: a request with NO known signature header is rejected, not "false".
    expect(() =>
      client.webhooks.verify({ rawBody: signed.body, headers: {} }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("multi-provider client routes each provider's vector to its own verifier", () => {
    const client = createPayweave({
      paystack: { secretKey: "sk_test_x" },
      flutterwave: { secretKey: "FLWSECK_TEST-y", webhookSecret: "hash_2" },
      defaultProvider: "paystack",
    });
    const ps = signWebhook("paystack", { event: "charge.success", data: { id: 7 } }, "sk_test_x");
    const flw = signWebhook(
      "flutterwave",
      { event: "charge.completed", data: { id: 9, status: "successful" } },
      "hash_2",
    );

    expect(client.webhooks.verify({ rawBody: ps.body, headers: ps.headers })).toBe(true);
    expect(
      client.webhooks.constructEvent({ rawBody: ps.body, headers: ps.headers }).provider,
    ).toBe("paystack");
    expect(client.webhooks.verify({ rawBody: flw.body, headers: flw.headers })).toBe(true);
    expect(
      client.webhooks.constructEvent({ rawBody: flw.body, headers: flw.headers }).provider,
    ).toBe("flutterwave");
    expect(() =>
      client.webhooks.verifyOrThrow({ rawBody: ps.body + "x", headers: ps.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("stripe-only client verifies stripe vectors; events flow with unifiedType 'unknown'", () => {
    const client = createPayweave({
      stripe: { secretKey: "sk_test_x", webhookSecret: "whsec_1" },
    });
    const signed = signWebhook(
      "stripe",
      { id: "evt_client_1", type: "checkout.session.completed", data: { object: {} } },
      "whsec_1",
    );
    expect(client.webhooks.verify({ rawBody: signed.body, headers: signed.headers })).toBe(true);
    const event = client.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    expect(event.provider).toBe("stripe");
    expect(event.type).toBe("checkout.session.completed");
    expect(event.unifiedType).toBe("unknown");
    expect(event.dedupeKey).toBe("evt_client_1");

    // §9 criterion 4: a Paystack-signed vector hitting this stripe-only client
    // fails closed — never falls through to another provider's verifier.
    const foreign = signWebhook("paystack", { event: "charge.success" }, "sk_test_ps");
    expect(() =>
      client.webhooks.constructEvent({ rawBody: foreign.body, headers: foreign.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});
