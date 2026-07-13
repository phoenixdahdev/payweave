/**
 * PW-503 — multi-provider webhook header dispatch (unified-config.md §5).
 * Detection on header NAMES only, in front of the existing timing-safe
 * verifiers; every §5 rejection fails closed with
 * `PayweaveWebhookVerificationError`. All vectors are produced by
 * `signWebhook` (AGENTS.md §7) — never hand-rolled.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createPayweave } from "../../src/index";
import { createWebhookDispatch } from "../../src/webhooks/dispatch";
import { resolvePayweaveConfig } from "../../src/core/config";
import {
  PayweaveConfigError,
  PayweaveWebhookVerificationError,
} from "../../src/core/errors";
import { signWebhook } from "../../src/testing/sign-webhook";

const PS_SECRET = "sk_test_ps_dispatch";
const FLW_V3_HASH = "flw_v3_dashboard_hash";
const FLW_V4_HASH = "flw_v4_dashboard_hash";
const STRIPE_KEY = "sk_test_stripe_dispatch";
const WHSEC = "whsec_dispatch_secret";

// ── Clients ──────────────────────────────────────────────────────────────────
const stripeOnly = createPayweave({
  stripe: { secretKey: STRIPE_KEY, webhookSecret: WHSEC },
});
const paystackOnly = createPayweave({ paystack: { secretKey: PS_SECRET } });
/** stripe + paystack + flutterwave v3 — three of the four schemes on one client. */
const trioV3 = createPayweave({
  stripe: { secretKey: STRIPE_KEY, webhookSecret: WHSEC },
  paystack: { secretKey: PS_SECRET },
  flutterwave: { secretKey: "FLWSECK_TEST-dispatch", webhookSecret: FLW_V3_HASH },
  defaultProvider: "paystack",
});
/** stripe + paystack + flutterwave v4 — the fourth scheme (v3/v4 never share a client). */
const trioV4 = createPayweave({
  stripe: { secretKey: STRIPE_KEY, webhookSecret: WHSEC },
  paystack: { secretKey: PS_SECRET },
  flutterwave: { version: "v4", clientId: "cid", clientSecret: "cs", webhookSecret: FLW_V4_HASH },
  defaultProvider: "stripe",
});

// ── signWebhook vectors ──────────────────────────────────────────────────────
const psPayload = { event: "charge.success", data: { id: 302961, status: "success" } };
const psSigned = signWebhook("paystack", psPayload, PS_SECRET);

const flwV3Payload = { event: "charge.completed", data: { id: 99001, status: "successful" } };
const flwV3Signed = signWebhook("flutterwave", flwV3Payload, FLW_V3_HASH);

const flwV4Payload = {
  id: "wbk_abc123",
  type: "charge.completed",
  data: { id: "chg_1", status: "succeeded" },
};
const flwV4Signed = signWebhook("flutterwave-v4", flwV4Payload, FLW_V4_HASH);

const stripePayload = {
  id: "evt_1QDispatch",
  object: "event",
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_123", status: "succeeded" } },
};
const stripeSigned = signWebhook("stripe", stripePayload, WHSEC);

