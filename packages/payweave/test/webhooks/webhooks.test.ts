import { describe, expect, it } from "vitest";
import { verifyPaystack } from "../../src/webhooks/paystack";
import { verifyFlutterwaveV3 } from "../../src/webhooks/flutterwave";
import { verifyFlutterwaveV4 } from "../../src/webhooks/flutterwave-v4";
import { signWebhook } from "../../src/testing/sign-webhook";

const SECRET = "sk_test_webhook_secret";
const payload = { event: "charge.success", data: { id: 1, status: "success" } };

describe("verifyPaystack (HMAC-SHA512 hex)", () => {
  const signed = signWebhook("paystack", payload, SECRET);

  it("accepts a valid signature", () => {
    expect(verifyPaystack(signed.body, signed.header, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyPaystack(signed.body + " ", signed.header, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyPaystack(signed.body, signed.header, "wrong")).toBe(false);
  });

  it("rejects a missing header (fails closed)", () => {
    expect(verifyPaystack(signed.body, undefined, SECRET)).toBe(false);
    expect(verifyPaystack(signed.body, null, SECRET)).toBe(false);
  });

  it("accepts a Uint8Array raw body", () => {
    const bytes = new TextEncoder().encode(signed.body);
    expect(verifyPaystack(bytes, signed.header, SECRET)).toBe(true);
  });
});

describe("verifyFlutterwaveV3 (plain secret-hash equality)", () => {
  const secret = "flw_dashboard_hash";
  const signed = signWebhook("flutterwave", payload, secret);

  it("accepts the exact secret hash", () => {
    expect(verifyFlutterwaveV3(signed.header, secret)).toBe(true);
  });

  it("rejects a wrong hash and a missing header", () => {
    expect(verifyFlutterwaveV3("nope", secret)).toBe(false);
    expect(verifyFlutterwaveV3(undefined, secret)).toBe(false);
  });
});

describe("verifyFlutterwaveV4 (HMAC-SHA256 base64)", () => {
  const secret = "flw_v4_hash";
  const signed = signWebhook("flutterwave-v4", payload, secret);

  it("accepts a valid signature", () => {
    expect(verifyFlutterwaveV4(signed.body, signed.header, secret)).toBe(true);
  });

  it("rejects tampered body / wrong secret / missing header", () => {
    expect(verifyFlutterwaveV4(signed.body + "x", signed.header, secret)).toBe(false);
    expect(verifyFlutterwaveV4(signed.body, signed.header, "wrong")).toBe(false);
    expect(verifyFlutterwaveV4(signed.body, undefined, secret)).toBe(false);
  });
});
