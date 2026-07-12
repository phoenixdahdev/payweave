import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("refunds.create", () => {
  it("POSTs /refund with the transaction + amount in kobo", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/refund",
        json: loadFixture("paystack", "refunds", "create.success"),
      },
    ]);

    const res = await h.client.refunds.create({ transaction: "pwv_test_reference_001", amount: 100000 });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/refund");
    expect(req.headers.get("authorization")).toBe("Bearer sk_test_harness");
    expect(req.body).toEqual({ transaction: "pwv_test_reference_001", amount: 100000 });
    expect(res.data.amount).toBe(100000);
  });

  it("rejects a missing transaction with PayweaveValidationError", async () => {
    h = await makePaystack([]);
    await expect(
      // @ts-expect-error — intentionally invalid
      h.client.refunds.create({ amount: 100000 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("refunds.list + iterate", () => {
  it("GETs /refund and returns the list", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/refund",
        json: loadFixture("paystack", "refunds", "list.success"),
      },
    ]);
    const res = await h.client.refunds.list({ perPage: 50 });
    const req = await h.lastRequest();
    expect(req.path).toBe("/refund");
    expect(req.search.get("perPage")).toBe("50");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() yields every refund", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/refund",
        json: loadFixture("paystack", "refunds", "list.success"),
      },
    ]);
    const ids: (number | undefined)[] = [];
    for await (const r of h.client.refunds.iterate()) ids.push(r.id);
    expect(ids).toEqual([4001, 4002]);
  });
});

describe("refunds.fetch", () => {
  it("GETs /refund/:id", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/refund/:id",
        json: loadFixture("paystack", "refunds", "fetch.success"),
      },
    ]);
    const res = await h.client.refunds.fetch(4001);
    const req = await h.lastRequest();
    expect(req.path).toBe("/refund/4001");
    expect(res.data.id).toBe(4001);
  });

  it("maps 404 to PayweaveNotFoundError", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/refund/:id",
        status: 404,
        json: { status: false, message: "Refund not found" },
      },
    ]);
    await expect(h.client.refunds.fetch(999999)).rejects.toBeInstanceOf(PayweaveNotFoundError);
  });
});
