import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { STRIPE_API_VERSION } from "../../src/core/config";
import {
  PayweaveNotFoundError,
  PayweaveValidationError,
} from "../../src/core/errors";
import { makeStripe, TEST_SECRET_KEY, type StripeHarness } from "./_harness";

let h: StripeHarness;
afterEach(() => h?.close());

describe("checkout.sessions.create", () => {
  it("POSTs bracket-notation form data with auth + version headers — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/checkout/sessions",
        json: loadFixture("stripe", "checkout-sessions", "create.success"),
      },
    ]);

    const session = await h.client.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: 2000, // $20.00 in minor units, unchanged
            product_data: { name: "T-shirt" },
          },
          quantity: 2,
        },
      ],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
      client_reference_id: "pwv_ref_001",
      metadata: { pwv_reference: "pwv_ref_001" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/checkout/sessions");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.headers.get("accept")).toContain("application/json");

    // §6 acceptance criterion: nested metadata + line_items array reach the
    // wire as bracket-notation form pairs — and the body is not JSON.
    expect(req.rawBody).toBe(
      "mode=payment" +
        "&line_items[0][price_data][currency]=usd" +
        "&line_items[0][price_data][unit_amount]=2000" +
        "&line_items[0][price_data][product_data][name]=T-shirt" +
        "&line_items[0][quantity]=2" +
        "&success_url=https%3A%2F%2Fexample.com%2Fsuccess" +
        "&cancel_url=https%3A%2F%2Fexample.com%2Fcancel" +
        "&client_reference_id=pwv_ref_001" +
        "&metadata[pwv_reference]=pwv_ref_001",
    );
    expect(req.rawBody.includes("{")).toBe(false);
    expect(req.form.get("line_items[0][price_data][unit_amount]")).toBe("2000");
    expect(req.form.get("metadata[pwv_reference]")).toBe("pwv_ref_001");

    // Bare resource — no envelope unwrapping.
    expect(session.id).toBe("cs_test_pwv_fixture_0000000000000001");
    expect(session.url).toContain("checkout.stripe.com");
    expect(session.status).toBe("open");
    expect(session.payment_status).toBe("unpaid");
    expect(session.amount_total).toBe(4000);
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/checkout/sessions",
        json: loadFixture("stripe", "checkout-sessions", "create.success"),
      },
    ]);

    await h.client.checkout.sessions.create(
      { mode: "payment", line_items: [{ price: "price_pwv_fixture_001", quantity: 1 }] },
      { idempotencyKey: "order-8123-checkout" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("order-8123-checkout");
  });

  it("omits the Idempotency-Key header when no key is given", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/checkout/sessions",
        json: loadFixture("stripe", "checkout-sessions", "create.success"),
      },
    ]);
    await h.client.checkout.sessions.create({ mode: "payment" });
    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBeNull();
  });

  it("throws PayweaveValidationError before sending on a bad mode", async () => {
    h = await makeStripe([]);
    await expect(
      // @ts-expect-error — intentionally invalid input
      h.client.checkout.sessions.create({ mode: "instant" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });

  it("rejects a non-integer unit_amount before sending (minor units rule)", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.checkout.sessions.create({
        mode: "payment",
        line_items: [
          { price_data: { currency: "usd", unit_amount: 19.99 }, quantity: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("checkout.sessions.retrieve", () => {
  it("GETs /v1/checkout/sessions/{id} and tolerates url: null", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/checkout/sessions/:id",
        json: loadFixture("stripe", "checkout-sessions", "retrieve.success"),
      },
    ]);

    const session = await h.client.checkout.sessions.retrieve(
      "cs_test_pwv_fixture_0000000000000001",
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/checkout/sessions/cs_test_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    // A completed session has url: null — parsed, never thrown.
    expect(session.url).toBeNull();
    expect(session.payment_status).toBe("paid");
    expect(session.status).toBe("complete");
    expect(session.payment_intent).toBe("pi_pwv_fixture_0000000000000001");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.checkout.sessions.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });

  it("maps a 404 Stripe error envelope to PayweaveNotFoundError with the provider message", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/checkout/sessions/:id",
        status: 404,
        json: loadFixture("stripe", "checkout-sessions", "not_found.error"),
        headers: { "Request-Id": "req_pwv_fixture_1" },
      },
    ]);

    const err = await h.client.checkout.sessions
      .retrieve("cs_test_pwv_missing")
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PayweaveNotFoundError);
    const notFound = err as PayweaveNotFoundError;
    expect(notFound.provider).toBe("stripe");
    expect(notFound.httpStatus).toBe(404);
    expect(notFound.providerCode).toBe("resource_missing");
    expect(notFound.providerMessage).toBe("No such checkout.session: 'cs_test_pwv_missing'");
    expect(notFound.message).toContain("No such checkout.session");
    expect(notFound.requestId).toBe("req_pwv_fixture_1");
  });
});

