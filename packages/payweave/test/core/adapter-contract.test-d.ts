/**
 * PW-608 — Adapter contract v2 extension-point proof (providers.md §4,
 * unified-config.md §7). A completely fictional, test-only provider ("acme")
 * registers via `defineProvider` + its OWN `configKey`/`configSchema` with
 * ZERO edits to `core/provider.ts`, `core/config.ts`, or any other core file —
 * this is the backlog PW-608 acceptance criterion: "toy adapter registers via
 * config key without core edits." If satisfying this file ever required
 * touching a core module, THAT would be the bug to fix, not this test
 * (providers.md §4's design bar, quoted in the PW-608 brief).
 *
 * Everything below is built from the same public surface a real third-party
 * package would import: `payweave/core`'s `defineProvider`/`ProviderAdapter`/
 * `readHeader`/`HttpClient`/`bearer`, plus `zod` for its own config schema.
 */
import { describe, it, expectTypeOf } from "vitest";
import { z } from "zod";
import {
  defineProvider,
  readHeader,
  type ProviderAdapter,
  type ProviderEvent,
  type UnifiedEvent,
  type HeaderLookup,
} from "../../src/core/provider";
import { HttpClient, bearer } from "../../src/core/http";
import type { ResolvedProviderConfig, PayweaveProviderKey } from "../../src/core/config";

// ── Acme's own config shape — declared nowhere in `core/config.ts`'s
// `PayweaveConfig` / `PAYWEAVE_PROVIDER_KEYS` union. ─────────────────────────
const acmeConfigSchema = z.object({
  apiKey: z.string().min(1),
  region: z.enum(["us", "eu"]).default("us"),
});
type AcmeConfig = z.input<typeof acmeConfigSchema>;

/**
 * Acme's own `createHttp`. NOTE: `HttpClientOptions.provider` is a separate,
 * closed `PayweaveProvider` union (`core/errors.ts`) used only for internal
 * error-tagging/User-Agent formatting — extending THAT union for arbitrary
 * third-party ids is a distinct (and out-of-scope-for-PW-608) concern from the
 * config-registration extension point this file proves. The v1 toy adapter
 * (`test/core/provider.test.ts`) already established this same precedent by
 * standing in with an existing literal here.
 */
function acmeCreateHttp(cfg: ResolvedProviderConfig): HttpClient {
  return new HttpClient({
    baseUrl: cfg.baseUrl,
    auth: bearer(cfg.secretKey ?? ""),
    provider: "paystack",
  });
}

const acmeAdapter = defineProvider({
  id: "acme",
  configKey: "acme",
  configSchema: acmeConfigSchema,
  environments: {
    test: { baseUrl: "https://sandbox.acme.example" },
    live: { baseUrl: "https://api.acme.example" },
  },
  inferEnvironment: (secretKey) => (secretKey.startsWith("test_") ? "test" : "live"),
  createHttp: acmeCreateHttp,
  webhooks: {
    signatureHeader: "x-acme-signature",
    verify: ({ headers, secret }) => readHeader(headers, "x-acme-signature") === secret,
    parse: (rawBody): ProviderEvent => {
      const root = JSON.parse(rawBody) as Record<string, unknown>;
      return {
        type: typeof root.event === "string" ? root.event : "unknown",
        data: root.data,
        raw: root,
      };
    },
    toUnified: (e): UnifiedEvent => ({
      provider: "acme",
      type: e.type,
      unifiedType: "unknown",
      data: e.data,
      raw: e.raw,
    }),
  },
});

/** A third party's own Surface A shell — mirrors `PaystackClient`/`StripeClient`'s shape. */
class AcmeClient {
  constructor(readonly http: HttpClient) {}
}

function mountAcmeSurface(cfg: ResolvedProviderConfig): AcmeClient {
  return new AcmeClient(acmeAdapter.createHttp(cfg));
}

describe("ProviderAdapter v2 — toy adapter extension point (PW-608)", () => {
  it("a fully third-party adapter satisfies ProviderAdapter as-is", () => {
    expectTypeOf(acmeAdapter).toEqualTypeOf<ProviderAdapter>();
    expectTypeOf(acmeAdapter.configKey).toEqualTypeOf<string>();
    expectTypeOf(acmeAdapter.configSchema).toEqualTypeOf<z.ZodType>();
  });

  it("configKey/configSchema are the third-party's OWN shape, not core's", () => {
    expectTypeOf<AcmeConfig>().toHaveProperty("apiKey");
    expectTypeOf<AcmeConfig>().toHaveProperty("region");
    // "acme" is not — and never needs to become — a member of the core
    // provider-key union; registering it required no change there.
    expectTypeOf(acmeAdapter.configKey).not.toEqualTypeOf<PayweaveProviderKey>();
    // @ts-expect-error — "acme" is not assignable to the core union; proves
    // the union was never touched to accommodate it.
    const _notACoreKey: PayweaveProviderKey = "acme";
    void _notACoreKey;
  });

  it("webhooks.signatureHeader + core's readHeader are enough to detect this provider", () => {
    const headers: HeaderLookup = { "x-acme-signature": "sig-value" };
    expectTypeOf(acmeAdapter.webhooks.signatureHeader).toEqualTypeOf<string>();
    expectTypeOf(readHeader(headers, acmeAdapter.webhooks.signatureHeader)).toEqualTypeOf<
      string | undefined
    >();
  });

  it("Surface A mounts from createHttp alone — no core class needed", () => {
    expectTypeOf(mountAcmeSurface).returns.toEqualTypeOf<AcmeClient>();
  });

  it("unified/billing stay optional — an adapter may implement neither", () => {
    expectTypeOf<ProviderAdapter["unified"]>().toEqualTypeOf<Record<string, unknown> | undefined>();
    expectTypeOf<ProviderAdapter["billing"]>().toEqualTypeOf<Record<string, unknown> | undefined>();
  });
});
