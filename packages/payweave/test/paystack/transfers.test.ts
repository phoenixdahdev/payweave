import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError, PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("transferRecipients.create", () => {
  it("POSTs /transferrecipient", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/transferrecipient",
        json: loadFixture("paystack", "transfer-recipients", "create.success"),
      },
    ]);
    const res = await h.client.transferRecipients.create({
      type: "nuban",
      name: "Ada Lovelace",
      account_number: "0000000000",
      bank_code: "011",
    });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/transferrecipient");
    expect(req.body).toMatchObject({ type: "nuban", account_number: "0000000000" });
    expect(res.data.recipient_code).toBe("RCP_example");
  });

  it("rejects a missing name with PayweaveValidationError", async () => {
    h = await makePaystack([]);
    await expect(
      // @ts-expect-error — intentionally invalid
      h.client.transferRecipients.create({ type: "nuban" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("transferRecipients.list", () => {
  it("GETs /transferrecipient", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transferrecipient",
        json: loadFixture("paystack", "transfer-recipients", "list.success"),
      },
    ]);
    const res = await h.client.transferRecipients.list({ perPage: 50 });
    expect((await h.lastRequest()).path).toBe("/transferrecipient");
    expect(res.data).toHaveLength(2);
  });
});

describe("transfers.initiate", () => {
  it("POSTs /transfer with amount in kobo", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/transfer",
        json: loadFixture("paystack", "transfers", "initiate.success"),
      },
    ]);
    const res = await h.client.transfers.initiate({
      source: "balance",
      amount: 500000,
      recipient: "RCP_example",
    });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/transfer");
    expect(req.body).toEqual({ source: "balance", amount: 500000, recipient: "RCP_example" });
    expect(res.data.transfer_code).toBe("TRF_example");
  });
});

describe("transfers.list + iterate", () => {
  it("iterate() yields every transfer", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transfer",
        json: loadFixture("paystack", "transfers", "list.success"),
      },
    ]);
    const codes: (string | undefined)[] = [];
    for await (const t of h.client.transfers.iterate()) codes.push(t.transfer_code);
    expect(codes).toEqual(["TRF_example1", "TRF_example2"]);
  });
});

describe("transfers.verify", () => {
  it("GETs /transfer/verify/:reference", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transfer/verify/:reference",
        json: loadFixture("paystack", "transfers", "verify.success"),
      },
    ]);
    const res = await h.client.transfers.verify("pwv_transfer_ref_001");
    expect((await h.lastRequest()).path).toBe("/transfer/verify/pwv_transfer_ref_001");
    expect(res.data.status).toBe("success");
  });

  it("maps 404 to PayweaveNotFoundError", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transfer/verify/:reference",
        status: 404,
        json: { status: false, message: "Transfer not found" },
      },
    ]);
    await expect(h.client.transfers.verify("nope")).rejects.toBeInstanceOf(PayweaveNotFoundError);
  });
});

describe("transfers.balance", () => {
  it("GETs /balance", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/balance",
        json: loadFixture("paystack", "transfers", "balance.success"),
      },
    ]);
    const res = await h.client.transfers.balance();
    expect((await h.lastRequest()).path).toBe("/balance");
    expect(res.data[0]?.currency).toBe("NGN");
    expect(res.data[0]?.balance).toBe(12500000);
  });
});
