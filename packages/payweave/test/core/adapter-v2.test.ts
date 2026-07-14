/**
 * the three real providers migrated onto the v2 `ProviderAdapter`
 * contract (`src/{paystack,flutterwave,stripe}/client.ts`'s exported
 * `*Adapter` descriptors). These are additive alongside the direct wiring in
 * `src/index.ts` (unchanged, asserted by the rest of the existing suite) —
 * this file proves each descriptor is itself internally correct: valid
 * `configKey`/`signatureHeader`/`configSchema`, environment inference, HTTP
 * construction, and a full verify→parse→toUnified round trip using real
 * `signWebhook` vectors (never hand-rolled signatures, AGENTS.md §7).
 */
import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/http";
import { PayweaveConfigError } from "../../src/core/errors";
import { resolvePayweaveConfig } from "../../src/core/config";
import { signWebhook } from "../../src/testing/sign-webhook";
import { paystackAdapter } from "../../src/paystack/client";
import { flutterwaveAdapter, createFlutterwaveAdapter } from "../../src/flutterwave/client";
import { stripeAdapter } from "../../src/stripe/client";

describe("paystackAdapter (v2)", () => {
  it("declares configKey/signatureHeader per unified-config.md §7/§5", () => {
    expect(paystackAdapter.id).toBe("paystack");
    expect(paystackAdapter.configKey).toBe("paystack");
    expect(paystackAdapter.webhooks.signatureHeader).toBe("x-paystack-signature");
  });

  it("configSchema accepts a valid config and rejects an empty one", () => {
    expect(paystackAdapter.configSchema.safeParse({ secretKey: "sk_test_x" }).success).toBe(true);
    expect(paystackAdapter.configSchema.safeParse({}).success).toBe(false);
  });

  it("inferEnvironment reads the sk_test_/sk_live_ prefix, null on garbage", () => {
    expect(paystackAdapter.inferEnvironment("sk_test_x")).toBe("test");
    expect(paystackAdapter.inferEnvironment("sk_live_x")).toBe("live");
    expect(paystackAdapter.inferEnvironment("garbage")).toBeNull();
  });

  it("createHttp builds a real HttpClient from a resolved config", () => {
    const resolved = resolvePayweaveConfig({ paystack: { secretKey: "sk_test_x" } });
    const entry = resolved.providerConfigs.paystack;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(paystackAdapter.createHttp(entry)).toBeInstanceOf(HttpClient);
  });

  it("createHttp fails closed without a secretKey", () => {
    const resolved = resolvePayweaveConfig({ paystack: { secretKey: "sk_test_x" } });
    const entry = resolved.providerConfigs.paystack;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(() => paystackAdapter.createHttp({ ...entry, secretKey: undefined })).toThrow(
      PayweaveConfigError,
    );
  });

  it("webhooks: verify + parse + toUnified round trip a mapped event", () => {
    const secret = "sk_test_adapter_ps";
    const payload = { event: "charge.success", data: { id: 1, status: "success" } };
    const signed = signWebhook("paystack", payload, secret);
    expect(
      paystackAdapter.webhooks.verify({ rawBody: signed.body, headers: signed.headers, secret }),
    ).toBe(true);
    const parsed = paystackAdapter.webhooks.parse(signed.body);
    expect(parsed.type).toBe("charge.success");
    const unified = paystackAdapter.webhooks.toUnified(parsed);
    expect(unified.provider).toBe("paystack");
    expect(unified.unifiedType).toBe("payment.succeeded");
  });
});

