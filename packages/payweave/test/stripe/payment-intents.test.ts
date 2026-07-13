import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { STRIPE_API_VERSION } from "../../src/core/config";
import {
  PayweaveAuthError,
  PayweaveProviderError,
  PayweaveRateLimitError,
  PayweaveValidationError,
} from "../../src/core/errors";
import { makeStripe, TEST_SECRET_KEY, type StripeHarness } from "./_harness";

let h: StripeHarness;
afterEach(() => h?.close());

describe("paymentIntents.create", () => {
  it("POSTs bracket-notation form data with auth + version headers — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents",
        json: loadFixture("stripe", "payment-intents", "create.success"),
      },
    ]);

    const pi = await h.client.paymentIntents.create({
      amount: 2000, // $20.00 in minor units, unchanged
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: { order_id: "8123" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/payment_intents");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    // Bracket-notation form body — amount reaches Stripe in minor units,
    // nested dictionaries as bracket pairs, no JSON.
    expect(req.rawBody).toBe(
      "amount=2000&currency=usd&automatic_payment_methods[enabled]=true" +
        "&metadata[order_id]=8123",
    );
    expect(req.rawBody.includes("{")).toBe(false);
    expect(req.form.get("amount")).toBe("2000");
    expect(req.form.get("automatic_payment_methods[enabled]")).toBe("true");

    // Bare resource — no envelope unwrapping.
    expect(pi.id).toBe("pi_pwv_fixture_0000000000000001");
    expect(pi.status).toBe("requires_payment_method");
    expect(pi.amount).toBe(2000);
    expect(pi.client_secret).toContain("_secret_");
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents",
        json: loadFixture("stripe", "payment-intents", "create.success"),
      },
    ]);

    await h.client.paymentIntents.create(
      { amount: 2000, currency: "usd" },
      { idempotencyKey: "order-8123-intent" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("order-8123-intent");
  });

  it("rejects a non-integer amount before sending (minor units rule)", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.paymentIntents.create({ amount: 19.99, currency: "usd" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });

  it("maps a 402 card_error envelope to a non-retryable PayweaveProviderError with providerCode", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents",
        status: 402,
        json: loadFixture("stripe", "payment-intents", "card_declined.error"),
      },
    ]);

    const err = await h.client.paymentIntents
      .create({ amount: 2000, currency: "usd", confirm: true, payment_method: "pm_x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PayweaveProviderError);
    const provider = err as PayweaveProviderError;
    expect(provider.provider).toBe("stripe");
    expect(provider.httpStatus).toBe(402);
    // `code` wins over `type` — the granular decline code surfaces.
    expect(provider.providerCode).toBe("card_declined");
    expect(provider.providerMessage).toBe("Your card was declined.");
    expect(provider.message).toContain("Your card was declined.");
    // Golden rule: a failed charge is NEVER silently re-sent.
    expect(provider.isRetryable).toBe(false);
  });

  it("maps a 401 Stripe error envelope to PayweaveAuthError", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents",
        status: 401,
        json: {
          error: {
            message: "Invalid API Key provided: sk_test_********har",
            type: "invalid_request_error",
          },
        },
      },
    ]);

    const err = await h.client.paymentIntents
      .create({ amount: 2000, currency: "usd" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveAuthError);
    expect((err as PayweaveAuthError).providerMessage).toContain("Invalid API Key");
  });

  it("maps a 429 to PayweaveRateLimitError with retryAfterMs from Retry-After", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents",
        status: 429,
        json: { error: { message: "Request rate limit exceeded" } },
        headers: { "Retry-After": "2" },
      },
    ]);

    const err = await h.client.paymentIntents
      .create({ amount: 2000, currency: "usd" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveRateLimitError);
    const rate = err as PayweaveRateLimitError;
    expect(rate.retryAfterMs).toBe(2000);
    expect(rate.providerMessage).toBe("Request rate limit exceeded");
  });
});

