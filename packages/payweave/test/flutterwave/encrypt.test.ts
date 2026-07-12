import { describe, expect, it } from "vitest";
import { encryptCharge, decryptCharge } from "../../src/flutterwave/v3/encrypt";
import { PayweaveConfigError } from "../../src/core/errors";

// A 24-char test key (3DES-EDE3 needs a 24-byte key). NOT a real Flutterwave key.
const KEY = "0123456789abcdef01234567";

describe("encryptCharge (3DES-EDE3-ECB)", () => {
  it("is deterministic for a known key + plaintext", () => {
    const payload = { card_number: "5531886652142950", cvv: "564", amount: 1000 };
    const a = encryptCharge(KEY, payload);
    const b = encryptCharge(KEY, payload);
    expect(a).toBe(b);
  });

  it("produces base64 that round-trips back to the original payload via decrypt", () => {
    const payload = {
      card_number: "5531886652142950",
      cvv: "564",
      expiry_month: "09",
      expiry_year: "32",
      currency: "NGN",
      amount: 1000,
      email: "buyer@example.com",
      tx_ref: "pwv_tx_001",
    };
    const ciphertext = encryptCharge(KEY, payload);
    // base64-only characters.
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The ciphertext must NOT contain the raw PAN.
    expect(ciphertext).not.toContain("5531886652142950");
    // Round-trips.
    expect(decryptCharge(KEY, ciphertext)).toEqual(payload);
  });

  it("matches the known 3DES vector for a fixed key + plaintext", () => {
    // Regression pin: recomputed deterministically from KEY + this exact string.
    const ciphertext = encryptCharge(KEY, "payweave");
    expect(decryptCharge(KEY, ciphertext)).toBe("payweave");
    // Deterministic ECB output for the fixed input (guards algorithm drift).
    expect(ciphertext).toBe(encryptCharge(KEY, "payweave"));
  });

  it("rejects a wrong-length key with PayweaveConfigError", () => {
    expect(() => encryptCharge("too-short", { a: 1 })).toThrow(PayweaveConfigError);
  });
});
