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

describe("products.create", () => {
  it("POSTs bracket-notation form data incl. nested default_price_data — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/products",
        json: loadFixture("stripe", "products", "create.success"),
      },
    ]);

    const prod = await h.client.products.create({
      name: "Pro Plan",
      description: "Payweave Pro plan",
      metadata: { pwv_reference: "pwv_plan_pro" },
      default_price_data: {
        currency: "usd",
        unit_amount: 1500, // $15.00 in minor units, unchanged
        recurring: { interval: "month" },
      },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/products");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    expect(req.rawBody).toBe(
      "name=Pro%20Plan&description=Payweave%20Pro%20plan" +
        "&metadata[pwv_reference]=pwv_plan_pro" +
        "&default_price_data[currency]=usd&default_price_data[unit_amount]=1500" +
        "&default_price_data[recurring][interval]=month",
    );
    expect(req.form.get("default_price_data[unit_amount]")).toBe("1500");
    expect(req.form.get("metadata[pwv_reference]")).toBe("pwv_plan_pro");

    // Bare resource — no envelope unwrapping.
    expect(prod.id).toBe("prod_pwv_fixture_0000000000000001");
    expect(prod.name).toBe("Pro Plan");
    expect(prod.default_price).toBe("price_pwv_fixture_0000000000000001");
    expect(prod.metadata).toEqual({ pwv_reference: "pwv_plan_pro" });
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/products",
        json: loadFixture("stripe", "products", "create.success"),
      },
    ]);

    await h.client.products.create(
      { name: "Pro Plan" },
      { idempotencyKey: "push-pro-plan-v1" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("push-pro-plan-v1");
  });

  it("rejects a create without a name before sending (no request made)", async () => {
    h = await makeStripe([]);
    await expect(
      // @ts-expect-error — name is required
      h.client.products.create({ description: "missing name" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("products.retrieve", () => {
  it("GETs /v1/products/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/products/:id",
        json: loadFixture("stripe", "products", "retrieve.success"),
      },
    ]);

    const prod = await h.client.products.retrieve("prod_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/products/prod_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(prod.active).toBe(true);
    expect(prod.images).toEqual(["https://example.com/pro.png"]);
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.products.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("products.update", () => {
  it("archives via POST /v1/products/{id} with active=false (PW-803 sync semantics)", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/products/:id",
        json: loadFixture("stripe", "products", "update.success"),
      },
    ]);

    const prod = await h.client.products.update("prod_pwv_fixture_0000000000000001", {
      active: false,
      metadata: { pwv_reference: "pwv_plan_pro", pwv_archived: "true" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/products/prod_pwv_fixture_0000000000000001");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.rawBody).toBe(
      "active=false&metadata[pwv_reference]=pwv_plan_pro&metadata[pwv_archived]=true",
    );
    expect(prod.active).toBe(false);
  });

  it("sends NO body when updating with no params", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/products/:id",
        json: loadFixture("stripe", "products", "update.success"),
      },
    ]);

    await h.client.products.update("prod_pwv_fixture_0000000000000001");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });
});

describe("products.delete", () => {
  it("DELETEs /v1/products/{id} and parses the deletion stub", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/products/:id",
        json: loadFixture("stripe", "products", "delete.success"),
      },
    ]);

    const gone = await h.client.products.delete("prod_pwv_fixture_0000000000000002");

    const req = await h.lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/v1/products/prod_pwv_fixture_0000000000000002");
    expect(req.rawBody).toBe("");
    expect(gone.deleted).toBe(true);
  });

  it("maps the 400 for deleting a product that still has prices to PayweaveValidationError", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/products/:id",
        status: 400,
        json: loadFixture("stripe", "products", "has_prices.error"),
      },
    ]);

    const err = await h.client.products
      .delete("prod_pwv_fixture_0000000000000001")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as PayweaveValidationError).providerMessage).toContain(
      "archive the product",
    );
  });
});

describe("products.list + iterate", () => {
  it("GETs /v1/products with flattened filters and explicit-index ids[]", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/products",
        json: loadFixture("stripe", "products", "list.page1"),
      },
    ]);

    const page = await h.client.products.list({
      ids: [
        "prod_pwv_fixture_0000000000000001",
        "prod_pwv_fixture_0000000000000002",
      ],
      active: true,
      limit: 2,
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/products");
    expect(req.search.get("active")).toBe("true");
    expect(req.search.get("limit")).toBe("2");
    // Array query param → explicit indices, mirroring the body encoder.
    expect(req.search.get("ids[0]")).toBe("prod_pwv_fixture_0000000000000001");
    expect(req.search.get("ids[1]")).toBe("prod_pwv_fixture_0000000000000002");
    expect(req.search.has("ids")).toBe(false);
    expect(page.data).toHaveLength(2);
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "products", "list.page1");
    const page2 = loadFixture("stripe", "products", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/products", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const prod of h.client.products.iterate({ active: true })) {
      ids.push(prod.id);
    }

    expect(ids).toEqual([
      "prod_pwv_fixture_0000000000000001",
      "prod_pwv_fixture_0000000000000002",
      "prod_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "prod_pwv_fixture_0000000000000002",
    );
    expect(reqs[1]!.search.get("active")).toBe("true");
  });
});

describe("products.search + iterateSearch", () => {
  it("GETs /v1/products/search with the search query language string", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/products/search",
        json: loadFixture("stripe", "products", "search.page1"),
      },
    ]);

    const found = await h.client.products.search({
      query: "active:'true' AND metadata['pwv_reference']:'pwv_plan_pro'",
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/products/search");
    expect(req.search.get("query")).toBe(
      "active:'true' AND metadata['pwv_reference']:'pwv_plan_pro'",
    );
    expect(req.search.get("page")).toBeNull();
    expect(found.object).toBe("search_result");
    expect(found.data[0]!.id).toBe("prod_pwv_fixture_0000000000000001");
    expect(found.next_page).toBe("pwv_fixture_page_token_0002");
  });

  it("iterateSearch() follows has_more with page = next_page token", async () => {
    const page1 = loadFixture("stripe", "products", "search.page1");
    const page2 = loadFixture("stripe", "products", "search.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/products/search", ({ request }) => {
        const token = new URL(request.url).searchParams.get("page");
        return HttpResponse.json(
          (token === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const prod of h.client.products.iterateSearch({
      query: "active:'true'",
    })) {
      ids.push(prod.id);
    }

    expect(ids).toEqual([
      "prod_pwv_fixture_0000000000000001",
      "prod_pwv_fixture_0000000000000002",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("page")).toBeNull();
    expect(reqs[1]!.search.get("page")).toBe("pwv_fixture_page_token_0002");
    expect(reqs[1]!.search.get("starting_after")).toBeNull();
  });

  it("maps a 404 on search to PayweaveNotFoundError", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/products/search",
        status: 404,
        json: {
          error: {
            message: "Search is not supported on api version 2020-08-27",
            type: "invalid_request_error",
          },
        },
      },
    ]);

    const err = await h.client.products
      .search({ query: "active:'true'" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
  });
});
