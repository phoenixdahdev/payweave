import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { STRIPE_API_VERSION } from "../../src/core/config";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makeStripe, TEST_SECRET_KEY, type StripeHarness } from "./_harness";

let h: StripeHarness;
afterEach(() => h?.close());

describe("subscriptions.create", () => {
  it("POSTs bracket-notation form data with auth + version headers — never JSON", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions",
        json: loadFixture("stripe", "subscriptions", "create.success"),
      },
    ]);

    const sub = await h.client.subscriptions.create({
      customer: "cus_pwv_fixture_001",
      items: [{ price: "price_pwv_fixture_001", quantity: 1 }],
      metadata: { pwv_plan: "pro" },
      payment_behavior: "default_incomplete",
      trial_period_days: 14,
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/subscriptions");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET_KEY}`);
    expect(req.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    // items[] is the nested-array bracket case; metadata the nested dict one.
    expect(req.rawBody).toBe(
      "customer=cus_pwv_fixture_001&items[0][price]=price_pwv_fixture_001" +
        "&items[0][quantity]=1&metadata[pwv_plan]=pro" +
        "&payment_behavior=default_incomplete&trial_period_days=14",
    );
    expect(req.rawBody.includes("{")).toBe(false);
    expect(req.form.get("items[0][price]")).toBe("price_pwv_fixture_001");
    expect(req.form.get("metadata[pwv_plan]")).toBe("pro");

    // Bare resource — no envelope. Status + period fields feed PW-804/805;
    // on the pinned API version current_period_* live on the embedded items.
    expect(sub.id).toBe("sub_pwv_fixture_0000000000000001");
    expect(sub.status).toBe("active");
    expect(sub.cancel_at_period_end).toBe(false);
    expect(sub.items?.data[0]?.current_period_start).toBe(1752300000);
    expect(sub.items?.data[0]?.current_period_end).toBe(1754978400);
  });

  it("encodes trial_settings depth-2 dictionaries and passes idempotencyKey", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions",
        json: loadFixture("stripe", "subscriptions", "create.success"),
      },
    ]);

    await h.client.subscriptions.create(
      {
        customer: "cus_pwv_fixture_001",
        items: [{ price: "price_pwv_fixture_001" }],
        collection_method: "charge_automatically",
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: "pause" } },
      },
      { idempotencyKey: "sub-cus_001-pro" },
    );

    const req = await h.lastRequest();
    expect(req.headers.get("idempotency-key")).toBe("sub-cus_001-pro");
    expect(req.rawBody).toBe(
      "customer=cus_pwv_fixture_001&items[0][price]=price_pwv_fixture_001" +
        "&collection_method=charge_automatically&trial_period_days=7" +
        "&trial_settings[end_behavior][missing_payment_method]=pause",
    );
  });

  it("rejects a request without items before sending (schema parse-before-send)", async () => {
    h = await makeStripe([]);
    await expect(
      // @ts-expect-error — items is required
      h.client.subscriptions.create({ customer: "cus_pwv_fixture_001" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });

  it("rejects more than 20 items locally (documented create limit)", async () => {
    h = await makeStripe([]);
    const items = Array.from({ length: 21 }, () => ({ price: "price_x" }));
    await expect(
      h.client.subscriptions.create({ customer: "cus_x", items }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptions.retrieve", () => {
  it("GETs /v1/subscriptions/{id}", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        json: loadFixture("stripe", "subscriptions", "retrieve.success"),
      },
    ]);

    const sub = await h.client.subscriptions.retrieve("sub_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/subscriptions/sub_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("");
    expect(sub.status).toBe("active");
    expect(sub.items?.data).toHaveLength(1);
  });

  it("maps a 404 resource_missing envelope to PayweaveNotFoundError with providerCode", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        status: 404,
        json: loadFixture("stripe", "subscriptions", "resource_missing.error"),
      },
    ]);

    const err = await h.client.subscriptions
      .retrieve("sub_pwv_fixture_missing")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
    const notFound = err as PayweaveNotFoundError;
    expect(notFound.provider).toBe("stripe");
    expect(notFound.httpStatus).toBe(404);
    expect(notFound.providerCode).toBe("resource_missing");
    expect(notFound.providerMessage).toContain("No such subscription");
  });

  it("throws PayweaveValidationError on an empty id (no request made)", async () => {
    h = await makeStripe([]);
    await expect(h.client.subscriptions.retrieve("")).rejects.toBeInstanceOf(
      PayweaveValidationError,
    );
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptions.update", () => {
  it("POSTs item + proration changes to /v1/subscriptions/{id} as form data", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        json: loadFixture("stripe", "subscriptions", "retrieve.success"),
      },
    ]);

    await h.client.subscriptions.update(
      "sub_pwv_fixture_0000000000000001",
      {
        items: [{ id: "si_pwv_fixture_0000000000000001", quantity: 5 }],
        proration_behavior: "always_invoice",
        proration_date: 1752345678,
      },
      { idempotencyKey: "sub-seat-bump" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/subscriptions/sub_pwv_fixture_0000000000000001");
    expect(req.headers.get("idempotency-key")).toBe("sub-seat-bump");
    // Proration param names copied exactly from the docs — never abstracted.
    expect(req.rawBody).toBe(
      "items[0][id]=si_pwv_fixture_0000000000000001&items[0][quantity]=5" +
        "&proration_behavior=always_invoice&proration_date=1752345678",
    );
  });

  it("unsets pause_collection with an explicit empty string (resumes collection)", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        json: loadFixture("stripe", "subscriptions", "retrieve.success"),
      },
    ]);

    await h.client.subscriptions.update("sub_pwv_fixture_0000000000000001", {
      pause_collection: "",
    });

    const req = await h.lastRequest();
    // Stripe's unset convention: an explicit empty value, never an omitted key.
    expect(req.rawBody).toBe("pause_collection=");
  });

  it("rejects an unknown proration_behavior before sending", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.subscriptions.update("sub_x", {
        // @ts-expect-error — intentionally invalid input
        proration_behavior: "sometimes",
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("cancel vs cancel_at_period_end (the two documented shapes, never merged)", () => {
  it("update({ cancel_at_period_end: true }) POSTs to /v1/subscriptions/{id} — no DELETE", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        json: loadFixture("stripe", "subscriptions", "update.success"),
      },
    ]);

    const sub = await h.client.subscriptions.update("sub_pwv_fixture_0000000000000001", {
      cancel_at_period_end: true,
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/subscriptions/sub_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe("cancel_at_period_end=true");
    // End-of-period: the subscription is STILL active, only flagged to cancel.
    expect(sub.status).toBe("active");
    expect(sub.cancel_at_period_end).toBe(true);
    expect(sub.ended_at).toBeNull();
  });

  it("cancel() DELETEs /v1/subscriptions/{id} immediately with optional form params", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        json: loadFixture("stripe", "subscriptions", "cancel.success"),
      },
    ]);

    const sub = await h.client.subscriptions.cancel("sub_pwv_fixture_0000000000000001", {
      cancellation_details: { feedback: "too_expensive" },
      invoice_now: true,
      prorate: true,
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/v1/subscriptions/sub_pwv_fixture_0000000000000001");
    expect(req.rawBody).toBe(
      "cancellation_details[feedback]=too_expensive&invoice_now=true&prorate=true",
    );
    // Immediate: canceled now, ended now.
    expect(sub.status).toBe("canceled");
    expect(sub.canceled_at).toBe(1752400000);
    expect(sub.ended_at).toBe(1752400000);
  });

  it("cancel() with no params sends a bare DELETE (no body, no content-type)", async () => {
    h = await makeStripe([
      {
        method: "delete",
        url: "https://api.stripe.com/v1/subscriptions/:id",
        json: loadFixture("stripe", "subscriptions", "cancel.success"),
      },
    ]);

    await h.client.subscriptions.cancel("sub_pwv_fixture_0000000000000001");

    const req = await h.lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });

  it("rejects an unknown cancellation feedback value before sending", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.subscriptions.cancel("sub_x", {
        // @ts-expect-error — intentionally invalid input
        cancellation_details: { feedback: "meh" },
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptions.resume", () => {
  it("POSTs the documented params to /v1/subscriptions/{id}/resume", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions/:id/resume",
        json: loadFixture("stripe", "subscriptions", "resume.success"),
      },
    ]);

    const sub = await h.client.subscriptions.resume(
      "sub_pwv_fixture_0000000000000002",
      { billing_cycle_anchor: "unchanged", proration_behavior: "create_prorations" },
      { idempotencyKey: "resume-sub-002" },
    );

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/subscriptions/sub_pwv_fixture_0000000000000002/resume");
    expect(req.headers.get("idempotency-key")).toBe("resume-sub-002");
    expect(req.rawBody).toBe(
      "billing_cycle_anchor=unchanged&proration_behavior=create_prorations",
    );
    expect(sub.status).toBe("active");
  });

  it("sends NO body when resuming with defaults (billing_cycle_anchor defaults to now)", async () => {
    h = await makeStripe([
      {
        method: "post",
        url: "https://api.stripe.com/v1/subscriptions/:id/resume",
        json: loadFixture("stripe", "subscriptions", "resume.success"),
      },
    ]);

    await h.client.subscriptions.resume("sub_pwv_fixture_0000000000000002");
    const req = await h.lastRequest();
    expect(req.rawBody).toBe("");
    expect(req.headers.get("content-type")).toBeNull();
  });

  it("rejects an invalid billing_cycle_anchor before sending", async () => {
    h = await makeStripe([]);
    await expect(
      h.client.subscriptions.resume("sub_x", {
        // @ts-expect-error — intentionally invalid input
        billing_cycle_anchor: "later",
      }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
    expect(await h.requests()).toHaveLength(0);
  });
});

