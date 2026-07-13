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

describe("customers.create", () => {
  it("POSTs bracket-notation form data with a nested metadata map — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/customers",
        json: loadFixture("stripe", "customers", "create.success"),
      },
    ]);

    const cus = await h.client.customers.create({
      address: { city: "Lagos", country: "NG" },
      email: "jenny.rosen@example.com",
      metadata: { pwv_reference: "pwv_ref_0001", order_id: "8123" },
      name: "Jenny Rosen",
      tax_exempt: "none",
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/customers");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    // Bracket-notation form body — nested dictionaries (address, metadata)
    // become bracket pairs, no JSON anywhere.
    expect(req.rawBody).toBe(
      "address[city]=Lagos&address[country]=NG&email=jenny.rosen%40example.com" +
        "&metadata[pwv_reference]=pwv_ref_0001&metadata[order_id]=8123" +
        "&name=Jenny%20Rosen&tax_exempt=none",
    );
    expect(req.form.get("metadata[pwv_reference]")).toBe("pwv_ref_0001");
    expect(req.form.get("metadata[order_id]")).toBe("8123");

    // Metadata ROUND-TRIP: the nested map we bracket-encoded comes back as a
    // parsed object on the bare resource (no envelope unwrapping).
    expect(cus.id).toBe("cus_pwv_fixture_0000000000000001");
    expect(cus.metadata).toEqual({ pwv_reference: "pwv_ref_0001", order_id: "8123" });
    expect(cus.email).toBe("jenny.rosen@example.com");
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/customers",
        json: loadFixture("stripe", "customers", "create.success"),
      },
    ]);

    await h.client.customers.create(
      { email: "jenny.rosen@example.com" },
      { idempotencyKey: "signup-8123-customer" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("signup-8123-customer");
  });

  it("sends NO body when creating an empty customer", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/customers",
        json: loadFixture("stripe", "customers", "create.success"),
      },
    ]);

    await h.client.customers.create();
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });

  it("rejects a name over 256 chars before sending (no request made)", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.customers.create({ name: "x".repeat(257) }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });

  it("maps a 400 invalid_request_error envelope to PayweaveValidationError with providerCode", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/customers",
        status: 400,
        json: {
          error: {
            code: "email_invalid",
            message: "Invalid email address: not-an-email",
            param: "email",
            type: "invalid_request_error",
          },
        },
      },
    ]);

    const err = await h.client.customers
      .create({ email: "not-an-email" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveValidationError);
    const validation = err as PayweaveValidationError;
    expect(validation.provider).toBe("stripe");
    expect(validation.providerCode).toBe("email_invalid");
    expect(validation.providerMessage).toBe("Invalid email address: not-an-email");
  });
});

describe("customers.retrieve", () => {
  it("GETs /v1/customers/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/customers/:id",
        json: loadFixture("stripe", "customers", "retrieve.success"),
      },
    ]);

    const cus = await h.client.customers.retrieve("cus_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/customers/cus_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(cus.email).toBe("jenny.rosen@example.com");
    expect(cus.balance).toBe(-500); // integer minor units, unchanged
    expect(cus.deleted).toBeUndefined();
  });

  it("tolerates the reduced deleted-customer stub (deleted: true)", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/customers/:id",
        json: loadFixture("stripe", "customers", "delete.success"),
      },
    ]);

    const cus = await h.client.customers.retrieve("cus_pwv_fixture_0000000000000001");
    expect(cus.id).toBe("cus_pwv_fixture_0000000000000001");
    expect(cus.deleted).toBe(true);
  });

  it("maps a 404 resource_missing envelope to PayweaveNotFoundError", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/customers/:id",
        status: 404,
        json: loadFixture("stripe", "customers", "not_found.error"),
      },
    ]);

    const err = await h.client.customers
      .retrieve("cus_pwv_missing")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
    expect((err as PayweaveNotFoundError).providerCode).toBe("resource_missing");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.customers.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("customers.update", () => {
  it("POSTs form params to /v1/customers/{id} — empty string unsets a metadata key", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/customers/:id",
        json: loadFixture("stripe", "customers", "update.success"),
      },
    ]);

    const cus = await h.client.customers.update("cus_pwv_fixture_0000000000000001", {
      description: "VIP customer",
      metadata: { tier: "vip", legacy_id: "" }, // "" unsets legacy_id
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/customers/cus_pwv_fixture_0000000000000001");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.rawBody).toBe(
      "description=VIP%20customer&metadata[tier]=vip&metadata[legacy_id]=",
    );
    expect(cus.description).toBe("VIP customer");
    expect(cus.metadata).toEqual({ pwv_reference: "pwv_ref_0001", tier: "vip" });
  });

  it("sends NO body when updating with no params", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/customers/:id",
        json: loadFixture("stripe", "customers", "update.success"),
      },
    ]);

    await h.client.customers.update("cus_pwv_fixture_0000000000000001");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });
});

