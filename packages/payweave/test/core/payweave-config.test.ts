import { describe, expect, it, vi } from "vitest";
import {
  resolvePayweaveConfig,
  inferEnvironment,
  payweaveConfigSchema,
  stripeProviderConfigSchema,
  PAYWEAVE_PROVIDER_KEYS,
  STRIPE_BASE_URL,
  STRIPE_API_VERSION,
  PAYSTACK_BASE_URL,
  FLW_V3_BASE_URL,
  FLW_V4_BASE_URL,
  FLW_V4_SANDBOX_URL,
} from "../../src/core/config";
import { PayweaveConfigError, PayweaveValidationError } from "../../src/core/errors";
import { feature } from "../../src/products/feature";
import { plan } from "../../src/products/plan";
import { makeStubDatabaseAdapter } from "../db/stub-adapter";

/** Resolve a single-stripe config and return its stripe entry. */
function resolvedStripeEntry(sub: Record<string, unknown>) {
  const resolved = resolvePayweaveConfig({ stripe: { secretKey: "sk_test_x", ...sub } });
  return resolved.providerConfigs.stripe!;
}

/** Capture the thrown error so class AND message can be asserted together. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("inferEnvironment — stripe (PW-501)", () => {
  it("classifies standard and restricted Stripe keys by prefix", () => {
    expect(inferEnvironment("stripe", "sk_test_x")).toBe("test");
    expect(inferEnvironment("stripe", "sk_live_x")).toBe("live");
    expect(inferEnvironment("stripe", "rk_test_x")).toBe("test");
    expect(inferEnvironment("stripe", "rk_live_x")).toBe("live");
  });

  it("throws naming the expected prefixes for an unclassifiable key", () => {
    for (const bad of ["whsec_x", "sk_x", "rk_x", "pk_test_x", ""]) {
      const err = captureError(() => inferEnvironment("stripe", bad));
      expect(err).toBeInstanceOf(PayweaveConfigError);
      expect((err as Error).message).toMatch(/sk_test_.*sk_live_.*rk_test_.*rk_live_/s);
    }
  });
});

describe("resolvePayweaveConfig — rule 1: unknown top-level keys", () => {
  it("rejects a typoed provider key, naming it", () => {
    const err = captureError(() => resolvePayweaveConfig({ stipe: { secretKey: "sk_test_x" } }));
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/stipe/);
  });

  it("rejects unknown keys even alongside a valid provider", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({ paystack: { secretKey: "sk_test_x" }, retries: 3 }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/retries/);
  });

  it("rejects non-object input as a config error", () => {
    expect(() => resolvePayweaveConfig(null)).toThrow(PayweaveConfigError);
    expect(() => resolvePayweaveConfig("nope")).toThrow(PayweaveConfigError);
    expect(() => resolvePayweaveConfig(undefined)).toThrow(PayweaveConfigError);
  });
});

describe("resolvePayweaveConfig — rule 2: at least one provider", () => {
  const EXACT = "configure at least one provider — e.g. createPayweave({ stripe: { secretKey } })";

  it("throws the exact §2 message for an empty config", () => {
    const err = captureError(() => resolvePayweaveConfig({}));
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(EXACT);
  });

  it("throws when only non-provider options are set", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({ defaultCurrency: "USD", timeoutMs: 1000 }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(EXACT);
  });

  it("treats an explicitly-undefined provider key as absent", () => {
    const err = captureError(() => resolvePayweaveConfig({ stripe: undefined }));
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(EXACT);
  });
});

describe("resolvePayweaveConfig — rule 3: defaultProvider", () => {
  it("defaults to the single configured provider (each of the three)", () => {
    expect(resolvePayweaveConfig({ stripe: { secretKey: "sk_test_x" } }).defaultProvider).toBe(
      "stripe",
    );
    expect(resolvePayweaveConfig({ paystack: { secretKey: "sk_test_x" } }).defaultProvider).toBe(
      "paystack",
    );
    expect(
      resolvePayweaveConfig({ flutterwave: { secretKey: "FLWSECK_TEST-x" } }).defaultProvider,
    ).toBe("flutterwave");
  });

  it("throws naming the configured keys when omitted with multiple providers", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        stripe: { secretKey: "sk_test_x" },
        paystack: { secretKey: "sk_test_y" },
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/stripe, paystack/);
    expect((err as Error).message).toMatch(/defaultProvider/);
  });

  it("throws when set to a provider that is not configured", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        defaultProvider: "stripe",
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/defaultProvider "stripe"/);
    expect((err as Error).message).toMatch(/configured: paystack/);
  });

  it("accepts an explicit defaultProvider with multiple providers", () => {
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x" },
      paystack: { secretKey: "sk_test_y" },
      defaultProvider: "paystack",
    });
    expect(resolved.defaultProvider).toBe("paystack");
    expect(resolved.providers).toEqual(["stripe", "paystack"]);
  });
});

describe("resolvePayweaveConfig — rule 4: environment inference per key", () => {
  it("infers per provider key from the key prefix", () => {
    expect(resolvePayweaveConfig({ stripe: { secretKey: "sk_test_x" } }).environment).toBe("test");
    expect(resolvePayweaveConfig({ stripe: { secretKey: "rk_live_x" } }).environment).toBe("live");
    expect(resolvePayweaveConfig({ paystack: { secretKey: "sk_live_x" } }).environment).toBe(
      "live",
    );
    expect(
      resolvePayweaveConfig({ flutterwave: { secretKey: "FLWSECK_TEST-x" } }).environment,
    ).toBe("test");
  });

  it("flutterwave v4 uses its explicit environment (default test) inside the key", () => {
    const test = resolvePayweaveConfig({
      flutterwave: { version: "v4", clientId: "id", clientSecret: "secret" },
    });
    expect(test.environment).toBe("test");
    expect(test.providerConfigs.flutterwave?.baseUrl).toBe(FLW_V4_SANDBOX_URL);

    const live = resolvePayweaveConfig({
      flutterwave: { version: "v4", clientId: "id", clientSecret: "secret", environment: "live" },
    });
    expect(live.environment).toBe("live");
    expect(live.providerConfigs.flutterwave?.baseUrl).toBe(FLW_V4_BASE_URL);
  });

  it("rejects two providers inferring different environments, naming both", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_live_x" },
        stripe: { secretKey: "sk_test_x" },
        defaultProvider: "stripe",
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/mixed environments/);
    expect((err as Error).message).toMatch(/stripe is "test"/);
    expect((err as Error).message).toMatch(/paystack is "live"/);
  });

  it("flutterwave v4 participates in the mixed-env check via its resolved environment", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        stripe: { secretKey: "sk_live_x" },
        // v4 defaults to "test" — mixed with the live stripe key above.
        flutterwave: { version: "v4", clientId: "id", clientSecret: "secret" },
        defaultProvider: "stripe",
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/mixed environments/);
    expect((err as Error).message).toMatch(/stripe is "live"/);
    expect((err as Error).message).toMatch(/flutterwave is "test"/);
  });

  it("rejects an explicit root environment that conflicts with a key's inference", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({ paystack: { secretKey: "sk_live_x" }, environment: "test" }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/environment "test" conflicts/);
    expect((err as Error).message).toMatch(/paystack/);
  });

  it("rejects a root environment overridden into conflict by a sub-config environment", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        flutterwave: {
          version: "v4",
          clientId: "id",
          clientSecret: "secret",
          environment: "live",
        },
        environment: "test",
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/environment "test" conflicts/);
    expect((err as Error).message).toMatch(/flutterwave/);
  });

  it("rejects a per-key environment that conflicts with that key's prefix", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_live_x", environment: "test" },
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/conflicts with the paystack key prefix/);
  });

  it("accepts a matching explicit environment and applies it to v4's default", () => {
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_live_x" },
      flutterwave: { version: "v4", clientId: "id", clientSecret: "secret" },
      defaultProvider: "stripe",
      environment: "live",
    });
    expect(resolved.environment).toBe("live");
    // The root environment flowed into the v4 key as its explicit env.
    expect(resolved.providerConfigs.flutterwave?.environment).toBe("live");
    expect(resolved.providerConfigs.flutterwave?.baseUrl).toBe(FLW_V4_BASE_URL);
  });

  it("rejects an unclassifiable stripe key at the root", () => {
    const err = captureError(() => resolvePayweaveConfig({ stripe: { secretKey: "sk_oops" } }));
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/sk_test_.*sk_live_.*rk_test_.*rk_live_/s);
  });
});

describe("resolvePayweaveConfig — rule 5: products need a database", () => {
  it("throws the §2 message when products are set without a database", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        products: [plan({ id: "pro" })],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe("plans need a database — pass a payweave/db/* adapter");
  });

  it("accepts products together with a database and carries both through", () => {
    // PW-701/PW-802: the loose `{ kind: "prisma" }` / `{ id: "pro" }`
    // placeholder objects no longer pass — the database slot requires a real
    // DatabaseAdapter, and products require real `plan()` output.
    const database = makeStubDatabaseAdapter("prisma");
    const products = [plan({ id: "free" }), plan({ id: "pro" })];
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database,
      products,
    });
    expect(resolved.database).toBe(database);
    expect(resolved.products).toEqual(products);
  });

  it("accepts a database without products", () => {
    const database = makeStubDatabaseAdapter("drizzle");
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database,
    });
    expect(resolved.products).toBeUndefined();
    expect(resolved.database).toBe(database);
  });
});

describe("resolvePayweaveConfig — cross-plan validation + price resolution (§9, §6, PW-802)", () => {
  const database = () => makeStubDatabaseAdapter("sqlite");

  it("rejects duplicate plan ids across the array", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        database: database(),
        products: [plan({ id: "pro" }), plan({ id: "pro" })],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(
      'duplicate plan id "pro" — plan ids must be unique across products (plans-and-features.md §9).',
    );
  });

  it("rejects more than one default: true plan per group, naming both plan ids", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        database: database(),
        products: [
          plan({ id: "free", group: "base", default: true }),
          plan({ id: "starter", group: "base", default: true }),
        ],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(
      'group "base" has more than one default plan ("free" and "starter") — only one plan per ' +
        "group can be default: true (plans-and-features.md §4).",
    );
  });

  it("allows one default per DIFFERENT group", () => {
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database: database(),
      products: [
        plan({ id: "free", group: "base", default: true }),
        plan({ id: "free-seats", group: "seats", default: true }),
      ],
    });
    expect(resolved.products).toHaveLength(2);
  });

  it("rejects a feature id used with conflicting types across plans", () => {
    const messages = feature({ id: "messages", type: "metered" });
    const messagesAsBoolean = feature({ id: "messages", type: "boolean" });
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        database: database(),
        products: [
          plan({ id: "pro", includes: [messages({ limit: 100, reset: "month" })] }),
          plan({ id: "ultra", includes: [messagesAsBoolean()] }),
        ],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(
      'feature "messages" is used as both "metered" (plan "pro") and "boolean" (plan "ultra") — a ' +
        "feature must have the same type everywhere (plans-and-features.md §9).",
    );
  });

  it("allows the SAME feature (same type) reused across plans", () => {
    const messages = feature({ id: "messages", type: "metered" });
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database: database(),
      products: [
        plan({ id: "pro", includes: [messages({ limit: 100, reset: "month" })] }),
        plan({ id: "ultra", includes: [messages({ limit: 1_000, reset: "month" })] }),
      ],
    });
    expect(resolved.products).toHaveLength(2);
  });

  it("rejects a paid plan with neither its own currency nor a configured defaultCurrency", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        database: database(),
        products: [plan({ id: "pro", price: { amount: 19, interval: "month" } })],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe(
      'plan "pro": price has no currency — set price.currency or configure defaultCurrency ' +
        "(plans-and-features.md §6).",
    );
  });

  it("resolves a paid plan's own currency to integer minor units", () => {
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database: database(),
      products: [plan({ id: "pro", price: { amount: 19.99, currency: "USD", interval: "month" } })],
    });
    const [pro] = resolved.products!;
    expect(pro!.price).toEqual({ amount: 1999, currency: "USD", interval: "month" });
    expect(Number.isSafeInteger(pro!.price!.amount)).toBe(true);
  });

  it("falls back to defaultCurrency when the plan omits its own currency", () => {
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database: database(),
      defaultCurrency: "NGN",
      products: [plan({ id: "pro", price: { amount: 5_000, interval: "month" } })],
    });
    const [pro] = resolved.products!;
    expect(pro!.price).toEqual({ amount: 500_000, currency: "NGN", interval: "month" });
  });

  it("a plan's own currency wins over defaultCurrency", () => {
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database: database(),
      defaultCurrency: "NGN",
      products: [plan({ id: "pro", price: { amount: 19, currency: "USD", interval: "month" } })],
    });
    expect(resolved.products![0]!.price!.currency).toBe("USD");
  });

  it("free plans resolve with price: undefined — no currency required", () => {
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      database: database(),
      products: [plan({ id: "free", group: "base", default: true })],
    });
    expect(resolved.products![0]!.price).toBeUndefined();
  });

  it("propagates the money-deviation decimal guard as PayweaveValidationError naming the plan id", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        database: database(),
        products: [plan({ id: "pro", price: { amount: 19.999, currency: "USD", interval: "month" } })],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro": amount 19.999 has more precision than USD allows (2 minor-unit digits)',
    );
  });

  it("propagates the §6 amount-bound violation as PayweaveValidationError naming the plan id", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({
        paystack: { secretKey: "sk_test_x" },
        database: database(),
        products: [plan({ id: "pro", price: { amount: 1_000_000, currency: "USD", interval: "month" } })],
      }),
    );
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro": amount 1000000 USD exceeds the maximum of 999999.99 USD',
    );
  });
});

describe("resolvePayweaveConfig — rule 6: flutterwave version stays inside the key", () => {
  it("defaults to v3 when version is omitted", () => {
    const resolved = resolvePayweaveConfig({
      flutterwave: { secretKey: "FLWSECK_TEST-x", webhookSecret: "hash", encryptionKey: "enc" },
    });
    const flw = resolved.providerConfigs.flutterwave;
    expect(flw?.version).toBe("v3");
    expect(flw?.baseUrl).toBe(FLW_V3_BASE_URL);
    expect(flw?.webhookSecret).toBe("hash");
    expect(flw?.encryptionKey).toBe("enc");
  });

  it("opts into v4 with the OAuth shape and token URL", () => {
    const resolved = resolvePayweaveConfig({
      flutterwave: { version: "v4", clientId: "id", clientSecret: "secret" },
    });
    const flw = resolved.providerConfigs.flutterwave;
    expect(flw?.version).toBe("v4");
    expect(flw?.clientId).toBe("id");
    expect(flw?.clientSecret).toBe("secret");
    expect(flw?.tokenUrl).toBeTruthy();
  });

  it("rejects a v4 key missing its OAuth credentials", () => {
    expect(() => resolvePayweaveConfig({ flutterwave: { version: "v4" } })).toThrow(
      PayweaveConfigError,
    );
  });
});

describe("resolvePayweaveConfig — happy paths & resolved shape", () => {
  it("resolves a single-stripe config per the §9 acceptance criteria", () => {
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x", webhookSecret: "whsec_1", apiVersion: "2026-06-01" },
    });
    expect(resolved.environment).toBe("test");
    expect(resolved.defaultProvider).toBe("stripe");
    expect(resolved.providers).toEqual(["stripe"]);
    expect(resolved.providerConfigs.paystack).toBeUndefined();
    expect(resolved.providerConfigs.flutterwave).toBeUndefined();
    const stripe = resolved.providerConfigs.stripe;
    expect(stripe?.provider).toBe("stripe");
    expect(stripe?.baseUrl).toBe(STRIPE_BASE_URL);
    expect(stripe?.secretKey).toBe("sk_test_x");
    expect(stripe?.webhookSecret).toBe("whsec_1");
    expect(stripe?.apiVersion).toBe("2026-06-01");
    expect(stripe?.timeoutMs).toBe(30_000);
    expect(stripe?.maxRetries).toBe(2);
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.maxRetries).toBe(2);
  });

  it("resolves single paystack/flutterwave keys exactly like the legacy root", () => {
    const paystack = resolvePayweaveConfig({ paystack: { secretKey: "sk_test_abc" } });
    expect(paystack.providerConfigs.paystack?.baseUrl).toBe(PAYSTACK_BASE_URL);
    expect(paystack.providerConfigs.paystack?.provider).toBe("paystack");
    expect(paystack.providerConfigs.paystack?.version).toBeUndefined();

    const flutterwave = resolvePayweaveConfig({ flutterwave: { secretKey: "FLWSECK-x" } });
    expect(flutterwave.environment).toBe("live");
    expect(flutterwave.providerConfigs.flutterwave?.baseUrl).toBe(FLW_V3_BASE_URL);
  });

  it("flows root transport options into every provider; sub-config wins", () => {
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x", timeoutMs: 1_000 },
      paystack: { secretKey: "sk_test_y" },
      defaultProvider: "stripe",
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    expect(resolved.timeoutMs).toBe(5_000);
    expect(resolved.maxRetries).toBe(0);
    expect(resolved.providerConfigs.stripe?.timeoutMs).toBe(1_000);
    expect(resolved.providerConfigs.stripe?.maxRetries).toBe(0);
    expect(resolved.providerConfigs.paystack?.timeoutMs).toBe(5_000);
    expect(resolved.providerConfigs.paystack?.maxRetries).toBe(0);
  });

  it("passes fetch + logger through to the root and each provider", () => {
    const fetchImpl = vi.fn();
    const logger = vi.fn();
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x" },
      fetch: fetchImpl,
      logger,
    });
    expect(resolved.fetch).toBe(fetchImpl);
    expect(resolved.logger).toBe(logger);
    expect(resolved.providerConfigs.stripe?.fetch).toBe(fetchImpl);
    expect(resolved.providerConfigs.stripe?.logger).toBe(logger);
  });

  it("carries defaultCurrency and leaves billing fields undefined by default", () => {
    const resolved = resolvePayweaveConfig({
      paystack: { secretKey: "sk_test_x" },
      defaultCurrency: "NGN",
    });
    expect(resolved.defaultCurrency).toBe("NGN");
    expect(resolved.database).toBeUndefined();
    expect(resolved.products).toBeUndefined();
  });

  it("enforces the HTTPS guard on a stripe baseUrl override", () => {
    expect(() =>
      resolvePayweaveConfig({
        stripe: { secretKey: "sk_test_x", baseUrl: "http://localhost:4000" },
      }),
    ).toThrow(/non-HTTPS/);
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x", baseUrl: "https://mock.local" },
    });
    expect(resolved.providerConfigs.stripe?.baseUrl).toBe("https://mock.local");
  });

  it("carries a Connect accountId into the resolved stripe entry (PW-601)", () => {
    const resolved = resolvePayweaveConfig({
      stripe: { secretKey: "sk_test_x", accountId: "acct_1PWV" },
    });
    expect(resolved.providerConfigs.stripe?.accountId).toBe("acct_1PWV");
    // Absent stays absent — the Stripe-Account header is only sent when set.
    expect(resolvedStripeEntry({}).accountId).toBeUndefined();
    // And an empty accountId is rejected by the schema.
    expect(
      stripeProviderConfigSchema.safeParse({ secretKey: "sk_test_x", accountId: "" }).success,
    ).toBe(false);
  });

  it("pins STRIPE_API_VERSION as a dated Stripe release and leaves apiVersion a passthrough", () => {
    // providers.md §2: the pinned version lives in core/config.ts constants.
    // Format per https://docs.stripe.com/api/versioning (verified 2026-07-12):
    // monthly releases are `YYYY-MM-DD.<major-release-name>`.
    expect(STRIPE_API_VERSION).toBe("2026-06-24.dahlia");
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
    // The default is applied at the header layer (stripeAuth), not here:
    // an omitted apiVersion resolves to undefined so overrides stay explicit.
    expect(resolvedStripeEntry({}).apiVersion).toBeUndefined();
    expect(resolvedStripeEntry({ apiVersion: "2026-01-01.dahlia" }).apiVersion).toBe(
      "2026-01-01.dahlia",
    );
  });

  it("exposes the canonical provider-key order and the strict schema", () => {
    expect(PAYWEAVE_PROVIDER_KEYS).toEqual(["stripe", "paystack", "flutterwave"]);
    // The schema itself is exported for PW-502/PW-608 composition.
    expect(payweaveConfigSchema.safeParse({ paystack: { secretKey: "sk_test_x" } }).success).toBe(
      true,
    );
    expect(payweaveConfigSchema.safeParse({ stipe: {} }).success).toBe(false);
  });
});