describe("subscriptions.list + iterate", () => {
  it("GETs /v1/subscriptions with flattened range filters as query params", async () => {
    h = await makeStripe([
      {
        method: "get",
        url: "https://api.stripe.com/v1/subscriptions",
        json: loadFixture("stripe", "subscriptions", "list.page1"),
      },
    ]);

    const page = await h.client.subscriptions.list({
      customer: "cus_pwv_fixture_001",
      status: "all",
      limit: 2,
      created: { lt: 1753000000 },
      current_period_end: { gte: 1752000000 },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/subscriptions");
    // Filters are QUERY params — never a form body (PW-604 contract note).
    expect(req.rawBody).toBe("");
    expect(req.search.get("customer")).toBe("cus_pwv_fixture_001");
    expect(req.search.get("status")).toBe("all");
    expect(req.search.get("limit")).toBe("2");
    expect(req.search.get("created[lt]")).toBe("1753000000");
    expect(req.search.get("current_period_end[gte]")).toBe("1752000000");
    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(2);
    expect(page.data[1]!.status).toBe("past_due");
  });

  it("iterate() follows has_more with starting_after = last id of the page", async () => {
    const page1 = loadFixture("stripe", "subscriptions", "list.page1");
    const page2 = loadFixture("stripe", "subscriptions", "list.page2");
    const { http, HttpResponse } = await import("msw");
    h = await makeStripe([]);
    h.server.use(
      http.get("https://api.stripe.com/v1/subscriptions", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        return HttpResponse.json(
          (cursor === null ? page1 : page2) as Record<string, unknown>,
        );
      }),
    );

    const ids: string[] = [];
    for await (const sub of h.client.subscriptions.iterate({ customer: "cus_pwv_fixture_001" })) {
      ids.push(sub.id);
    }

    expect(ids).toEqual([
      "sub_pwv_fixture_0000000000000001",
      "sub_pwv_fixture_0000000000000002",
      "sub_pwv_fixture_0000000000000003",
    ]);
    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("starting_after")).toBeNull();
    expect(reqs[0]!.search.get("customer")).toBe("cus_pwv_fixture_001");
    expect(reqs[1]!.search.get("starting_after")).toBe(
      "sub_pwv_fixture_0000000000000002",
    );
    expect(reqs[1]!.search.get("customer")).toBe("cus_pwv_fixture_001");
  });
});
