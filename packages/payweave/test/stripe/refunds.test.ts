import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { STRIPE_API_VERSION } from "../../src/core/config";
import { PayweaveValidationError } from "../../src/core/errors";
import { makeStripe, TEST_SECRET_KEY, type StripeHarness } from "./_harness";

let h: StripeHarness;
afterEach(() => h?.close());

describe("refunds.create", () => {
  it("POSTs bracket-notation form data against the payment intent — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/refunds",
        json: loadFixture("stripe", "refunds", "create.success"),
      },
    ]);

    const re = await h.client.refunds.create({
      payment_intent: "pi_pwv_fixture_0000000000000001",
      amount: 500, // partial refund in minor units, unchanged
      reason: "requested_by_customer",
      metadata: { order_id: "8123" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/refunds");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    // Bracket-notation form body — amount reaches Stripe in minor units,
    // nested dictionaries as bracket pairs, no JSON.
    expect(req.rawBody).toBe(
      "amount=500&payment_intent=pi_pwv_fixture_0000000000000001" +
        "&reason=requested_by_customer&metadata[order_id]=8123",
    );
    expect(req.rawBody.includes("{")).toBe(false);
    expect(req.form.get("payment_intent")).toBe("pi_pwv_fixture_0000000000000001");
    expect(req.form.get("metadata[order_id]")).toBe("8123");

    // Bare resource — no envelope unwrapping.
    expect(re.id).toBe("re_pwv_fixture_0000000000000001");
    expect(re.status).toBe("succeeded");
    expect(re.amount).toBe(500);
    expect(re.payment_intent).toBe("pi_pwv_fixture_0000000000000001");
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/refunds",
        json: loadFixture("stripe", "refunds", "create.success"),
      },
    ]);

    await h.client.refunds.create(
      { payment_intent: "pi_pwv_fixture_0000000000000001" },
      { idempotencyKey: "order-8123-refund" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("order-8123-refund");
    // Full-amount refund: no amount pair leaves the client.
    expect(req.rawBody).toBe("payment_intent=pi_pwv_fixture_0000000000000001");
  });

  it("rejects an untargeted refund (no charge/payment_intent/origin) before sending", async () => {
    h = await makeStripe([]);
    const err = await h.client.refunds
      .create({ amount: 500 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as PayweaveValidationError).message).toContain(
      "one of charge, payment_intent, or origin is required",
    );
    expect(await h.requests()).toHaveLength(0);
  });

  it("rejects a non-integer amount before sending (minor units rule)", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.refunds.create({ payment_intent: "pi_x", amount: 4.99 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });

  it("maps the already-refunded 400 envelope to PayweaveValidationError with providerCode", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/refunds",
        status: 400,
        json: loadFixture("stripe", "refunds", "already_refunded.error"),
      },
    ]);

    const err = await h.client.refunds
      .create({ charge: "ch_pwv_fixture_0000000000000001" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PayweaveValidationError);
    const validation = err as PayweaveValidationError;
    expect(validation.provider).toBe("stripe");
    expect(validation.httpStatus).toBe(400);
    expect(validation.providerCode).toBe("charge_already_refunded");
    expect(validation.providerMessage).toBe(
      "Charge ch_pwv_fixture_0000000000000001 has already been refunded.",
    );
  });
});

describe("refunds.retrieve", () => {
  it("GETs /v1/refunds/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/refunds/:id",
        json: loadFixture("stripe", "refunds", "retrieve.success"),
      },
    ]);

    const re = await h.client.refunds.retrieve("re_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/refunds/re_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(re.status).toBe("succeeded");
    expect(re.charge).toBe("ch_pwv_fixture_0000000000000001");
    // Conservative-untyped child shape passes through the loose schema.
    expect(re.destination_details).toMatchObject({ type: "card" });
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.refunds.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("refunds.update", () => {
  it("POSTs metadata (the only updatable field) to /v1/refunds/{id}", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/refunds/:id",
        json: loadFixture("stripe", "refunds", "update.success"),
      },
    ]);

    const re = await h.client.refunds.update("re_pwv_fixture_0000000000000001", {
      metadata: { order_id: "6735" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/refunds/re_pwv_fixture_0000000000000001");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.rawBody).toBe("metadata[order_id]=6735");
    expect(re.metadata).toEqual({ order_id: "6735" });
  });

  it("sends NO body when updating with no params", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/refunds/:id",
        json: loadFixture("stripe", "refunds", "update.success"),
      },
    ]);

    await h.client.refunds.update("re_pwv_fixture_0000000000000001");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });
});

describe("refunds.cancel", () => {
  it("POSTs to /v1/refunds/{id}/cancel with no body (requires_action-only per docs)", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/refunds/:id/cancel",
        json: loadFixture("stripe", "refunds", "cancel.success"),
      },
    ]);

    const re = await h.client.refunds.cancel("re_pwv_fixture_0000000000000002");

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/refunds/re_pwv_fixture_0000000000000002/cancel");
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
    expect(re.status).toBe("canceled");
  });
});

describe("refunds.list + iterate", () => {
  it("GETs /v1/refunds with charge/payment_intent filters and flattened created range", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/refunds",
        json: loadFixture("stripe", "refunds", "list.page1"),
      },
    ]);

    const page = await h.client.refunds.list({
      charge: "ch_pwv_fixture_0000000000000001",
      payment_intent: "pi_pwv_fixture_0000000000000001",
      limit: 2,
      created: { gte: 1751900000, lt: 1752000000 },
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/refunds");
    expect(req.search.get("charge")).toBe("ch_pwv_fixture_0000000000000001");
    expect(req.search.get("payment_intent")).toBe("pi_pwv_fixture_0000000000000001");
    expect(req.search.get("limit")).toBe("2");
    expect(req.search.get("created[gte]")).toBe("1751900000");
    expect(req.search.get("created[lt]")).toBe("1752000000");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "refunds", "list.page1");
    const page2 = loadFixture("stripe", "refunds", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/refunds", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const re of h.client.refunds.iterate()) {
      ids.push(re.id);
    }

    expect(ids).toEqual([
      "re_pwv_fixture_0000000000000001",
      "re_pwv_fixture_0000000000000002",
      "re_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "re_pwv_fixture_0000000000000002",
    );
  });
});