// ── §5 routing: each header dispatches to its own verifier ──────────────────
describe("dispatch — routes each provider's vector to its own verifier (§5 table)", () => {
  it("x-paystack-signature → paystack on a three-provider client", () => {
    expect(
      trioV3.webhooks.verify({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).toBe(true);
    const evt = trioV3.webhooks.constructEvent({
      rawBody: psSigned.body,
      headers: psSigned.headers,
    });
    expect(evt.provider).toBe("paystack");
    expect(evt.type).toBe("charge.success");
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.dedupeKey).toBe(
      createHash("sha256").update("charge.success:302961:success").digest("hex"),
    );
  });

  it("verif-hash → flutterwave v3 on a three-provider client", () => {
    expect(
      trioV3.webhooks.verify({ rawBody: flwV3Signed.body, headers: flwV3Signed.headers }),
    ).toBe(true);
    const evt = trioV3.webhooks.constructEvent({
      rawBody: flwV3Signed.body,
      headers: flwV3Signed.headers,
    });
    expect(evt.provider).toBe("flutterwave");
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.dedupeKey).toBe("99001:successful");
  });

  it("flutterwave-signature → flutterwave v4 on a v4-configured client", () => {
    expect(
      trioV4.webhooks.verify({ rawBody: flwV4Signed.body, headers: flwV4Signed.headers }),
    ).toBe(true);
    const evt = trioV4.webhooks.constructEvent({
      rawBody: flwV4Signed.body,
      headers: flwV4Signed.headers,
    });
    expect(evt.provider).toBe("flutterwave");
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.id).toBe("wbk_abc123");
    expect(evt.dedupeKey).toBe("wbk_abc123");
  });

  it("stripe-signature → stripe on both multi-provider clients", () => {
    for (const client of [trioV3, trioV4]) {
      expect(
        client.webhooks.verify({ rawBody: stripeSigned.body, headers: stripeSigned.headers }),
      ).toBe(true);
      const evt = client.webhooks.constructEvent({
        rawBody: stripeSigned.body,
        headers: stripeSigned.headers,
      });
      expect(evt.provider).toBe("stripe");
    }
  });

  it("paystack still verifies on the v4 trio (routing is per-request, not per-client)", () => {
    expect(
      trioV4.webhooks.verify({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).toBe(true);
    expect(
      trioV4.webhooks.constructEvent({ rawBody: psSigned.body, headers: psSigned.headers })
        .provider,
    ).toBe("paystack");
  });

  it("verifyOrThrow: valid vector passes; tampered body throws", () => {
    expect(() =>
      trioV3.webhooks.verifyOrThrow({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).not.toThrow();
    expect(() =>
      trioV3.webhooks.verifyOrThrow({ rawBody: psSigned.body + "x", headers: psSigned.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});

// ── Case-insensitive header lookup (matches getHeader behavior) ─────────────
describe("dispatch — case-variant header names verify", () => {
  it("X-Paystack-SIGNATURE", () => {
    const headers = { "X-Paystack-SIGNATURE": psSigned.header };
    expect(trioV3.webhooks.verify({ rawBody: psSigned.body, headers })).toBe(true);
    expect(
      trioV3.webhooks.constructEvent({ rawBody: psSigned.body, headers }).provider,
    ).toBe("paystack");
  });

  it("Verif-HASH", () => {
    const headers = { "Verif-HASH": flwV3Signed.header };
    expect(trioV3.webhooks.verify({ rawBody: flwV3Signed.body, headers })).toBe(true);
  });

  it("FLUTTERWAVE-SIGNATURE", () => {
    const headers = { "FLUTTERWAVE-SIGNATURE": flwV4Signed.header };
    expect(trioV4.webhooks.verify({ rawBody: flwV4Signed.body, headers })).toBe(true);
  });

  it("Stripe-Signature", () => {
    const headers = { "Stripe-Signature": stripeSigned.header };
    expect(stripeOnly.webhooks.verify({ rawBody: stripeSigned.body, headers })).toBe(true);
  });

  it("WHATWG Headers instance detects and verifies", () => {
    const headers = new Headers({ "Stripe-Signature": stripeSigned.header });
    expect(stripeOnly.webhooks.verify({ rawBody: stripeSigned.body, headers })).toBe(true);
    expect(
      stripeOnly.webhooks.constructEvent({ rawBody: stripeSigned.body, headers }).provider,
    ).toBe("stripe");
  });

  it("array header values use the first element", () => {
    const headers = { "x-paystack-signature": [psSigned.header] };
    expect(trioV3.webhooks.verify({ rawBody: psSigned.body, headers })).toBe(true);
  });
});

// ── §9 criterion 4 (verbatim) ────────────────────────────────────────────────
describe("§9 criterion 4 — Paystack-signed webhook against a stripe-only client", () => {
  it("constructEvent throws PayweaveWebhookVerificationError (real signWebhook vector)", () => {
    expect(() =>
      stripeOnly.webhooks.constructEvent({
        rawBody: psSigned.body,
        headers: psSigned.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("verify and verifyOrThrow reject identically (fail closed, no fall-through)", () => {
    expect(() =>
      stripeOnly.webhooks.verify({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      stripeOnly.webhooks.verifyOrThrow({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).toThrow(/not configured/);
  });
});

// ── §5 rule: header for an unconfigured provider ─────────────────────────────
describe("dispatch — unconfigured-provider header fails closed (never falls through)", () => {
  it("stripe-signature on a paystack-only client rejects a VALID stripe vector", () => {
    expect(() =>
      paystackOnly.webhooks.constructEvent({
        rawBody: stripeSigned.body,
        headers: stripeSigned.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      paystackOnly.webhooks.verify({
        rawBody: stripeSigned.body,
        headers: stripeSigned.headers,
      }),
    ).toThrow(/stripe is not configured/);
  });

  it("verif-hash on a stripe-only client", () => {
    expect(() =>
      stripeOnly.webhooks.constructEvent({
        rawBody: flwV3Signed.body,
        headers: flwV3Signed.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("flutterwave-signature on a paystack-only client", () => {
    expect(() =>
      paystackOnly.webhooks.constructEvent({
        rawBody: flwV4Signed.body,
        headers: flwV4Signed.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("x-paystack-signature on a stripe+flutterwave client (no paystack key)", () => {
    const noPaystack = createPayweave({
      stripe: { secretKey: STRIPE_KEY, webhookSecret: WHSEC },
      flutterwave: { secretKey: "FLWSECK_TEST-dispatch", webhookSecret: FLW_V3_HASH },
      defaultProvider: "stripe",
    });
    expect(() =>
      noPaystack.webhooks.constructEvent({
        rawBody: psSigned.body,
        headers: psSigned.headers,
      }),
    ).toThrow(/paystack is not configured/);
  });
});

// ── §5 rule: multiple known signature headers ────────────────────────────────
describe("dispatch — multiple known signature headers reject (ambiguous, likely forged)", () => {
  it("rejects even when BOTH signatures would verify on their own", () => {
    // Sign the SAME body with both configured schemes — individually valid.
    const stripeOverPsBody = signWebhook("stripe", psSigned.body, WHSEC);
    const headers = {
      "x-paystack-signature": psSigned.header,
      "stripe-signature": stripeOverPsBody.header,
    };
    expect(() =>
      trioV3.webhooks.verify({ rawBody: psSigned.body, headers }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      trioV3.webhooks.constructEvent({ rawBody: psSigned.body, headers }),
    ).toThrow(/[Aa]mbiguous/);
  });

  it("rejects both flutterwave headers on one request", () => {
    const headers = {
      "verif-hash": flwV3Signed.header,
      "flutterwave-signature": flwV4Signed.header,
    };
    expect(() =>
      trioV3.webhooks.constructEvent({ rawBody: flwV3Signed.body, headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("rejects when only one of the two headers' providers is configured", () => {
    const headers = {
      "x-paystack-signature": psSigned.header,
      "stripe-signature": "t=1,v1=deadbeef",
    };
    expect(() =>
      paystackOnly.webhooks.verify({ rawBody: psSigned.body, headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});

// ── §5 rule: no known signature header ───────────────────────────────────────
describe("dispatch — no known signature header rejects", () => {
  it("empty headers", () => {
    expect(() =>
      trioV3.webhooks.constructEvent({ rawBody: psSigned.body, headers: {} }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      trioV3.webhooks.verify({ rawBody: psSigned.body, headers: {} }),
    ).toThrow(/No known webhook signature header/);
  });

  it("only unrelated headers", () => {
    const headers = { "content-type": "application/json", "x-signature": "abc" };
    expect(() =>
      trioV3.webhooks.constructEvent({ rawBody: psSigned.body, headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("an explicitly-undefined known header counts as absent", () => {
    const headers: Record<string, string | undefined> = { "stripe-signature": undefined };
    expect(() =>
      stripeOnly.webhooks.verify({ rawBody: stripeSigned.body, headers }),
    ).toThrow(/No known webhook signature header/);
  });
});

// ── Flutterwave version isolation (AGENTS.md rule 11) ────────────────────────
describe("dispatch — flutterwave version isolation", () => {
  it("a v3-configured client rejects the v4 header (flutterwave-signature)", () => {
    const v4WithV3Hash = signWebhook("flutterwave-v4", flwV4Payload, FLW_V3_HASH);
    expect(() =>
      trioV3.webhooks.constructEvent({
        rawBody: v4WithV3Hash.body,
        headers: v4WithV3Hash.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
    expect(() =>
      trioV3.webhooks.verify({ rawBody: v4WithV3Hash.body, headers: v4WithV3Hash.headers }),
    ).toThrow(/own version's scheme/);
  });

  it("a v4-configured client rejects the v3 header (verif-hash)", () => {
    const v3WithV4Hash = signWebhook("flutterwave", flwV3Payload, FLW_V4_HASH);
    expect(() =>
      trioV4.webhooks.constructEvent({
        rawBody: v3WithV4Hash.body,
        headers: v3WithV4Hash.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("also applies on a flutterwave-only client", () => {
    const flwV3Only = createPayweave({
      flutterwave: { secretKey: "FLWSECK_TEST-dispatch", webhookSecret: FLW_V3_HASH },
    });
    expect(() =>
      flwV3Only.webhooks.verify({ rawBody: flwV4Signed.body, headers: flwV4Signed.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });
});

// ── Negative suite per provider: tampered body / wrong secret ────────────────
describe("dispatch — tampered bodies and wrong secrets fail per provider", () => {
  it("paystack: tampered body and wrong-secret vector", () => {
    expect(
      trioV3.webhooks.verify({ rawBody: psSigned.body + "x", headers: psSigned.headers }),
    ).toBe(false);
    expect(() =>
      trioV3.webhooks.constructEvent({ rawBody: psSigned.body + "x", headers: psSigned.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
    const wrongSecret = signWebhook("paystack", psPayload, "sk_test_other");
    expect(
      trioV3.webhooks.verify({ rawBody: wrongSecret.body, headers: wrongSecret.headers }),
    ).toBe(false);
  });

  it("flutterwave v3: wrong hash header and tampered body", () => {
    expect(
      trioV3.webhooks.verify({ rawBody: flwV3Signed.body, headers: { "verif-hash": "wrong" } }),
    ).toBe(false);
    const wrongSecret = signWebhook("flutterwave", flwV3Payload, "other_dashboard_hash");
    expect(
      trioV3.webhooks.verify({ rawBody: wrongSecret.body, headers: wrongSecret.headers }),
    ).toBe(false);
    // v3's scheme does not sign the body; a tampered body still dies in the
    // normalizer because the exact received bytes are what gets parsed.
    expect(() =>
      trioV3.webhooks.constructEvent({
        rawBody: flwV3Signed.body + "x",
        headers: flwV3Signed.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("flutterwave v4: tampered body and wrong secret", () => {
    expect(
      trioV4.webhooks.verify({ rawBody: flwV4Signed.body + "x", headers: flwV4Signed.headers }),
    ).toBe(false);
    const wrongSecret = signWebhook("flutterwave-v4", flwV4Payload, "other_hash");
    expect(
      trioV4.webhooks.verify({ rawBody: wrongSecret.body, headers: wrongSecret.headers }),
    ).toBe(false);
    expect(() =>
      trioV4.webhooks.constructEvent({
        rawBody: flwV4Signed.body + "x",
        headers: flwV4Signed.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("stripe: tampered body and wrong signing secret", () => {
    expect(
      stripeOnly.webhooks.verify({
        rawBody: stripeSigned.body + "x",
        headers: stripeSigned.headers,
      }),
    ).toBe(false);
    const wrongSecret = signWebhook("stripe", stripePayload, "whsec_other");
    expect(
      stripeOnly.webhooks.verify({ rawBody: wrongSecret.body, headers: wrongSecret.headers }),
    ).toBe(false);
    expect(() =>
      stripeOnly.webhooks.constructEvent({
        rawBody: stripeSigned.body + "x",
        headers: stripeSigned.headers,
      }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("stripe: stale timestamp outside tolerance rejects at the dispatcher level", () => {
    const stale = signWebhook("stripe", stripePayload, WHSEC, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(stripeOnly.webhooks.verify({ rawBody: stale.body, headers: stale.headers })).toBe(
      false,
    );
    expect(() =>
      stripeOnly.webhooks.constructEvent({ rawBody: stale.body, headers: stale.headers }),
    ).toThrow(PayweaveWebhookVerificationError);
  });

  it("an empty-string signature header is detected but fails verification (closed)", () => {
    expect(
      stripeOnly.webhooks.verify({
        rawBody: stripeSigned.body,
        headers: { "stripe-signature": "" },
      }),
    ).toBe(false);
  });
});

// ── Missing webhook secrets fail closed at verify time ───────────────────────
describe("dispatch — missing webhook secret → PayweaveConfigError (fail closed)", () => {
  it("stripe configured without webhookSecret", () => {
    const noWhsec = createPayweave({ stripe: { secretKey: STRIPE_KEY } });
    expect(() =>
      noWhsec.webhooks.verify({ rawBody: stripeSigned.body, headers: stripeSigned.headers }),
    ).toThrow(PayweaveConfigError);
    expect(() =>
      noWhsec.webhooks.constructEvent({
        rawBody: stripeSigned.body,
        headers: stripeSigned.headers,
      }),
    ).toThrow(/webhookSecret/);
  });

  it("flutterwave v3 configured without webhookSecret", () => {
    const noHash = createPayweave({ flutterwave: { secretKey: "FLWSECK_TEST-dispatch" } });
    expect(() =>
      noHash.webhooks.verify({ rawBody: flwV3Signed.body, headers: flwV3Signed.headers }),
    ).toThrow(PayweaveConfigError);
  });

  it("flutterwave v4 configured without webhookSecret", () => {
    const noHash = createPayweave({
      flutterwave: { version: "v4", clientId: "cid", clientSecret: "cs" },
    });
    expect(() =>
      noHash.webhooks.constructEvent({ rawBody: flwV4Signed.body, headers: flwV4Signed.headers }),
    ).toThrow(PayweaveConfigError);
  });

  it("paystack entry stripped of every secret (dynamic caller) throws PayweaveConfigError", () => {
    // Unreachable through `createPayweave` (the schema requires `secretKey`);
    // the dispatcher still guards it for hand-built resolved configs.
    const resolved = resolvePayweaveConfig({ paystack: { secretKey: PS_SECRET } });
    const entry = resolved.providerConfigs.paystack;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const dispatch = createWebhookDispatch({
      ...resolved,
      providerConfigs: {
        paystack: { ...entry, secretKey: undefined, webhookSecret: undefined },
      },
    });
    expect(() =>
      dispatch.verify({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).toThrow(PayweaveConfigError);
    expect(() =>
      dispatch.verify({ rawBody: psSigned.body, headers: psSigned.headers }),
    ).toThrow(/Missing Paystack secret key/);
  });
});

// ── Stripe events through constructEvent (PW-608: real unified types) ───────
describe("dispatch — stripe constructEvent normalization (PW-608: unified/mappings.ts)", () => {
  it("provider 'stripe', native type preserved, unifiedType mapped via STRIPE_EVENT_MAP, dedupeKey = evt id", () => {
    const evt = stripeOnly.webhooks.constructEvent({
      rawBody: stripeSigned.body,
      headers: stripeSigned.headers,
    });
    expect(evt.provider).toBe("stripe");
    expect(evt.type).toBe("payment_intent.succeeded");
    // "payment_intent.succeeded" is a mapped STRIPE_EVENT_MAP row (unified/mappings.ts) —
    // PW-608 wires webhooks/index.ts's constructEvent through the SAME table
    // every other provider uses, so this is no longer "unknown".
    expect(evt.unifiedType).toBe("payment.succeeded");
    expect(evt.id).toBe("evt_1QDispatch");
    expect(evt.dedupeKey).toBe("evt_1QDispatch");
    expect(evt.data).toEqual(stripePayload.data);
    expect(evt.raw).toEqual(stripePayload);
  });

  it("falls back to a hashed dedupeKey when the event id is missing (defensive)", () => {
    const noId = { object: "event", type: "charge.refunded", data: { object: {} } };
    const signed = signWebhook("stripe", noId, WHSEC);
    const evt = stripeOnly.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    expect(evt.id).toBeUndefined();
    expect(evt.dedupeKey).toBe(
      createHash("sha256").update("charge.refunded::").digest("hex"),
    );
  });

  it("accepts a Uint8Array raw body without re-serializing", () => {
    const bytes = new TextEncoder().encode(stripeSigned.body);
    const evt = stripeOnly.webhooks.constructEvent({
      rawBody: bytes,
      headers: stripeSigned.headers,
    });
    expect(evt.provider).toBe("stripe");
    expect(evt.unifiedType).toBe("payment.succeeded");
  });

  it("unmapped stripe event still falls through to unifiedType 'unknown' (never dropped)", () => {
    const payload = {
      id: "evt_unmapped_1",
      object: "event",
      type: "account.updated",
      data: { object: { id: "acct_1" } },
    };
    const signed = signWebhook("stripe", payload, WHSEC);
    const evt = stripeOnly.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    expect(evt.provider).toBe("stripe");
    expect(evt.type).toBe("account.updated");
    expect(evt.unifiedType).toBe("unknown");
    expect(evt.dedupeKey).toBe("evt_unmapped_1");
  });

  it("status-split stripe event resolves via the nested data.object field", () => {
    // checkout.session.completed splits on `data.object.payment_status`
    // (STRIPE_EVENT_STATUS_SPLIT_MAP) — "paid" normalizes to payment.succeeded.
    const payload = {
      id: "evt_checkout_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", payment_status: "paid" } },
    };
    const signed = signWebhook("stripe", payload, WHSEC);
    const evt = stripeOnly.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    expect(evt.unifiedType).toBe("payment.succeeded");
  });
});
