import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { STRIPE_API_VERSION } from "../../src/core/config";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makeStripe, TEST_SECRET_KEY, type StripeHarness } from "./_harness";

let h: StripeHarness;
afterEach(() => h?.close());

describe("webhookEndpoints.create", () => {
  it("POSTs url + enabled_events[i] bracket encoding and surfaces the create-only secret", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/webhook_endpoints",
        json: loadFixture("stripe", "webhook-endpoints", "create.success"),
      },
    ]);

    const we = await h.client.webhookEndpoints.create({
      url: "https://example.com/payweave/webhooks",
      enabled_events: ["checkout.session.completed", "payment_intent.succeeded"],
      description: "payweave listen (fixture)",
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/webhook_endpoints");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    // enabled_events is an array → EXPLICIT-index bracket pairs, never JSON.
    expect(req.rawBody).toBe(
      "url=https%3A%2F%2Fexample.com%2Fpayweave%2Fwebhooks" +
        "&enabled_events[0]=checkout.session.completed" +
        "&enabled_events[1]=payment_intent.succeeded" +
        "&description=payweave%20listen%20(fixture)",
    );
    expect(req.rawBody.includes("{")).toBe(false);
    expect(req.form.get("enabled_events[0]")).toBe("checkout.session.completed");
    expect(req.form.get("enabled_events[1]")).toBe("payment_intent.succeeded");

    // The signing secret is returned ONLY on create — capture it here or
    // never. The fixture value is a clearly-fake placeholder (no real whsec_
    // material may ever enter the tree).
    expect(we.secret).toBe("whsec_FAKE_FIXTURE_PLACEHOLDER_NOT_A_REAL_SECRET_0000");
    expect(we.secret!.startsWith("whsec_FAKE")).toBe(true);
    expect(we.id).toBe("we_pwv_fixture_0000000000000001");
    expect(we.status).toBe("enabled");
    expect(we.enabled_events).toEqual([
      "checkout.session.completed",
      "payment_intent.succeeded",
    ]);
  });

  it("rejects an empty enabled_events array before sending", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.webhookEndpoints.create({
        url: "https://example.com/payweave/webhooks",
        enabled_events: [],
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("webhookEndpoints.retrieve", () => {
  it("GETs /v1/webhook_endpoints/{id} — the response carries NO secret (create-only)", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/webhook_endpoints/:id",
        json: loadFixture("stripe", "webhook-endpoints", "retrieve.success"),
      },
    ]);

    const we = await h.client.webhookEndpoints.retrieve(
      "we_pwv_fixture_0000000000000001",
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/webhook_endpoints/we_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(we.url).toBe("https://example.com/payweave/webhooks");
    expect(we.status).toBe("enabled");
    // "Only returned at creation" — retrieve responses never include it.
    expect(we.secret).toBeUndefined();
  });

  it("maps a 404 resource_missing envelope to PayweaveNotFoundError", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/webhook_endpoints/:id",
        status: 404,
        json: {
          error: {
            code: "resource_missing",
            doc_url: "https://docs.stripe.com/error-codes/resource-missing",
            message: "No such webhook endpoint: 'we_pwv_fixture_missing'",
            param: "id",
            type: "invalid_request_error",
          },
        },
      },
    ]);

    const err = await h.client.webhookEndpoints
      .retrieve("we_pwv_fixture_missing")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
    const notFound = err as PayweaveNotFoundError;
    expect(notFound.provider).toBe("stripe");
    expect(notFound.providerCode).toBe("resource_missing");
    expect(notFound.providerMessage).toContain("No such webhook endpoint");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.webhookEndpoints.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("webhookEndpoints.update", () => {
  it("POSTs disabled + replacement enabled_events as form pairs", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/webhook_endpoints/:id",
        json: loadFixture("stripe", "webhook-endpoints", "update.success"),
      },
    ]);

    const we = await h.client.webhookEndpoints.update(
      "we_pwv_fixture_0000000000000001",
      {
        disabled: true,
        enabled_events: [
          "checkout.session.completed",
          "payment_intent.succeeded",
          "charge.refunded",
        ],
      },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/webhook_endpoints/we_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe(
      "disabled=true" +
        "&enabled_events[0]=checkout.session.completed" +
        "&enabled_events[1]=payment_intent.succeeded" +
        "&enabled_events[2]=charge.refunded",
    );
    expect(we.status).toBe("disabled");
    // Updates never re-issue the signing secret.
    expect(we.secret).toBeUndefined();
  });

  it("sends NO body when updating with no params", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/webhook_endpoints/:id",
        json: loadFixture("stripe", "webhook-endpoints", "update.success"),
      },
    ]);

    await h.client.webhookEndpoints.update("we_pwv_fixture_0000000000000001");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });
});

describe("webhookEndpoints.delete", () => {
  it("DELETEs /v1/webhook_endpoints/{id} and parses the deleted stub", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/webhook_endpoints/:id",
        json: loadFixture("stripe", "webhook-endpoints", "delete.success"),
      },
    ]);

    const gone = await h.client.webhookEndpoints.delete(
      "we_pwv_fixture_0000000000000001",
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/v1/webhook_endpoints/we_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(gone.id).toBe("we_pwv_fixture_0000000000000001");
    expect(gone.deleted).toBe(true);
  });
});

describe("webhookEndpoints.list + iterate", () => {
  it("GETs /v1/webhook_endpoints with cursor params only", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/webhook_endpoints",
        json: loadFixture("stripe", "webhook-endpoints", "list.page1"),
      },
    ]);

    const page = await h.client.webhookEndpoints.list({ limit: 2 });

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/webhook_endpoints");
    expect(req.search.get("limit")).toBe("2");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
    // List responses never include signing secrets.
    expect(page.data.every((we) => we.secret === undefined)).toBe(true);
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "webhook-endpoints", "list.page1");
    const page2 = loadFixture("stripe", "webhook-endpoints", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/webhook_endpoints", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const we of h.client.webhookEndpoints.iterate()) {
      ids.push(we.id);
    }

    expect(ids).toEqual([
      "we_pwv_fixture_0000000000000001",
      "we_pwv_fixture_0000000000000002",
      "we_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "we_pwv_fixture_0000000000000002",
    );
  });
});