describe("paymentIntents.retrieve", () => {
  it("GETs /v1/payment_intents/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/payment_intents/:id",
        json: loadFixture("stripe", "payment-intents", "retrieve.success"),
      },
    ]);

    const pi = await h.client.paymentIntents.retrieve("pi_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/payment_intents/pi_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(pi.status).toBe("succeeded");
    expect(pi.amount_received).toBe(2000);
    expect(pi.latest_charge).toBe("ch_pwv_fixture_0000000000000001");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.paymentIntents.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("paymentIntents.confirm", () => {
  it("POSTs form params to /v1/payment_intents/{id}/confirm with idempotencyKey", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents/:id/confirm",
        json: loadFixture("stripe", "payment-intents", "confirm.success"),
      },
    ]);

    const pi = await h.client.paymentIntents.confirm(
      "pi_pwv_fixture_0000000000000002",
      { payment_method: "pm_pwv_fixture_001", return_url: "https://example.com/return" },
      { idempotencyKey: "order-8123-confirm" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/payment_intents/pi_pwv_fixture_0000000000000002/confirm");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.headers.get("idempotency-key")).toBe("order-8123-confirm");
    expect(req.rawBody).toBe(
      "payment_method=pm_pwv_fixture_001&return_url=https%3A%2F%2Fexample.com%2Freturn",
    );
    expect(pi.status).toBe("succeeded");
  });

  it("sends NO body when confirming with no params", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents/:id/confirm",
        json: loadFixture("stripe", "payment-intents", "confirm.success"),
      },
    ]);

    await h.client.paymentIntents.confirm("pi_pwv_fixture_0000000000000002");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });
});

describe("paymentIntents.capture", () => {
  it("POSTs amount_to_capture (minor units) to /v1/payment_intents/{id}/capture", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents/:id/capture",
        json: loadFixture("stripe", "payment-intents", "capture.success"),
      },
    ]);

    const pi = await h.client.paymentIntents.capture(
      "pi_pwv_fixture_0000000000000003",
      { amount_to_capture: 1500 },
      { idempotencyKey: "order-8123-capture" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/payment_intents/pi_pwv_fixture_0000000000000003/capture");
    expect(req.headers.get("idempotency-key")).toBe("order-8123-capture");
    expect(req.rawBody).toBe("amount_to_capture=1500");
    expect(pi.status).toBe("succeeded");
    expect(pi.amount_received).toBe(1500);
  });

  it("maps a 400 for a non-capturable intent to PayweaveValidationError", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents/:id/capture",
        status: 400,
        json: {
          error: {
            code: "payment_intent_unexpected_state",
            message:
              "This PaymentIntent could not be captured because it has a status of canceled.",
            type: "invalid_request_error",
          },
        },
      },
    ]);

    const err = await h.client.paymentIntents
      .capture("pi_pwv_fixture_0000000000000004")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as PayweaveValidationError).providerCode).toBe(
      "payment_intent_unexpected_state",
    );
  });
});

describe("paymentIntents.cancel", () => {
  it("POSTs cancellation_reason to /v1/payment_intents/{id}/cancel", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/payment_intents/:id/cancel",
        json: loadFixture("stripe", "payment-intents", "cancel.success"),
      },
    ]);

    const pi = await h.client.paymentIntents.cancel("pi_pwv_fixture_0000000000000004", {
      cancellation_reason: "requested_by_customer",
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/payment_intents/pi_pwv_fixture_0000000000000004/cancel");
    expect(req.rawBody).toBe("cancellation_reason=requested_by_customer");
    expect(pi.status).toBe("canceled");
    expect(pi.cancellation_reason).toBe("requested_by_customer");
  });

  it("rejects an unknown cancellation_reason before sending", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.paymentIntents.cancel("pi_x", {
        // @ts-expect-error — intentionally invalid input
        cancellation_reason: "changed_my_mind",
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("paymentIntents.list + iterate", () => {
  it("GETs /v1/payment_intents with flattened created range", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/payment_intents",
        json: loadFixture("stripe", "payment-intents", "list.page1"),
      },
    ]);

    const page = await h.client.paymentIntents.list({
      customer: "cus_pwv_fixture_001",
      limit: 2,
      created: { gte: 1751900000, lt: 1752000000 },
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/payment_intents");
    expect(req.search.get("customer")).toBe("cus_pwv_fixture_001");
    expect(req.search.get("limit")).toBe("2");
    expect(req.search.get("created[gte]")).toBe("1751900000");
    expect(req.search.get("created[lt]")).toBe("1752000000");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "payment-intents", "list.page1");
    const page2 = loadFixture("stripe", "payment-intents", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/payment_intents", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const pi of h.client.paymentIntents.iterate()) {
      ids.push(pi.id);
    }

    expect(ids).toEqual([
      "pi_pwv_fixture_0000000000000001",
      "pi_pwv_fixture_0000000000000002",
      "pi_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "pi_pwv_fixture_0000000000000002",
    );
  });
});
