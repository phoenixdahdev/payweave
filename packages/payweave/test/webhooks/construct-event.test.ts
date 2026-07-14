import { describe, expect, it } from "vitest";
import { createPayweave } from "../../src/index";
import { PayweaveConfigError, PayweaveWebhookVerificationError } from "../../src/core/errors";
import { signWebhook } from "../../src/testing/sign-webhook";
import { createHash } from "node:crypto";

const PS_SECRET = "sk_test_construct";
const FLW_HASH = "flw_dashboard_secret_hash";
const FLW_V4_HASH = "flw_v4_secret_hash";

const psSdk = createPayweave({ paystack: { secretKey: PS_SECRET } });
const flwV3 = createPayweave({
  flutterwave: { secretKey: "FLWSECK_TEST-x", webhookSecret: FLW_HASH },
});
const flwV4 = createPayweave({
  flutterwave: {
    version: "v4",
    clientId: "cid",
    clientSecret: "csecret",
    tokenUrl: "https://auth.example/token",
    webhookSecret: FLW_V4_HASH,
  },
});

// ── Paystack scheme ──────────────────────────────────────────────────────────
describe("constructEvent — Paystack (HMAC-SHA512)", () => {
  const payload = { event: "charge.success", data: { id: 302961, status: "success" } };
  const signed = signWebhook("paystack", payload, PS_SECRET);

  it("valid vector → typed, normalized event", () => {
    const evt = psSdk.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { [signed.headerName]: signed.header },
    });
    expect(evt.provider).toBe("paystack");
    expect(evt.type).toBe("charge.success");
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.data).toEqual(payload.data);
    expect(evt.raw).toEqual(payload);
    expect(evt.id).toBeUndefined();
  });

  it("dedupeKey = sha256(event:data.id:data.status)", () => {
    const evt = psSdk.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { [signed.headerName]: signed.header },
    });
    const expected = createHash("sha256").update("charge.success:302961:success").digest("hex");
    expect(evt.dedupeKey).toBe(expected);
  });

  it("case-variant header name still verifies", () => {
    const evt = psSdk.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { "X-Paystack-SIGNATURE": signed.header },
    });
    expect(evt.unifiedType).toBe("payment.succeeded");
  });

  it("accepts a Uint8Array raw body without re-serializing", () => {
    const evt = psSdk.webhooks.constructEvent({
      rawBody: new TextEncoder().encode(signed.body),
      headers: { [signed.headerName]: signed.header },
    });
    expect(evt.unifiedType).toBe("payment.succeeded");
  });

  it("tampered body → PayweaveWebhookVerificationError", () => {
    expect(() =>
      psSdk.webhooks.constructEvent({
        rawBody: signed.body + " ",
        headers: { [signed.headerName]: signed.header },
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("wrong secret (signed with a different key) → rejected", () => {
    const bad = signWebhook("paystack", payload, "sk_test_other");
    expect(() =>
      psSdk.webhooks.constructEvent({
        rawBody: bad.body,
        headers: { [bad.headerName]: bad.header },
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("missing header → rejected (fail closed)", () => {
    expect(() =>
      psSdk.webhooks.constructEvent({ rawBody: signed.body, headers: {} }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("verified body that is malformed JSON → verification error", () => {
    const junk = "not json at all";
    const s = signWebhook("paystack", junk, PS_SECRET);
    expect(() =>
      psSdk.webhooks.constructEvent({ rawBody: s.body, headers: { [s.headerName]: s.header } }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});

// ── Flutterwave v3 scheme ────────────────────────────────────────────────────
describe("constructEvent — Flutterwave v3 (verif-hash equality)", () => {
  const payload = { event: "charge.completed", data: { id: 99001, status: "successful" } };
  const signed = signWebhook("flutterwave", payload, FLW_HASH);

  it("valid vector → payment.succeeded, dedupeKey = data.id:status", () => {
    const evt = flwV3.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { "verif-hash": signed.header },
    });
    expect(evt.provider).toBe("flutterwave");
    expect(evt.type).toBe("charge.completed");
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.id).toBeUndefined();
    expect(evt.dedupeKey).toBe("99001:successful");
  });

  it("failed status splits to payment.failed", () => {
    const failed = { event: "charge.completed", data: { id: 5, status: "failed" } };
    const s = signWebhook("flutterwave", failed, FLW_HASH);
    const evt = flwV3.webhooks.constructEvent({
      rawBody: s.body,
      headers: { "verif-hash": s.header },
    });
    expect(evt.unifiedType).toBe("payment.failed");
  });

  it("uses webhook `id` for dedupeKey when the payload carries one", () => {
    const withId = { id: "evt_123", event: "charge.completed", data: { id: 7, status: "successful" } };
    const s = signWebhook("flutterwave", withId, FLW_HASH);
    const evt = flwV3.webhooks.constructEvent({
      rawBody: s.body,
      headers: { "verif-hash": s.header },
    });
    expect(evt.id).toBe("evt_123");
    expect(evt.dedupeKey).toBe("evt_123");
  });

  it("case-variant header name still verifies", () => {
    const evt = flwV3.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { "Verif-Hash": signed.header },
    });
    expect(evt.unifiedType).toBe("payment.succeeded");
  });

  it("tampered / wrong-secret / missing header → rejected", () => {
    expect(() =>
      flwV3.webhooks.constructEvent({ rawBody: signed.body, headers: { "verif-hash": "wrong" } }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      flwV3.webhooks.constructEvent({ rawBody: signed.body + "x", headers: { "verif-hash": signed.header } }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      flwV3.webhooks.constructEvent({ rawBody: signed.body, headers: {} }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("missing webhookSecret → PayweaveConfigError (fail closed)", () => {
    const noSecret = createPayweave({ flutterwave: { secretKey: "FLWSECK_TEST-x" } });
    expect(() =>
      noSecret.webhooks.constructEvent({ rawBody: signed.body, headers: { "verif-hash": signed.header } }),
    ).toThrow(PayweaveConfigError);
  });
});

// ── Flutterwave v4 scheme ────────────────────────────────────────────────────
describe("constructEvent — Flutterwave v4 (HMAC-SHA256 base64)", () => {
  const payload = {
    id: "wbk_abc123",
    type: "charge.completed",
    data: { id: "chg_1", status: "succeeded" },
  };
  const signed = signWebhook("flutterwave-v4", payload, FLW_V4_HASH);

  it("valid vector → payment.succeeded, dedupeKey = webhook id", () => {
    const evt = flwV4.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { "flutterwave-signature": signed.header },
    });
    expect(evt.type).toBe("charge.completed");
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.id).toBe("wbk_abc123");
    expect(evt.dedupeKey).toBe("wbk_abc123");
  });

  it("case-variant header name still verifies", () => {
    const evt = flwV4.webhooks.constructEvent({
      rawBody: signed.body,
      headers: { "Flutterwave-Signature": signed.header },
    });
    expect(evt.unifiedType).toBe("payment.succeeded");
  });

  it("tampered / wrong-secret / missing header → rejected", () => {
    expect(() =>
      flwV4.webhooks.constructEvent({
        rawBody: signed.body + "x",
        headers: { "flutterwave-signature": signed.header },
      }),
    ).toThrow(PayweaveWebhookVerificationError);
    const bad = signWebhook("flutterwave-v4", payload, "other_hash");
    expect(() =>
      flwV4.webhooks.constructEvent({
        rawBody: bad.body,
        headers: { "flutterwave-signature": bad.header },
      }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      flwV4.webhooks.constructEvent({ rawBody: signed.body, headers: {} }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});

// ── Version isolation: v3 must reject v4 signatures and vice versa ────────────
describe("constructEvent — version isolation (never accept both)", () => {
  const payload = { id: "wbk_x", type: "charge.completed", data: { id: "chg_9", status: "succeeded" } };

  it("v3 client rejects a v4-signed request", () => {
    const v4signed = signWebhook("flutterwave-v4", payload, FLW_HASH);
    // v4 sends `flutterwave-signature`; the v3 client only reads `verif-hash`.
    expect(() =>
      flwV3.webhooks.constructEvent({
        rawBody: v4signed.body,
        headers: { "flutterwave-signature": v4signed.header },
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("v4 client rejects a v3-signed request", () => {
    const v3signed = signWebhook("flutterwave", payload, FLW_V4_HASH);
    // v3 sends `verif-hash`; the v4 client only reads `flutterwave-signature`.
    expect(() =>
      flwV4.webhooks.constructEvent({
        rawBody: v3signed.body,
        headers: { "verif-hash": v3signed.header },
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});

// ── Unknown events are delivered, never dropped ──────────────────────────────
describe("constructEvent — unknown events are delivered with unifiedType 'unknown'", () => {
  it("Paystack unmapped event is returned, native type preserved", () => {
    const payload = { event: "invoice.create", data: { id: 12, status: "pending" } };
    const s = signWebhook("paystack", payload, PS_SECRET);
    const evt = psSdk.webhooks.constructEvent({
      rawBody: s.body,
      headers: { [s.headerName]: s.header },
    });
    expect(evt.type).toBe("invoice.create");
    expect(evt.unifiedType).toBe("unknown");
    expect(evt.dedupeKey).toBeTruthy();
  });

  it("Flutterwave unmapped event is returned, native type preserved", () => {
    const payload = { event: "brand.new.event", data: { id: 1, status: "successful" } };
    const s = signWebhook("flutterwave", payload, FLW_HASH);
    const evt = flwV3.webhooks.constructEvent({
      rawBody: s.body,
      headers: { "verif-hash": s.header },
    });
    expect(evt.type).toBe("brand.new.event");
    expect(evt.unifiedType).toBe("unknown");
  });
});
