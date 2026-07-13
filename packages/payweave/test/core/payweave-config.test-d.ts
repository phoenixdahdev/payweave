import { describe, it, expectTypeOf } from "vitest";
import type {
  PayweaveConfig,
  PayweaveProviderKey,
  StripeProviderConfig,
  PaystackProviderConfig,
  FlutterwaveProviderConfig,
  ResolvedPayweaveConfig,
  ResolvedProviderConfig,
} from "../../src/core/config";
import { plan } from "../../src/products/plan";
import { makeStubDatabaseAdapter } from "../db/stub-adapter";

// Freshness-checked assignment target — object literals with unknown or
// mistyped keys fail to compile here (full §4 client narrowing is PW-502).
const acceptConfig = (config: PayweaveConfig): PayweaveConfig => config;

describe("provider-keyed config input shape (PW-501)", () => {
  it("accepts single-provider configs for each key", () => {
    expectTypeOf({ stripe: { secretKey: "sk_test_x" } }).toExtend<PayweaveConfig>();
    expectTypeOf({ paystack: { secretKey: "sk_test_x" } }).toExtend<PayweaveConfig>();
    expectTypeOf({ flutterwave: { secretKey: "FLWSECK_TEST-x" } }).toExtend<PayweaveConfig>();
    acceptConfig({
      stripe: { secretKey: "sk_test_x", webhookSecret: "whsec_x", apiVersion: "2026-06-01" },
    });
  });

  it("accepts multi-provider configs with defaultProvider and common options", () => {
    acceptConfig({
      stripe: { secretKey: "sk_test_x" },
      paystack: { secretKey: "sk_test_y" },
      defaultProvider: "stripe",
      defaultCurrency: "USD",
      timeoutMs: 5_000,
      maxRetries: 1,
      environment: "test",
      // PW-701: the database slot now requires the real DatabaseAdapter type.
      database: makeStubDatabaseAdapter("prisma"),
      // PW-802: the products slot now requires real `plan()` output, not a
      // loose plan-shaped object literal.
      products: [plan({ id: "pro" })],
    });
  });

  it("keeps the flutterwave version discriminator inside the key", () => {
    acceptConfig({ flutterwave: { secretKey: "FLWSECK_TEST-x" } });
    acceptConfig({ flutterwave: { version: "v4", clientId: "id", clientSecret: "s" } });
    // The keyed shape has no `provider` discriminator anywhere.
    expectTypeOf<FlutterwaveProviderConfig>().not.toHaveProperty("provider");
    expectTypeOf<PaystackProviderConfig>().not.toHaveProperty("provider");
  });

  it("rejects unknown top-level keys at compile time", () => {
    // @ts-expect-error — typo of `stripe` is not a config key
    acceptConfig({ stipe: { secretKey: "sk_test_x" } });
  });

  it("types defaultProvider to the provider-key union", () => {
    expectTypeOf<PayweaveProviderKey>().toEqualTypeOf<"stripe" | "paystack" | "flutterwave">();
    expectTypeOf<PayweaveConfig["defaultProvider"]>().toEqualTypeOf<
      PayweaveProviderKey | undefined
    >();
    // @ts-expect-error — defaultProvider must be a known provider key
    acceptConfig({ paystack: { secretKey: "sk_test_x" }, defaultProvider: "stipe" });
  });

  it("shapes the stripe sub-config per providers.md §2", () => {
    expectTypeOf<StripeProviderConfig["secretKey"]>().toEqualTypeOf<string>();
    expectTypeOf<StripeProviderConfig["webhookSecret"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<StripeProviderConfig["apiVersion"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<StripeProviderConfig["accountId"]>().toEqualTypeOf<string | undefined>();
    acceptConfig({ stripe: { secretKey: "sk_test_x", accountId: "acct_1" } });
    // @ts-expect-error — secretKey is required
    acceptConfig({ stripe: { webhookSecret: "whsec_x" } });
  });

  it("resolves to the shape PW-502 consumes", () => {
    expectTypeOf<ResolvedPayweaveConfig["defaultProvider"]>().toEqualTypeOf<PayweaveProviderKey>();
    expectTypeOf<ResolvedPayweaveConfig["environment"]>().toEqualTypeOf<"test" | "live">();
    expectTypeOf<ResolvedPayweaveConfig["providers"]>().toEqualTypeOf<
      readonly PayweaveProviderKey[]
    >();
    expectTypeOf<ResolvedPayweaveConfig["providerConfigs"]>().toEqualTypeOf<
      Readonly<Partial<Record<PayweaveProviderKey, ResolvedProviderConfig>>>
    >();
    expectTypeOf<ResolvedProviderConfig["provider"]>().toEqualTypeOf<PayweaveProviderKey>();
    expectTypeOf<ResolvedProviderConfig["environment"]>().toEqualTypeOf<"test" | "live">();
  });

  it("types products as real plan() output, not a loose plan-shaped object (PW-802)", () => {
    acceptConfig({
      paystack: { secretKey: "sk_test_x" },
      database: makeStubDatabaseAdapter("sqlite"),
      products: [plan({ id: "free", group: "base", default: true }), plan({ id: "pro", group: "base" })],
    });
    acceptConfig({
      paystack: { secretKey: "sk_test_x" },
      database: makeStubDatabaseAdapter("sqlite"),
      // @ts-expect-error — a raw plain object is not a plan() output.
      products: [{ id: "pro" }],
    });
  });
});
