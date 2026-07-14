/**
 * Unified layer (Surface B) — Paystack routing + normalization (PRD §6.2, §11).
 * Asserts outgoing method/path/query/body AND the normalized result, mocking at
 * the network edge with MSW (never stubbing HttpClient/fetch).
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError } from "../../src/core/errors";
import { makePaystackUnified, type UnifiedHarness } from "./_harness";

let h: UnifiedHarness;
afterEach(() => h?.close());

describe("paystack unified.checkout.create", () => {
  it("passes amount through as kobo, echoes the reference, returns checkoutUrl", async () => {
    h = await makePaystackUnified([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ]);

    const res = await h.unified.checkout.create({
      amount: { value: 500000, currency: "NGN" },
      customer: { email: "ada@example.com" },
      reference: "order_8123",
      redirectUrl: "https://app.example.com/cb",
      metadata: { orderId: 8123 },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/transaction/initialize");
    const body = req.body as Record<string, unknown>;
    // Acceptance: Paystack outgoing body carries amount: 500000 (kobo).
    expect(body.amount).toBe(500000);
    expect(body.email).toBe("ada@example.com");
    expect(body.reference).toBe("order_8123");
    expect(body.callback_url).toBe("https://app.example.com/cb");
    expect(body.metadata).toEqual({ orderId: 8123 });

    expect(typeof res.checkoutUrl).toBe("string");
    expect(res.checkoutUrl).toBe("https://checkout.paystack.com/abc123def");
    expect(res.reference).toBe("order_8123");
    expect(res.providerRef).toBe("pwv_test_reference_001");
    expect(res.raw).toBeTruthy();
  });

  it("generates a pwv_ reference when none is supplied", async () => {
    h = await makePaystackUnified([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ]);
    const res = await h.unified.checkout.create({
      amount: { value: 1000, currency: "NGN" },
      customer: { email: "ada@example.com" },
    });
    const req = await h.lastRequest();
    const body = req.body as Record<string, unknown>;
    expect(res.reference).toMatch(/^pwv_[0-9a-f]+$/);
    expect(body.reference).toBe(res.reference);
  });
});

describe("paystack unified.verify", () => {
  it("GETs /transaction/verify/:reference, normalizes status, amount stays in kobo", async () => {
    h = await makePaystackUnified([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/verify/:reference",
        json: loadFixture("paystack", "transactions", "verify.success"),
      },
    ]);

    const res = await h.unified.verify({ reference: "order_8123" });
    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/transaction/verify/order_8123");
    // Acceptance: success reference → status "success", amount in kobo.
    expect(res.status).toBe("success");
    expect(res.amount.value).toBe(500000);
    expect(res.amount.currency).toBe("NGN");
    expect(res.customer.email).toBe("buyer@example.com");
    expect(res.channel).toBe("card");
    expect(res.paidAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("throws PayweaveNotFoundError on a 404 (does not swallow it)", async () => {
    h = await makePaystackUnified([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/verify/:reference",
        status: 404,
        json: loadFixture("paystack", "transactions", "not_found"),
      },
    ]);
    await expect(h.unified.verify({ reference: "missing" })).rejects.toBeInstanceOf(
      PayweaveNotFoundError,
    );
  });
});

describe("paystack unified.refunds.create", () => {
  it("POSTs /refund with transaction=reference and amount in kobo", async () => {
    h = await makePaystackUnified([
      {
        method: "post",
        url: "https://api.paystack.co/refund",
        json: loadFixture("paystack", "refunds", "create.success"),
      },
    ]);
    const res = await h.unified.refunds.create({
      reference: "order_8123",
      amount: { value: 100000, currency: "NGN" },
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/refund");
    const body = req.body as Record<string, unknown>;
    expect(body.transaction).toBe("order_8123");
    expect(body.amount).toBe(100000);
    expect(res.providerRef).toBe("4001");
    expect(res.status).toBe("pending");
    expect(res.raw).toBeTruthy();
  });
});

describe("paystack unified.transfers.create", () => {
  it("creates a recipient, then initiates the transfer with amount in kobo", async () => {
    h = await makePaystackUnified([
      {
        method: "post",
        url: "https://api.paystack.co/transferrecipient",
        json: {
          status: true,
          message: "Recipient created",
          data: { id: 5001, recipient_code: "RCP_example" },
        },
      },
      {
        method: "post",
        url: "https://api.paystack.co/transfer",
        json: loadFixture("paystack", "transfers", "initiate.success"),
      },
    ]);

    const res = await h.unified.transfers.create({
      amount: 500000,
      currency: "NGN",
      recipient: { accountNumber: "0000000000", bankCode: "058", name: "Ada" },
      reason: "Payout",
      reference: "pwv_transfer_ref_001",
    });

    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.path).toBe("/transferrecipient");
    const recBody = reqs[0]!.body as Record<string, unknown>;
    expect(recBody.type).toBe("nuban");
    expect(recBody.account_number).toBe("0000000000");
    expect(recBody.bank_code).toBe("058");

    expect(reqs[1]!.path).toBe("/transfer");
    const trBody = reqs[1]!.body as Record<string, unknown>;
    expect(trBody.source).toBe("balance");
    expect(trBody.amount).toBe(500000);
    expect(trBody.recipient).toBe("RCP_example");
    expect(trBody.reference).toBe("pwv_transfer_ref_001");

    expect(res.reference).toBe("pwv_transfer_ref_001");
    expect(res.providerRef).toBe("TRF_example");
    expect(res.status).toBe("pending");
  });
});

describe("paystack unified.banks", () => {
  it("lists banks by country, normalizing to { name, code, raw }", async () => {
    h = await makePaystackUnified([
      {
        method: "get",
        url: "https://api.paystack.co/bank",
        json: loadFixture("paystack", "misc", "banks.success"),
      },
    ]);
    const banks = await h.unified.banks.list({ country: "nigeria" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/bank");
    expect(req.search.get("country")).toBe("nigeria");
    expect(banks[0]).toMatchObject({ name: "Example Bank", code: "011" });
    expect(banks[0]!.raw).toBeTruthy();
  });

  it("resolves an account to { accountNumber, accountName, raw }", async () => {
    h = await makePaystackUnified([
      {
        method: "get",
        url: "https://api.paystack.co/bank/resolve",
        json: loadFixture("paystack", "misc", "resolve_account.success"),
      },
    ]);
    const res = await h.unified.banks.resolveAccount({
      accountNumber: "0000000000",
      bankCode: "058",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/bank/resolve");
    expect(req.search.get("account_number")).toBe("0000000000");
    expect(req.search.get("bank_code")).toBe("058");
    expect(res.accountNumber).toBe("0000000000");
    expect(res.accountName).toBe("ADA LOVELACE");
  });
});
