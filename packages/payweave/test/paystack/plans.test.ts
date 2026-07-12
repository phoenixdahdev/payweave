import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("plans.create", () => {
  it("POSTs /plan with amount in kobo and interval", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/plan",
        json: loadFixture("paystack", "plans", "create.success"),
      },
    ]);
    const res = await h.client.plans.create({ name: "Monthly", amount: 500000, interval: "monthly" });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/plan");
    expect(req.body).toEqual({ name: "Monthly", amount: 500000, interval: "monthly" });
    expect(res.data.plan_code).toBe("PLN_example");
  });

  it("rejects an invalid interval with PayweaveValidationError", async () => {
    h = await makePaystack([]);
    await expect(
      // @ts-expect-error — intentionally invalid interval
      h.client.plans.create({ name: "X", amount: 1000, interval: "fortnightly" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("plans.list + fetch", () => {
  it("GETs /plan", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/plan",
        json: loadFixture("paystack", "plans", "list.success"),
      },
    ]);
    const res = await h.client.plans.list({ perPage: 50 });
    expect((await h.lastRequest()).path).toBe("/plan");
    expect(res.data).toHaveLength(2);
  });

  it("GETs /plan/:code and maps 404", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/plan/:code",
        status: 404,
        json: { status: false, message: "Plan not found" },
      },
    ]);
    await expect(h.client.plans.fetch("PLN_missing")).rejects.toBeInstanceOf(PayweaveNotFoundError);
  });
});