describe("checkout.sessions.list + iterate", () => {
  it("GETs /v1/checkout/sessions with flattened bracket query filters", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/checkout/sessions",
        json: loadFixture("stripe", "checkout-sessions", "list.page1"),
      },
    ]);

    const page = await h.client.checkout.sessions.list({
      limit: 2,
      status: "complete",
      created: { gte: 1751900000 },
      customer_details: { email: "buyer@example.com" },
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/checkout/sessions");
    expect(req.search.get("limit")).toBe("2");
    expect(req.search.get("status")).toBe("complete");
    expect(req.search.get("created[gte]")).toBe("1751900000");
    expect(req.search.get("customer_details[email]")).toBe("buyer@example.com");
    expect(page.object).toBe("list");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
    expect(page.data[0]!.id).toBe("cs_test_pwv_fixture_0000000000000001");
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "checkout-sessions", "list.page1");
    const page2 = loadFixture("stripe", "checkout-sessions", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/checkout/sessions", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const session of h.client.checkout.sessions.iterate({ limit: 2 })) {
      ids.push(session.id);
    }

    expect(ids).toEqual([
      "cs_test_pwv_fixture_0000000000000001",
      "cs_test_pwv_fixture_0000000000000002",
      "cs_test_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    // Page 1: no cursor. Page 2: cursor = last id of page 1. Terminates on
    // has_more: false.
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "cs_test_pwv_fixture_0000000000000002",
    );
    expect(reqs[1]!.search.get("limit")).toBe("2");
  });
});

describe("checkout.sessions.expire", () => {
  it("POSTs /v1/checkout/sessions/{id}/expire with no body", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/checkout/sessions/:id/expire",
        json: loadFixture("stripe", "checkout-sessions", "expire.success"),
      },
    ]);

    const session = await h.client.checkout.sessions.expire(
      "cs_test_pwv_fixture_0000000000000002",
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe(
      "/v1/checkout/sessions/cs_test_pwv_fixture_0000000000000002/expire",
    );
    expect(req.rawBody).toBe("");
    expect(session.status).toBe("expired");
    expect(session.url).toBeNull();
  });

  it("maps a 400 for a non-open session to PayweaveValidationError", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/checkout/sessions/:id/expire",
        status: 400,
        json: {
          error: {
            message: "This Checkout Session cannot be expired because it is not open.",
            type: "invalid_request_error",
          },
        },
      },
    ]);

    const err = await h.client.checkout.sessions
      .expire("cs_test_pwv_fixture_0000000000000001")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as PayweaveValidationError).providerMessage).toContain(
      "cannot be expired",
    );
    // No `code` on this envelope — providerCode falls back to `type`.
    expect((err as PayweaveValidationError).providerCode).toBe("invalid_request_error");
  });
});

describe("checkout.sessions.lineItems + iterateLineItems", () => {
  it("GETs /v1/checkout/sessions/{id}/line_items with cursor query", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/checkout/sessions/:id/line_items",
        json: loadFixture("stripe", "checkout-sessions", "line_items.page1"),
      },
    ]);

    const items = await h.client.checkout.sessions.lineItems(
      "cs_test_pwv_fixture_0000000000000001",
      { limit: 20 },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe(
      "/v1/checkout/sessions/cs_test_pwv_fixture_0000000000000001/line_items",
    );
    expect(req.search.get("limit")).toBe("20");
    expect(items.data[0]!.id).toBe("li_pwv_fixture_0000000000000001");
    expect(items.data[0]!.amount_total).toBe(4000);
    expect(items.data[0]!.quantity).toBe(2);
  });

  it("iterateLineItems() pages line items via has_more/starting_after", async () => {
    const page1 = loadFixture("stripe", "checkout-sessions", "line_items.page1");
    const page2 = loadFixture("stripe", "checkout-sessions", "line_items.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get(
        "https://api.stripe.com/v1/checkout/sessions/:id/line_items",
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("starting_after");
          return HttpResponse.json(
            (cursor === null ? page1 : page2) as Record<string, unknown>,
          );
        },
      ),
    );

    const ids: string[] = [];
    for await (const item of h.client.checkout.sessions.iterateLineItems(
      "cs_test_pwv_fixture_0000000000000001",
    )) {
      ids.push(item.id);
    }

    expect(ids).toEqual([
      "li_pwv_fixture_0000000000000001",
      "li_pwv_fixture_0000000000000002",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!.search.get("starting_after")).toBe("li_pwv_fixture_0000000000000001");
  });
});