describe("customers.delete", () => {
  it("DELETEs /v1/customers/{id} and parses the deletion stub", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/customers/:id",
        json: loadFixture("stripe", "customers", "delete.success"),
      },
    ]);

    const gone = await h.client.customers.delete("cus_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/v1/customers/cus_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(gone.id).toBe("cus_pwv_fixture_0000000000000001");
    expect(gone.deleted).toBe(true);
  });

  it("maps a 404 for an unknown customer to PayweaveNotFoundError", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/customers/:id",
        status: 404,
        json: loadFixture("stripe", "customers", "not_found.error"),
      },
    ]);

    const err = await h.client.customers
      .delete("cus_pwv_missing")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
  });
});

describe("customers.list + iterate", () => {
  it("GETs /v1/customers with flattened created range + email filter", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/customers",
        json: loadFixture("stripe", "customers", "list.page1"),
      },
    ]);

    const page = await h.client.customers.list({
      limit: 2,
      created: { gte: 1751800000 },
      email: "jenny.rosen@example.com",
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v1/customers");
    expect(req.search.get("limit")).toBe("2");
    expect(req.search.get("created[gte]")).toBe("1751800000");
    expect(req.search.get("email")).toBe("jenny.rosen@example.com");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "customers", "list.page1");
    const page2 = loadFixture("stripe", "customers", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/customers", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const cus of h.client.customers.iterate()) {
      ids.push(cus.id);
    }

    expect(ids).toEqual([
      "cus_pwv_fixture_0000000000000001",
      "cus_pwv_fixture_0000000000000002",
      "cus_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "cus_pwv_fixture_0000000000000002",
    );
  });
});

describe("customers.search + iterateSearch", () => {
  it("GETs /v1/customers/search with the search query language string", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/customers/search",
        json: loadFixture("stripe", "customers", "search.page1"),
      },
    ]);

    const found = await h.client.customers.search({
      query: "name:'Jane Doe' AND metadata['foo']:'bar'",
      limit: 2,
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/customers/search");
    expect(req.search.get("query")).toBe("name:'Jane Doe' AND metadata['foo']:'bar'");
    expect(req.search.get("limit")).toBe("2");
    // First call never carries a page token.
    expect(req.search.get("page")).toBeNull();

    expect(found.object).toBe("search_result");
    expect(found.data).toHaveLength(2);
    expect(found.has_more).toBe(true);
    expect(found.next_page).toBe("pwv_fixture_page_token_0002");
  });

  it("rejects an empty search query before sending (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.customers.search({ query: "" })).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });

  it("iterateSearch() follows has_more with page = next_page token — NOT starting_after", async () => {
    const page1 = loadFixture("stripe", "customers", "search.page1");
    const page2 = loadFixture("stripe", "customers", "search.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/customers/search", ({ request }) => {
        const token = new URL(request.url).searchParams.get("page");
        return HttpResponse.json(
          (token === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const cus of h.client.customers.iterateSearch({
      query: "metadata['pwv_reference']:'pwv_ref_0001'",
    })) {
      ids.push(cus.id);
    }

    expect(ids).toEqual([
      "cus_pwv_fixture_0000000000000001",
      "cus_pwv_fixture_0000000000000002",
      "cus_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    // Search pagination is token-based: page, never starting_after.
    expect(reqs[0]!.search.get("page")).toBeNull();
    expect(reqs[1]!.search.get("page")).toBe("pwv_fixture_page_token_0002");
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBeNull();
    // The query string rides along on every page.
    expect(reqs[1]!.search.get("query")).toBe(
      "metadata['pwv_reference']:'pwv_ref_0001'",
    );
  });
});
