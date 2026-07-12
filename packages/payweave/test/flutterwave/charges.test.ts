import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveConfigError } from "../../src/core/errors";
import type { SdkLogEvent } from "../../src/core/logger";
import { decryptCharge } from "../../src/flutterwave/v3/encrypt";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

const KEY = "0123456789abcdef01234567"; // 24-char test Encryption Key.
const CARD = "5531886652142950";

const cardInput = {
  card_number: CARD,
  cvv: "564",
  expiry_month: "09",
  expiry_year: "32",
  currency: "NGN",
  amount: 1000,
  email: "buyer@example.com",
  tx_ref: "pwv_tx_001",
};

describe("charges.card (3DES-encrypted)", () => {
  it("POSTs /charges?type=card sending ONLY { client } (encrypted), never plaintext PAN", async () => {
    const events: SdkLogEvent[] = [];
    h = await makeFlutterwave(
      [
        {
          method: "post",
          url: "https://api.flutterwave.com/v3/charges",
          json: loadFixture("flutterwave", "charges", "card.success"),
        },
      ],
      { encryptionKey: KEY, logger: (e) => events.push(e) },
    );

    const res = await h.client.charges.card(cardInput);
    const req = await h.lastRequest();

    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/charges");
    expect(req.search.get("type")).toBe("card");
    // Body is exactly { client: <ciphertext> } — nothing else.
    expect(Object.keys(req.body as object)).toEqual(["client"]);
    const client = (req.body as { client: string }).client;
    expect(typeof client).toBe("string");
    // Acceptance: the raw PAN never appears in the serialized outgoing body.
    expect(JSON.stringify(req.body)).not.toContain(CARD);
    // The ciphertext decrypts back to the exact plaintext we passed in.
    expect(decryptCharge(KEY, client)).toEqual(cardInput);
    // Acceptance: the plaintext PAN never appears in ANY captured log event.
    expect(JSON.stringify(events)).not.toContain(CARD);

    expect(res.data.status).toBe("pending");
  });

  it("accepts a per-call encryptionKey override when the client has none", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/charges",
        json: loadFixture("flutterwave", "charges", "card.success"),
      },
    ]);
    await h.client.charges.card(cardInput, { encryptionKey: KEY });
    const req = await h.lastRequest();
    expect((req.body as { client: string }).client).toBeTypeOf("string");
  });

  it("throws PayweaveConfigError when no Encryption Key is available", async () => {
    h = await makeFlutterwave([]); // no encryptionKey threaded
    await expect(h.client.charges.card(cardInput)).rejects.toBeInstanceOf(PayweaveConfigError);
  });
});

describe("charges.bankTransfer / ussd / ngAccount", () => {
  it("bankTransfer POSTs /charges?type=bank_transfer with the plain body", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/charges",
        json: loadFixture("flutterwave", "charges", "bank_transfer.success"),
      },
    ]);
    const res = await h.client.charges.bankTransfer({
      tx_ref: "pwv_tx_002",
      amount: 5000,
      email: "buyer@example.com",
      currency: "NGN",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/charges");
    expect(req.search.get("type")).toBe("bank_transfer");
    expect(req.body).toMatchObject({ tx_ref: "pwv_tx_002", amount: 5000 });
    expect(res.data.payment_type).toBe("bank_transfer");
  });

  it("ussd POSTs /charges?type=ussd", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/charges",
        json: loadFixture("flutterwave", "charges", "ussd.success"),
      },
    ]);
    await h.client.charges.ussd({
      tx_ref: "pwv_tx_003",
      account_bank: "057",
      amount: 1000,
      email: "buyer@example.com",
    });
    const req = await h.lastRequest();
    expect(req.search.get("type")).toBe("ussd");
    expect(req.body).toMatchObject({ account_bank: "057" });
  });

  it("ngAccount POSTs /charges?type=debit_ng_account", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/charges",
        json: loadFixture("flutterwave", "charges", "ng_account.success"),
      },
    ]);
    await h.client.charges.ngAccount({
      tx_ref: "pwv_tx_004",
      account_bank: "044",
      account_number: "0690000031",
      amount: 1000,
      email: "buyer@example.com",
    });
    const req = await h.lastRequest();
    expect(req.search.get("type")).toBe("debit_ng_account");
  });
});

describe("charges.validate", () => {
  it("POSTs /validate-charge with otp + flw_ref", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/validate-charge",
        json: loadFixture("flutterwave", "charges", "validate.success"),
      },
    ]);
    const res = await h.client.charges.validate({
      otp: "12345",
      flw_ref: "FLW-MOCK-abc123",
      type: "card",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/validate-charge");
    expect(req.body).toEqual({ otp: "12345", flw_ref: "FLW-MOCK-abc123", type: "card" });
    expect(res.data.status).toBe("successful");
  });
});
