import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("subscriptions.create", () => {
  it("POSTs /subscription with customer + plan", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/subscription",
        json: loadFixture("paystack", "subscriptions", "create.success"),
      },
    ]);
    const res = await h.client.subscriptions.create({ customer: "CUS_example", plan: "PLN_example" });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/subscription");
    expect(req.body).toEqual({ customer: "CUS_example", plan: "PLN_example" });
    expect(res.data.subscription_code).toBe("SUB_example");
  });

  it("rejects a missing plan with PayweaveValidationError", async () => {
    h = await makePaystack([]);
    await expect(
      // @ts-expect-error — intentionally invalid
      h.client.subscriptions.create({ customer: "CUS_example" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("subscriptions.list", () => {
  it("GETs /subscription", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/subscription",
        json: loadFixture("paystack", "subscriptions", "list.success"),
      },
    ]);
    const res = await h.client.subscriptions.list({ perPage: 50 });
    expect((await h.lastRequest()).path).toBe("/subscription");
    expect(res.data).toHaveLength(2);
  });
});

describe("subscriptions.enable / disable", () => {
  it("POSTs /subscription/enable with code + token", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/subscription/enable",
        json: loadFixture("paystack", "subscriptions", "enable.success"),
      },
    ]);
    const res = await h.client.subscriptions.enable({ code: "SUB_example", token: "email_token_example" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/subscription/enable");
    expect(req.body).toEqual({ code: "SUB_example", token: "email_token_example" });
    expect(res.status).toBe(true);
  });

  it("POSTs /subscription/disable with code + token", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/subscription/disable",
        json: { status: true, message: "Subscription disabled successfully" },
      },
    ]);
    const res = await h.client.subscriptions.disable({ code: "SUB_example", token: "email_token_example" });
    expect((await h.lastRequest()).path).toBe("/subscription/disable");
    expect(res.status).toBe(true);
  });
});
