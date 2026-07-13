import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { STRIPE_API_VERSION } from "../../src/core/config";
import { PayweaveValidationError } from "../../src/core/errors";
import { makeStripe, TEST_SECRET_KEY, type StripeHarness } from "./_harness";

let h: StripeHarness;
afterEach(() => h?.close());

describe("subscriptionItems.create", () => {
  it("POSTs bracket-notation form data with auth + version headers — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscription_items",
        json: loadFixture("stripe", "subscription-items", "create.success"),
      },
    ]);

    const item = await h.client.subscriptionItems.create(
      {
        subscription: "sub_pwv_fixture_0000000000000001",
        price: "price_pwv_fixture_002",
        quantity: 2,
        metadata: { seat: "8" },
        proration_behavior: "create_prorations",
      },
      { idempotencyKey: "sub-001-addon" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/subscription_items");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.headers.get("idempotency-key")).toBe("sub-001-addon");

    expect(req.rawBody).toBe(
      "subscription=sub_pwv_fixture_0000000000000001&price=price_pwv_fixture_002" +
        "&quantity=2&metadata[seat]=8&proration_behavior=create_prorations",
    );
    expect(req.rawBody.includes("{")).toBe(false);
    expect(req.form.get("metadata[seat]")).toBe("8");

    // Bare resource — no envelope. Period boundaries live on the ITEM on the
    // pinned API version (PW-804/805 read them from here).
    expect(item.id).toBe("si_pwv_fixture_0000000000000003");
    expect(item.quantity).toBe(2);
    expect(item.current_period_start).toBe(1752400000);
    expect(item.current_period_end).toBe(1754978400);
  });

  it("encodes inline price_data with its required recurring dictionary", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscription_items",
        json: loadFixture("stripe", "subscription-items", "create.success"),
      },
    ]);

    await h.client.subscriptionItems.create({
      subscription: "sub_pwv_fixture_0000000000000001",
      price_data: {
        currency: "usd",
        product: "prod_pwv_fixture_002",
        recurring: { interval: "month" },
        unit_amount: 500, // integer minor units, unchanged
      },
      quantity: 1,
    });

    const req = await h.lastRequest();
    expect(req.rawBody).toBe(
      "subscription=sub_pwv_fixture_0000000000000001&price_data[currency]=usd" +
        "&price_data[product]=prod_pwv_fixture_002" +
        "&price_data[recurring][interval]=month&price_data[unit_amount]=500" +
        "&quantity=1",
    );
  });

  it("rejects a request without subscription before sending", async () => {
    h = await makeStripe([]);
    await expect(
      // @ts-expect-error — subscription is required
      h.client.subscriptionItems.create({ price: "price_pwv_fixture_002" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptionItems.retrieve", () => {
  it("GETs /v1/subscription_items/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/subscription_items/:id",
        json: loadFixture("stripe", "subscription-items", "retrieve.success"),
      },
    ]);

    const item = await h.client.subscriptionItems.retrieve(
      "si_pwv_fixture_0000000000000003",
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/subscription_items/si_pwv_fixture_0000000000000003");
    expect(req.rawBody).toBe("");
    expect(item.price?.id).toBe("price_pwv_fixture_002");
    expect(item.subscription).toBe("sub_pwv_fixture_0000000000000001");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.subscriptionItems.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptionItems.update", () => {
  it("POSTs quantity + proration params to /v1/subscription_items/{id}", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscription_items/:id",
        json: loadFixture("stripe", "subscription-items", "update.success"),
      },
    ]);

    const item = await h.client.subscriptionItems.update(
      "si_pwv_fixture_0000000000000003",
      { quantity: 5, proration_behavior: "none" },
      { idempotencyKey: "si-003-seats-5" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/subscription_items/si_pwv_fixture_0000000000000003");
    expect(req.headers.get("idempotency-key")).toBe("si-003-seats-5");
    // Proration param names copied exactly from the docs — never abstracted.
    expect(req.rawBody).toBe("quantity=5&proration_behavior=none");
    expect(item.quantity).toBe(5);
  });

  it("rejects an unknown payment_behavior before sending", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.subscriptionItems.update("si_x", {
        // @ts-expect-error — intentionally invalid input
        payment_behavior: "hope_for_the_best",
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptionItems.delete", () => {
  it("DELETEs /v1/subscription_items/{id} with optional form params", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/subscription_items/:id",
        json: loadFixture("stripe", "subscription-items", "delete.success"),
      },
    ]);

    const gone = await h.client.subscriptionItems.delete(
      "si_pwv_fixture_0000000000000003",
      { clear_usage: true, proration_behavior: "none" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/v1/subscription_items/si_pwv_fixture_0000000000000003");
    expect(req.rawBody).toBe("clear_usage=true&proration_behavior=none");
    // The deletion acknowledgement, not a full item.
    expect(gone.id).toBe("si_pwv_fixture_0000000000000003");
    expect(gone.deleted).toBe(true);
  });

  it("sends a bare DELETE when no params are given", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/subscription_items/:id",
        json: loadFixture("stripe", "subscription-items", "delete.success"),
      },
    ]);

    await h.client.subscriptionItems.delete("si_pwv_fixture_0000000000000003");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });

  it("maps a 400 last-item rejection to PayweaveValidationError with the provider message", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/subscription_items/:id",
        status: 400,
        json: loadFixture("stripe", "subscription-items", "last_item.error"),
      },
    ]);

    const err = await h.client.subscriptionItems
      .delete("si_pwv_fixture_0000000000000001")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveValidationError);
    const validation = err as PayweaveValidationError;
    expect(validation.provider).toBe("stripe");
    expect(validation.httpStatus).toBe(400);
    expect(validation.providerMessage).toContain("at least one item");
  });
});

describe("subscriptionItems.list + iterate", () => {
  it("GETs /v1/subscription_items with the required subscription filter", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/subscription_items",
        json: loadFixture("stripe", "subscription-items", "list.page1"),
      },
    ]);

    const page = await h.client.subscriptionItems.list({
      subscription: "sub_pwv_fixture_0000000000000001",
      limit: 2,
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/subscription_items");
    expect(req.rawBody).toBe("");
    expect(req.search.get("subscription")).toBe("sub_pwv_fixture_0000000000000001");
    expect(req.search.get("limit")).toBe("2");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
  });

  it("rejects list() without the required subscription id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(
      // @ts-expect-error — subscription is required by the API
      h.client.subscriptionItems.list({ limit: 10 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });

  it("iterate() follows has_more with starting_after, keeping the subscription filter", async () => {
    const page1 = loadFixture("stripe", "subscription-items", "list.page1");
    const page2 = loadFixture("stripe", "subscription-items", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/subscription_items", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const item of h.client.subscriptionItems.iterate({
      subscription: "sub_pwv_fixture_0000000000000001",
    })) {
      ids.push(item.id);
    }

    expect(ids).toEqual([
      "si_pwv_fixture_0000000000000001",
      "si_pwv_fixture_0000000000000003",
      "si_pwv_fixture_0000000000000004",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[0]!.search.get("subscription")).toBe(
      "sub_pwv_fixture_0000000000000001",
    );
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "si_pwv_fixture_0000000000000003",
    );
    expect(reqs[1]!.search.get("subscription")).toBe(
      "sub_pwv_fixture_0000000000000001",
    );
  });
});
