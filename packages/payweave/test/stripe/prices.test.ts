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

describe("prices.create", () => {
  it("POSTs bracket-notation form data with minor-unit amount + lookup_key — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/prices",
        json: loadFixture("stripe", "prices", "create.success"),
      },
    ]);

    const pr = await h.client.prices.create({
      currency: "usd",
      unit_amount: 1500, // $15.00 in minor units, unchanged
      lookup_key: "pro-monthly",
      transfer_lookup_key: true,
      metadata: { pwv_reference: "pwv_plan_pro" },
      product: "prod_pwv_fixture_0000000000000001",
      recurring: { interval: "month" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/prices");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    expect(req.rawBody).toBe(
      "currency=usd&unit_amount=1500&lookup_key=pro-monthly" +
        "&transfer_lookup_key=true&metadata[pwv_reference]=pwv_plan_pro" +
        "&product=prod_pwv_fixture_0000000000000001&recurring[interval]=month",
    );
    expect(req.form.get("unit_amount")).toBe("1500");
    expect(req.form.get("recurring[interval]")).toBe("month");

    // Bare resource — no envelope unwrapping.
    expect(pr.id).toBe("price_pwv_fixture_0000000000000001");
    expect(pr.unit_amount).toBe(1500);
    expect(pr.lookup_key).toBe("pro-monthly");
    expect(pr.recurring?.interval).toBe("month");
  });

  it("encodes tiered pricing as explicit-index tiers[] pairs with idempotencyKey", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/prices",
        json: loadFixture("stripe", "prices", "create_tiered.success"),
      },
    ]);

    const pr = await h.client.prices.create(
      {
        currency: "usd",
        billing_scheme: "tiered",
        product: "prod_pwv_fixture_0000000000000001",
        recurring: { interval: "month" },
        tiers: [
          { up_to: 10, unit_amount: 500 },
          { up_to: "inf", unit_amount: 400 },
        ],
        tiers_mode: "graduated",
      },
      { idempotencyKey: "push-usage-tiers-v1" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("push-usage-tiers-v1");
    expect(req.rawBody).toBe(
      "currency=usd&billing_scheme=tiered" +
        "&product=prod_pwv_fixture_0000000000000001&recurring[interval]=month" +
        "&tiers[0][up_to]=10&tiers[0][unit_amount]=500" +
        "&tiers[1][up_to]=inf&tiers[1][unit_amount]=400" +
        "&tiers_mode=graduated",
    );
    expect(pr.billing_scheme).toBe("tiered");
    expect(pr.tiers_mode).toBe("graduated");
  });

  it("rejects a non-integer unit_amount before sending (minor units rule)", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.prices.create({
        currency: "usd",
        unit_amount: 14.99,
        product: "prod_x",
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("prices.retrieve", () => {
  it("GETs /v1/prices/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/prices/:id",
        json: loadFixture("stripe", "prices", "retrieve.success"),
      },
    ]);

    const pr = await h.client.prices.retrieve("price_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/prices/price_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(pr.unit_amount).toBe(1500);
    expect(pr.currency).toBe("usd");
    expect(pr.type).toBe("recurring");
  });

  it("maps a 404 resource_missing envelope to PayweaveNotFoundError", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/prices/:id",
        status: 404,
        json: loadFixture("stripe", "prices", "not_found.error"),
      },
    ]);

    const err = await h.client.prices
      .retrieve("price_pwv_missing")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
    expect((err as PayweaveNotFoundError).providerCode).toBe("resource_missing");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.prices.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("prices.update", () => {
  it("archives via POST /v1/prices/{id} with active=false (immutable-price rotation)", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/prices/:id",
        json: loadFixture("stripe", "prices", "update.success"),
      },
    ]);

    const pr = await h.client.prices.update("price_pwv_fixture_0000000000000001", {
      active: false,
      metadata: { pwv_reference: "pwv_plan_pro" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/prices/price_pwv_fixture_0000000000000001");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.rawBody).toBe("active=false&metadata[pwv_reference]=pwv_plan_pro");
    expect(pr.active).toBe(false);
  });

  it("keeps immutable fields (unit_amount) off the wire — the update schema only knows mutable fields", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/prices/:id",
        json: loadFixture("stripe", "prices", "update.success"),
      },
    ]);

    await h.client.prices.update("price_pwv_fixture_0000000000000001", {
      // @ts-expect-error — unit_amount is immutable after creation (rotate via
      // a NEW price + active: false); the update schema strips it.
      unit_amount: 2000,
      active: false,
    });

    const req = await h.lastRequest();
    expect(req.rawBody).toBe("active=false");
    expect(req.form.has("unit_amount")).toBe(false);
  });
});

