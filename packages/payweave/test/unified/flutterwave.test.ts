/**
 * Unified layer (Surface B) — Flutterwave v3 routing + minor↔major conversion
 * (PRD §6.2, §11). Asserts outgoing method/path/query/body AND the normalized
 * result, mocking at the network edge with MSW (never stubbing HttpClient/fetch).
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError } from "../../src/core/errors";
import { makeFlutterwaveUnified, type UnifiedHarness } from "./_harness";

let h: UnifiedHarness;
afterEach(() => h?.close());

describe("flutterwave unified.checkout.create", () => {
  it("converts minor→major on the outgoing body, echoes the reference", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/payments",
        json: loadFixture("flutterwave", "payments", "create.success"),
      },
    ]);

    const res = await h.unified.checkout.create({
      amount: { value: 500000, currency: "NGN" },
      customer: { email: "ada@example.com", name: "Ada", phone: "0800" },
      reference: "order_8123",
      redirectUrl: "https://app.example.com/cb",
      metadata: { orderId: 8123 },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/payments");
    const body = req.body as Record<string, unknown>;
    // Acceptance (PRD §11): Flutterwave outgoing body carries amount: 5000 (major).
    expect(body.amount).toBe(5000);
    expect(body.tx_ref).toBe("order_8123");
    expect(body.redirect_url).toBe("https://app.example.com/cb");
    expect(body.meta).toEqual({ orderId: 8123 });
    expect(body.customer).toEqual({
      email: "ada@example.com",
      name: "Ada",
      phonenumber: "0800",
    });

    expect(typeof res.checkoutUrl).toBe("string");
    expect(res.checkoutUrl).toBe(
      "https://checkout.flutterwave.com/v3/hosted/pay/pwv_test_link_001",
    );
    expect(res.reference).toBe("order_8123");
    expect(res.providerRef).toBe("order_8123");
  });

  it("generates a pwv_ reference when none is supplied", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/payments",
        json: loadFixture("flutterwave", "payments", "create.success"),
      },
    ]);
    const res = await h.unified.checkout.create({
      amount: { value: 100000, currency: "NGN" },
      customer: { email: "ada@example.com" },
    });
    const req = await h.lastRequest();
    const body = req.body as Record<string, unknown>;
    expect(res.reference).toMatch(/^pwv_[0-9a-f]+$/);
    expect(body.tx_ref).toBe(res.reference);
  });
});

describe("flutterwave unified.verify", () => {
  it("GETs verify_by_reference and converts the major amount back to minor units", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/verify_by_reference",
        json: loadFixture("flutterwave", "transactions", "verify_by_reference.success"),
      },
    ]);

    const res = await h.unified.verify({ reference: "pwv_tx_001" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transactions/verify_by_reference");
    expect(req.search.get("tx_ref")).toBe("pwv_tx_001");
    expect(res.status).toBe("success");
    // fixture amount is 5000 (major NGN) → 500000 minor units.
    expect(res.amount.value).toBe(500000);
    expect(res.amount.currency).toBe("NGN");
    expect(res.customer.email).toBe("buyer@example.com");
    expect(res.channel).toBe("card");
  });

  it("keeps a 0-exponent currency integer (major == minor)", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/verify_by_reference",
        json: {
          status: "success",
          message: "Transaction fetched successfully",
          data: {
            id: 42,
            tx_ref: "pwv_xof_001",
            amount: 1000,
            currency: "XOF",
            status: "successful",
            payment_type: "card",
            customer: { email: "cfa@example.com" },
          },
        },
      },
    ]);
    const res = await h.unified.verify({ reference: "pwv_xof_001" });
    // XOF is 0-exponent: 1000 major stays 1000 minor (no ×100).
    expect(res.amount.value).toBe(1000);
    expect(res.amount.currency).toBe("XOF");
  });

  it("throws PayweaveNotFoundError on a 404", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/verify_by_reference",
        status: 404,
        json: loadFixture("flutterwave", "transactions", "not_found"),
      },
    ]);
    await expect(h.unified.verify({ reference: "missing" })).rejects.toBeInstanceOf(
      PayweaveNotFoundError,
    );
  });
});

describe("flutterwave unified.refunds.create", () => {
  it("resolves tx_ref→id then POSTs /transactions/:id/refund with a major amount", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/verify_by_reference",
        json: loadFixture("flutterwave", "transactions", "verify_by_reference.success"),
      },
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/transactions/:id/refund",
        json: loadFixture("flutterwave", "refunds", "create.success"),
      },
    ]);

    const res = await h.unified.refunds.create({
      reference: "pwv_tx_001",
      amount: { value: 100000, currency: "NGN" },
    });

    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.path).toBe("/v3/transactions/verify_by_reference");
    // fixture id is 288200108.
    expect(reqs[1]!.path).toBe("/v3/transactions/288200108/refund");
    const body = reqs[1]!.body as Record<string, unknown>;
    expect(body.amount).toBe(1000); // 100000 minor → 1000 major
    expect(res.providerRef).toBe("15221");
    expect(res.status).toBe("completed");
  });
});

describe("flutterwave unified.transfers.create", () => {
  it("POSTs /transfers with account details and a major amount", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/transfers",
        json: loadFixture("flutterwave", "transfers", "create.success"),
      },
    ]);

    const res = await h.unified.transfers.create({
      amount: 500000,
      currency: "NGN",
      recipient: { accountNumber: "0690000040", bankCode: "044", name: "Jane Doe" },
      reason: "Payout",
      reference: "pwv_transfer_001",
    });

    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transfers");
    const body = req.body as Record<string, unknown>;
    expect(body.account_bank).toBe("044");
    expect(body.account_number).toBe("0690000040");
    expect(body.amount).toBe(5000); // 500000 minor → 5000 major
    expect(body.narration).toBe("Payout");
    expect(body.beneficiary_name).toBe("Jane Doe");
    expect(body.reference).toBe("pwv_transfer_001");

    expect(res.reference).toBe("pwv_transfer_001");
    expect(res.providerRef).toBe("27494");
    // "NEW" is not in the status map → defaults to pending (never throws).
    expect(res.status).toBe("pending");
  });
});

describe("flutterwave unified.banks", () => {
  it("lists banks by country via /banks/:country", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/banks/:country",
        json: loadFixture("flutterwave", "banks", "list.success"),
      },
    ]);
    const banks = await h.unified.banks.list({ country: "NG" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/banks/NG");
    expect(banks[0]).toMatchObject({ name: "ACCESS BANK NIGERIA", code: "044" });
  });

  it("resolves an account via POST /accounts/resolve", async () => {
    h = await makeFlutterwaveUnified([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/accounts/resolve",
        json: loadFixture("flutterwave", "banks", "resolve.success"),
      },
    ]);
    const res = await h.unified.banks.resolveAccount({
      accountNumber: "0690000040",
      bankCode: "044",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/accounts/resolve");
    const body = req.body as Record<string, unknown>;
    expect(body.account_number).toBe("0690000040");
    expect(body.account_bank).toBe("044");
    expect(res.accountNumber).toBe("0690000040");
    expect(res.accountName).toBe("Jane Doe");
  });
});
