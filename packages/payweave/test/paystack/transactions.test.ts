import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("transactions.initialize", () => {
  it("POSTs to /transaction/initialize with amount in kobo unchanged", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ]);

    const res = await h.client.transactions.initialize({
      email: "buyer@example.com",
      amount: 500000,
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/transaction/initialize");
    expect(req.headers.get("authorization")).toBe("Bearer sk_test_harness");
    expect(req.headers.get("content-type")).toContain("application/json");
    expect(req.headers.get("accept")).toContain("application/json");
    // Acceptance: amount must reach Paystack in kobo, unchanged.
    expect(req.body).toEqual({ email: "buyer@example.com", amount: 500000 });

    expect(res.status).toBe(true);
    expect(res.data.authorization_url).toContain("checkout.paystack.com");
    expect(res.data.reference).toBe("pwv_test_reference_001");
  });

  it("throws PayweaveValidationError before sending when email is missing", async () => {
    h = await makePaystack([]);
    await expect(
      // @ts-expect-error — intentionally invalid input
      h.client.transactions.initialize({ amount: 500000 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("transactions.verify", () => {
  it("verifies a reference Paystack reports as success and returns parsed data", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/verify/:reference",
        json: loadFixture("paystack", "transactions", "verify.success"),
      },
    ]);

    const res = await h.client.transactions.verify("pwv_test_reference_001");

    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/transaction/verify/pwv_test_reference_001");
    expect(res.data.status).toBe("success");
    expect(res.data.amount).toBe(500000);
    expect(res.data.reference).toBe("pwv_test_reference_001");
  });

  it("maps a 404 for an unknown reference to PayweaveNotFoundError", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/verify/:reference",
        status: 404,
        json: loadFixture("paystack", "transactions", "not_found"),
      },
    ]);

    await expect(h.client.transactions.verify("does_not_exist")).rejects.toBeInstanceOf(
      PayweaveNotFoundError,
    );
  });
});

describe("transactions.list + iterate", () => {
  it("GETs /transaction with pagination query", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction",
        json: loadFixture("paystack", "transactions", "list.success"),
      },
    ]);

    const res = await h.client.transactions.list({ perPage: 50, status: "success" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/transaction");
    expect(req.search.get("perPage")).toBe("50");
    expect(req.search.get("status")).toBe("success");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() walks pages until pageCount and yields every item", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction",
        json: loadFixture("paystack", "transactions", "list.success"),
      },
    ]);

    const ids: number[] = [];
    for await (const tx of h.client.transactions.iterate({ perPage: 50 })) {
      ids.push(tx.id);
    }
    expect(ids).toEqual([1, 2]);
    // pageCount is 1, so exactly one request is made.
    const reqs = await h.requests();
    expect(reqs).toHaveLength(1);
  });
});

describe("transactions.chargeAuthorization", () => {
  it("POSTs to /transaction/charge_authorization with amount in kobo", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/charge_authorization",
        json: loadFixture("paystack", "transactions", "charge_authorization.success"),
      },
    ]);

    const res = await h.client.transactions.chargeAuthorization({
      email: "buyer@example.com",
      amount: 500000,
      authorization_code: "AUTH_example",
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/transaction/charge_authorization");
    expect(req.body).toMatchObject({ amount: 500000, authorization_code: "AUTH_example" });
    expect(res.data.status).toBe("success");
  });
});

describe("transactions.fetch", () => {
  it("GETs /transaction/:id", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/:id",
        json: loadFixture("paystack", "transactions", "verify.success"),
      },
    ]);
    const res = await h.client.transactions.fetch(123456789);
    const req = await h.lastRequest();
    expect(req.path).toBe("/transaction/123456789");
    expect(res.data.id).toBe(123456789);
  });
});
