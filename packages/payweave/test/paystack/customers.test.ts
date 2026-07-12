import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("customers.create", () => {
  it("POSTs /customer with the email", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/customer",
        json: loadFixture("paystack", "customers", "create.success"),
      },
    ]);
    const res = await h.client.customers.create({ email: "buyer@example.com", first_name: "Ada" });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/customer");
    expect(req.body).toEqual({ email: "buyer@example.com", first_name: "Ada" });
    expect(res.data.customer_code).toBe("CUS_example");
  });

  it("rejects a missing email with PayweaveValidationError", async () => {
    h = await makePaystack([]);
    // @ts-expect-error — intentionally invalid
    await expect(h.client.customers.create({})).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("customers.list + iterate", () => {
  it("GETs /customer", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/customer",
        json: loadFixture("paystack", "customers", "list.success"),
      },
    ]);
    const res = await h.client.customers.list({ perPage: 50 });
    expect((await h.lastRequest()).path).toBe("/customer");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() yields every customer", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/customer",
        json: loadFixture("paystack", "customers", "list.success"),
      },
    ]);
    const codes: (string | undefined)[] = [];
    for await (const c of h.client.customers.iterate()) codes.push(c.customer_code);
    expect(codes).toEqual(["CUS_example1", "CUS_example2"]);
  });
});

describe("customers.fetch", () => {
  it("GETs /customer/:code", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/customer/:code",
        json: loadFixture("paystack", "customers", "fetch.success"),
      },
    ]);
    const res = await h.client.customers.fetch("CUS_example");
    expect((await h.lastRequest()).path).toBe("/customer/CUS_example");
    expect(res.data.email).toBe("buyer@example.com");
  });

  it("maps 404 to PayweaveNotFoundError", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/customer/:code",
        status: 404,
        json: { status: false, message: "Customer not found" },
      },
    ]);
    await expect(h.client.customers.fetch("CUS_missing")).rejects.toBeInstanceOf(
      PayweaveNotFoundError,
    );
  });
});

describe("customers.update", () => {
  it("PUTs /customer/:code with the update body", async () => {
    h = await makePaystack([
      {
        method: "put",
        url: "https://api.paystack.co/customer/:code",
        json: loadFixture("paystack", "customers", "update.success"),
      },
    ]);
    const res = await h.client.customers.update("CUS_example", { first_name: "Grace" });
    const req = await h.lastRequest();
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/customer/CUS_example");
    expect(req.body).toEqual({ first_name: "Grace" });
    expect(res.data.first_name).toBe("Grace");
  });
});

describe("customers.validate", () => {
  it("POSTs /customer/:code/identification with required fields", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/customer/:code/identification",
        json: loadFixture("paystack", "customers", "validate.success"),
      },
    ]);
    const res = await h.client.customers.validate("CUS_example", {
      country: "NG",
      type: "bank_account",
      account_number: "0000000000",
      bank_code: "011",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/customer/CUS_example/identification");
    expect(req.body).toMatchObject({ country: "NG", type: "bank_account" });
    expect(res.status).toBe(true);
  });
});

describe("customers.setRiskAction", () => {
  it("POSTs /customer/set_risk_action", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/customer/set_risk_action",
        json: loadFixture("paystack", "customers", "set_risk_action.success"),
      },
    ]);
    const res = await h.client.customers.setRiskAction({ customer: "CUS_example", risk_action: "allow" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/customer/set_risk_action");
    expect(req.body).toEqual({ customer: "CUS_example", risk_action: "allow" });
    expect(res.data.risk_action).toBe("allow");
  });
});