describe("flutterwaveAdapter (v2, v3 + v4 in one definition — AGENTS.md §11)", () => {
  it("v3 (default): configKey/signatureHeader per §5", () => {
    expect(flutterwaveAdapter.id).toBe("flutterwave");
    expect(flutterwaveAdapter.configKey).toBe("flutterwave");
    expect(flutterwaveAdapter.webhooks.signatureHeader).toBe("verif-hash");
  });

  it("v4: distinct signatureHeader, never shares the v3 scheme", () => {
    const v4Adapter = createFlutterwaveAdapter("v4");
    expect(v4Adapter.webhooks.signatureHeader).toBe("flutterwave-signature");
    expect(v4Adapter.webhooks.signatureHeader).not.toBe(flutterwaveAdapter.webhooks.signatureHeader);
  });

  it("configSchema accepts both v3 and v4 shapes", () => {
    expect(flutterwaveAdapter.configSchema.safeParse({ secretKey: "FLWSECK_TEST-x" }).success).toBe(
      true,
    );
    expect(
      flutterwaveAdapter.configSchema.safeParse({
        version: "v4",
        clientId: "cid",
        clientSecret: "csecret",
      }).success,
    ).toBe(true);
    expect(flutterwaveAdapter.configSchema.safeParse({}).success).toBe(false);
  });

  it("v3 inferEnvironment reads the FLWSECK_TEST-/FLWSECK- prefix", () => {
    expect(flutterwaveAdapter.inferEnvironment("FLWSECK_TEST-x")).toBe("test");
    expect(flutterwaveAdapter.inferEnvironment("FLWSECK-x")).toBe("live");
    expect(flutterwaveAdapter.inferEnvironment("garbage")).toBeNull();
  });

  it("v4 inferEnvironment always returns null (explicit environment, never key-inferred)", () => {
    const v4Adapter = createFlutterwaveAdapter("v4");
    expect(v4Adapter.inferEnvironment("anything")).toBeNull();
  });

  it("createHttp builds a v3 HttpClient from a resolved config", () => {
    const resolved = resolvePayweaveConfig({ flutterwave: { secretKey: "FLWSECK_TEST-x" } });
    const entry = resolved.providerConfigs.flutterwave;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(flutterwaveAdapter.createHttp(entry)).toBeInstanceOf(HttpClient);
  });

  it("createHttp builds a v4 HttpClient (OAuth) from a resolved config", () => {
    const resolved = resolvePayweaveConfig({
      flutterwave: {
        version: "v4",
        clientId: "cid",
        clientSecret: "csecret",
      },
    });
    const entry = resolved.providerConfigs.flutterwave;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const v4Adapter = createFlutterwaveAdapter("v4");
    expect(v4Adapter.createHttp(entry)).toBeInstanceOf(HttpClient);
  });

  it("createHttp fails closed for v4 missing OAuth credentials", () => {
    const resolved = resolvePayweaveConfig({
      flutterwave: { version: "v4", clientId: "cid", clientSecret: "csecret" },
    });
    const entry = resolved.providerConfigs.flutterwave;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const v4Adapter = createFlutterwaveAdapter("v4");
    expect(() => v4Adapter.createHttp({ ...entry, clientId: undefined })).toThrow(
      PayweaveConfigError,
    );
  });

  it("v3 webhooks: verify + parse + toUnified round trip a mapped (status-split) event", () => {
    const secret = "flw_dashboard_hash_adapter";
    const payload = { event: "charge.completed", data: { id: 1, status: "successful" } };
    const signed = signWebhook("flutterwave", payload, secret);
    expect(
      flutterwaveAdapter.webhooks.verify({
        rawBody: signed.body,
        headers: signed.headers,
        secret,
      }),
    ).toBe(true);
    const parsed = flutterwaveAdapter.webhooks.parse(signed.body);
    const unified = flutterwaveAdapter.webhooks.toUnified(parsed);
    expect(unified.unifiedType).toBe("payment.succeeded");
  });

  it("v4 webhooks: verify + parse + toUnified round trip", () => {
    const secret = "flw_v4_hash_adapter";
    const payload = { id: "wbk_1", type: "charge.completed", data: { id: "chg_1", status: "succeeded" } };
    const signed = signWebhook("flutterwave-v4", payload, secret);
    const v4Adapter = createFlutterwaveAdapter("v4");
    expect(
      v4Adapter.webhooks.verify({ rawBody: signed.body, headers: signed.headers, secret }),
    ).toBe(true);
    const parsed = v4Adapter.webhooks.parse(signed.body);
    expect(parsed.id).toBe("wbk_1");
    const unified = v4Adapter.webhooks.toUnified(parsed);
    expect(unified.unifiedType).toBe("payment.succeeded");
  });
});

describe("stripeAdapter (v2)", () => {
  it("declares configKey/signatureHeader per unified-config.md §7/§5", () => {
    expect(stripeAdapter.id).toBe("stripe");
    expect(stripeAdapter.configKey).toBe("stripe");
    expect(stripeAdapter.webhooks.signatureHeader).toBe("stripe-signature");
  });

  it("configSchema accepts a valid config and rejects an empty one", () => {
    expect(stripeAdapter.configSchema.safeParse({ secretKey: "sk_test_x" }).success).toBe(true);
    expect(stripeAdapter.configSchema.safeParse({}).success).toBe(false);
  });

  it("inferEnvironment reads sk_/rk_ test/live prefixes, null on garbage", () => {
    expect(stripeAdapter.inferEnvironment("sk_test_x")).toBe("test");
    expect(stripeAdapter.inferEnvironment("rk_live_x")).toBe("live");
    expect(stripeAdapter.inferEnvironment("garbage")).toBeNull();
  });

  it("createHttp reuses stripeHttpOptions — a real, form-encoding HttpClient", () => {
    const resolved = resolvePayweaveConfig({ stripe: { secretKey: "sk_test_x" } });
    const entry = resolved.providerConfigs.stripe;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(stripeAdapter.createHttp(entry)).toBeInstanceOf(HttpClient);
  });

  it("webhooks: verify + parse + toUnified round trip a mapped event (real unified type, not 'unknown')", () => {
    const secret = "whsec_adapter_test";
    const payload = {
      id: "evt_adapter_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", status: "succeeded" } },
    };
    const signed = signWebhook("stripe", payload, secret);
    expect(
      stripeAdapter.webhooks.verify({ rawBody: signed.body, headers: signed.headers, secret }),
    ).toBe(true);
    const parsed = stripeAdapter.webhooks.parse(signed.body);
    expect(parsed.type).toBe("payment_intent.succeeded");
    expect(parsed.id).toBe("evt_adapter_1");
    const unified = stripeAdapter.webhooks.toUnified(parsed);
    expect(unified.provider).toBe("stripe");
    expect(unified.unifiedType).toBe("payment.succeeded");
  });

  it("webhooks: an unmapped event still normalizes to 'unknown' (never dropped)", () => {
    const secret = "whsec_adapter_test_2";
    const payload = { id: "evt_adapter_2", object: "event", type: "account.updated", data: {} };
    const signed = signWebhook("stripe", payload, secret);
    const parsed = stripeAdapter.webhooks.parse(signed.body);
    const unified = stripeAdapter.webhooks.toUnified(parsed);
    expect(unified.unifiedType).toBe("unknown");
  });
});