describe("prices.list + iterate", () => {
  it("GETs /v1/prices with recurring[interval] bracket keys and explicit-index lookup_keys[]", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/prices",
        json: loadFixture("stripe", "prices", "list.page1"),
      },
    ]);

    const page = await h.client.prices.list({
      product: "prod_pwv_fixture_0000000000000001",
      active: true,
      lookup_keys: ["pro-monthly", "starter-monthly"],
      recurring: { interval: "month" },
      limit: 2,
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/prices");
    expect(req.search.get("product")).toBe("prod_pwv_fixture_0000000000000001");
    expect(req.search.get("active")).toBe("true");
    expect(req.search.get("limit")).toBe("2");
    expect(req.search.get("recurring[interval]")).toBe("month");
    // Array query param → explicit indices, mirroring the body encoder.
    expect(req.search.get("lookup_keys[0]")).toBe("pro-monthly");
    expect(req.search.get("lookup_keys[1]")).toBe("starter-monthly");
    expect(req.search.has("lookup_keys")).toBe(false);
    expect(page.data).toHaveLength(2);
    expect(page.data[0]!.unit_amount).toBe(1500);
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "prices", "list.page1");
    const page2 = loadFixture("stripe", "prices", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/prices", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const pr of h.client.prices.iterate({
      lookup_keys: ["pro-monthly"],
    })) {
      ids.push(pr.id);
    }

    expect(ids).toEqual([
      "price_pwv_fixture_0000000000000001",
      "price_pwv_fixture_0000000000000002",
      "price_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "price_pwv_fixture_0000000000000002",
    );
    // The indexed lookup_keys filter rides along on every page.
    expect(reqs[1]!.search.get("lookup_keys[0]")).toBe("pro-monthly");
  });
});

describe("prices.search + iterateSearch", () => {
  it("GETs /v1/prices/search with the search query language string", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/prices/search",
        json: loadFixture("stripe", "prices", "search.page1"),
      },
    ]);

    const found = await h.client.prices.search({
      query: "active:'true' AND lookup_key:'pro-monthly'",
      limit: 1,
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/prices/search");
    expect(req.search.get("query")).toBe("active:'true' AND lookup_key:'pro-monthly'");
    expect(req.search.get("limit")).toBe("1");
    expect(req.search.get("page")).toBeNull();
    expect(found.object).toBe("search_result");
    expect(found.has_more).toBe(true);
    expect(found.data[0]!.lookup_key).toBe("pro-monthly");
  });

  it("iterateSearch() follows has_more with page = next_page token", async () => {
    const page1 = loadFixture("stripe", "prices", "search.page1");
    const page2 = loadFixture("stripe", "prices", "search.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/prices/search", ({ request }) => {
        const token = new URL(request.url).searchParams.get("page");
        return HttpResponse.json(
          (token === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const pr of h.client.prices.iterateSearch({
      query: "type:'recurring'",
    })) {
      ids.push(pr.id);
    }

    expect(ids).toEqual([
      "price_pwv_fixture_0000000000000001",
      "price_pwv_fixture_0000000000000002",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("page")).toBeNull();
    expect(reqs[1]!.search.get("page")).toBe("pwv_fixture_page_token_0002");
    expect(reqs[1]!.search.get("starting_after")).toBeNull();
  });
});
