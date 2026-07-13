/**
 * Payweave — one SDK, every provider, woven together.
 *
 * Public facade: the v1 entry point `createPayweave` (`PayweaveClient`,
 * unified-config.md §3–§4, PW-502) with config-key-presence narrowing, plus the
 * legacy `createPaystack` / `createFlutterwave` / callable-or-`new` `PaymentSDK`
 * factories (TDD §7.1) — since PW-504 all three are thin deprecation aliases
 * that delegate to `createPayweave` (unified-config.md §6) and are removed at
 * v1.0.0 (PW-1101).
 */
import { PayweaveError, PayweaveConfigError, type PayweaveProvider } from "./core/errors";
import {
  resolvePayweaveConfig,
  type ResolvedConfig,
  type SDKConfig,
  type PaystackConfig,
  type FlutterwaveConfig,
  type FlutterwaveV3Config,
  type FlutterwaveV4Config,
  type PaystackProviderConfig,
  type PayweaveConfig,
  type PayweaveProviderKey,
  type ResolvedProduct,
} from "./core/config";
import { HttpClient, bearer, oauthClientCredentials, type AuthStrategy } from "./core/http";
import type { Logger } from "./core/logger";
import type { HeaderLookup } from "./core/provider";
import { SDK_VERSION } from "./core/version";
import type { WebhookEvent } from "./webhooks/index";
import { createWebhookDispatch } from "./webhooks/dispatch";
import { PaystackClient } from "./paystack/client";
import { FlutterwaveClient } from "./flutterwave/client";
import { StripeClient } from "./stripe/client";
import { stripeHttpOptions } from "./stripe/http-options";
import type { DatabaseAdapter, PwSubscription } from "./db/index";
import type { FeatureType } from "./products/index";
import {
  subscribe as billingSubscribe,
  type BillingContext,
  type SubscribeInput as BillingSubscribeInput,
} from "./products/subscribe";
// PW-803 — BillingSync (`payweave.sync()`, plans-and-features.md §12). Kept as
// its own import statement (rather than folded into the subscribe import
// above) so this addition stays a single, easily-mergeable diff hunk.
import { sync as billingSync, type SyncResult } from "./products/sync";
import {
  check as billingCheck,
  report as billingReport,
  type CheckInput as BillingCheckInput,
  type ReportInput as BillingReportInput,
} from "./products/usage";
import {
  createPaystackUnified,
  createFlutterwaveUnified,
  UNIFIED_CAPABILITY_MATRIX,
  assertUnifiedCapability,
  type UnifiedNamespace,
  type CheckoutCreateInput,
  type CheckoutCreateResult,
  type VerifyInput,
  type VerifyResult,
  type RefundCreateInput,
  type RefundCreateResult,
  type TransferCreateInput,
  type TransferCreateResult,
  type BanksListInput,
  type UnifiedBank,
  type ResolveAccountInput,
  type ResolvedAccountResult,
  type UnifiedOpName,
  type UnifiedOpCapability,
} from "./unified/index";

export { SDK_VERSION as VERSION } from "./core/version";

// Re-export the unified-layer (Surface B) op types so consumers can type their
// unified integration code (PRD §6.2).
export type {
  UnifiedNamespace,
  CheckoutCreateInput,
  CheckoutCreateResult,
  VerifyInput,
  VerifyResult,
  RefundCreateInput,
  RefundCreateResult,
  TransferRecipient,
  TransferCreateInput,
  TransferCreateResult,
  BanksListInput,
  UnifiedBank,
  ResolveAccountInput,
  ResolvedAccountResult,
  UnifiedAmount,
  UnifiedCustomer,
  UnifiedCustomerInput,
  // Capability matrix (providers.md §3.3, PW-607) — the shape `capabilities()` returns.
  UnifiedOpName,
  UnifiedOpCapability,
} from "./unified/index";

// Re-export the config types + core errors consumers need to type their code.
export type {
  SDKConfig,
  PaystackConfig,
  FlutterwaveConfig,
  FlutterwaveV3Config,
  FlutterwaveV4Config,
  ResolvedConfig,
  // Provider-keyed root (v1, unified-config.md §2) — what `createPayweave` takes.
  PayweaveConfig,
  PayweaveProviderKey,
  StripeProviderConfig,
  PaystackProviderConfig,
  FlutterwaveProviderConfig,
  ResolvedPayweaveConfig,
  ResolvedProviderConfig,
  // Cross-plan-validated, minor-units-resolved `products` (PW-802).
  ResolvedProduct,
} from "./core/config";
export {
  PayweaveError,
  PayweaveConfigError,
  PayweaveAuthError,
  PayweaveValidationError,
  PayweaveNotFoundError,
  PayweaveRateLimitError,
  PayweaveProviderError,
  PayweaveNetworkError,
  PayweaveWebhookVerificationError,
} from "./core/errors";
export type { Money } from "./core/money";
export { PaystackClient } from "./paystack/client";
export { FlutterwaveClient } from "./flutterwave/client";
export { StripeClient } from "./stripe/client";
export type { WebhookEvent } from "./webhooks/index";

// ── Products (plans-and-features.md §1–§8, §9) ──────────────────────────────
// `feature`/`plan` re-exported from the package root (deferred by PW-505 to
// whoever wired `products` into `createPayweave` — PW-802). Full domain
// surface (period math, `resolvePlanPricing`, …) stays on the
// `payweave/products` subpath; only the two definition primitives + the types
// needed to type a hand-written `products.ts` are duplicated here.
export { feature, plan } from "./products/index";
export type {
  BooleanFeatureInclusion,
  FeatureDef,
  FeatureDefInput,
  FeatureFn,
  FeatureInclusion,
  FeatureType,
  MeteredFeatureArg,
  MeteredFeatureInclusion,
  Plan,
  PlanDefInput,
  PlanPrice,
  PlanPriceInput,
  ResolvedPlanPrice,
} from "./products/index";

// `payweave.sync()`'s result shape (plans-and-features.md §12, PW-803) — see
// `./products/sync` for the full `BillingSync` engine this re-exports from.
export type { SyncResult, SyncPlanResult, SyncProviderAction } from "./products/sync";

// ── Webhooks namespace ───────────────────────────────────────────────────────
/** Raw-body + headers input shared by every webhook operation (TDD §10). */
export interface WebhookInput {
  /** Exact received bytes — never a re-serialized object. */
  rawBody: string | Uint8Array;
  /** `Headers` or a plain/array header map; looked up case-insensitively. */
  headers: HeaderLookup;
}

/**
 * The `payweave.webhooks` surface (and, since PW-504, the `sdk.webhooks`
 * surface of the deprecated aliases, which delegate to the same PW-503
 * multi-provider dispatch — byte-identical verification for a single-provider
 * client's own signature header).
 */
export interface WebhooksNamespace {
  /** Verify a webhook signature (timing-safe, fails closed). */
  verify(input: WebhookInput): boolean;
  /** Verify or throw {@link PayweaveWebhookVerificationError}. */
  verifyOrThrow(input: WebhookInput): void;
  /** Verify + parse + normalize into a typed {@link WebhookEvent}. */
  constructEvent(input: WebhookInput): WebhookEvent;
}

// ── HTTP wiring ──────────────────────────────────────────────────────────────
/**
 * What the transport builders need: the legacy {@link ResolvedConfig} and the
 * keyed root's per-provider {@link ResolvedProviderConfig} are both this shape,
 * so `createPayweave` reuses the exact same wiring per configured provider.
 */
type ResolvedTransportConfig = Omit<ResolvedConfig, "provider"> & { provider: PayweaveProvider };

function buildAuth(resolved: ResolvedTransportConfig): AuthStrategy {
  if (resolved.provider === "flutterwave" && resolved.version === "v4") {
    if (!resolved.clientId || !resolved.clientSecret || !resolved.tokenUrl) {
      throw new PayweaveConfigError("Flutterwave v4 requires clientId, clientSecret, and a token URL.", {
        provider: "flutterwave",
      });
    }
    return oauthClientCredentials({
      clientId: resolved.clientId,
      clientSecret: resolved.clientSecret,
      tokenUrl: resolved.tokenUrl,
      ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
      ...(resolved.logger ? { logger: resolved.logger } : {}),
    });
  }
  if (!resolved.secretKey) {
    throw new PayweaveConfigError(`Missing secret key for ${resolved.provider}.`, {
      provider: resolved.provider,
    });
  }
  return bearer(resolved.secretKey);
}

function buildHttpClient(resolved: ResolvedTransportConfig): HttpClient {
  return new HttpClient({
    baseUrl: resolved.baseUrl,
    auth: buildAuth(resolved),
    provider: resolved.provider,
    version: resolved.version,
    timeoutMs: resolved.timeoutMs,
    maxRetries: resolved.maxRetries,
    fetch: resolved.fetch,
    logger: resolved.logger,
    userAgent: `payweave/${SDK_VERSION} (${resolved.provider})`,
  });
}

// ── Deprecated legacy facade (PW-504, unified-config.md §6) ──────────────────
// The three legacy factories and the concrete SDK classes below are thin
// wrappers over `createPayweave`: the factory maps its config onto the
// provider-keyed shape (§6 migration table), delegates, then adds the legacy
// root props (`provider`, and `version` for Flutterwave) the delegating client
// deliberately lacks. Every namespace on the wrapper IS the delegated
// client's — same HttpClient wiring, same unified ops, same PW-503 webhook
// dispatch. All of it is removed at v1.0.0 (PW-1101).

/**
 * Module-level once-latch shared by ALL deprecation aliases: at most ONE
 * deprecation event per process, across every alias and every call (§6 +
 * backlog AC, strict global reading). The latch trips on the first alias CALL;
 * the event goes through THAT call's injected `logger` only — with no logger
 * configured, nothing is emitted anywhere (never `console.*`, AGENTS.md §2).
 * Tests isolate the latch via `vi.resetModules()` + dynamic import.
 */
let legacyDeprecationLatch = false;

/** Emit the one-per-process deprecation event through the tripping call's logger. */
function emitLegacyDeprecation(alias: string, replacement: string, cfg: unknown): void {
  if (legacyDeprecationLatch) return;
  legacyDeprecationLatch = true;
  const logger =
    typeof cfg === "object" && cfg !== null ? (cfg as { logger?: unknown }).logger : undefined;
  if (typeof logger !== "function") return;
  (logger as Logger)({
    type: "warn",
    message:
      `${alias} is deprecated and will be removed at v1.0.0 — ` +
      `use ${replacement} instead (unified-config.md §6).`,
    deprecated: alias,
    replacement,
  });
}

/** The keyed config a `createPaystack(cfg)` call delegates to (§6 table). */
type PaystackAliasKeyedConfig = { paystack: PaystackProviderConfig };
/** The keyed config a v3 `createFlutterwave(cfg)` call delegates to (§6 table). */
type FlutterwaveV3AliasKeyedConfig = { flutterwave: Omit<FlutterwaveV3Config, "provider"> };
/** The keyed config a v4 `createFlutterwave(cfg)` call delegates to (§6 table). */
type FlutterwaveV4AliasKeyedConfig = { flutterwave: Omit<FlutterwaveV4Config, "provider"> };

/**
 * Legacy Paystack SDK surface: the delegated `PayweaveClient` plus the legacy
 * root `provider` discriminator. No `version` (Paystack is unversioned, PRD
 * §6.1). Declaration-merged with the class below so `instanceof PaystackSDK`
 * keeps working for alias-built SDKs.
 *
 * @deprecated Superseded by `PayweaveClient` (unified-config.md §7) — construct
 * through `createPayweave({ paystack: { ... } })`. Removed at v1.0.0 (PW-1101).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- deliberate: the constructor `Object.assign`s the delegated client, so every merged-interface member exists at runtime.
export interface PaystackSDK extends PayweaveClient<PaystackAliasKeyedConfig> {
  /** Legacy root discriminator — not present on `PayweaveClient`. */
  readonly provider: "paystack";
}

/**
 * @deprecated Superseded by `PayweaveClient` (unified-config.md §7) — construct
 * through `createPayweave({ paystack: { ... } })`. Removed at v1.0.0 (PW-1101).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the merged interface above.
export class PaystackSDK {
  readonly provider = "paystack" as const;

  constructor(client: PayweaveClient<PaystackAliasKeyedConfig>) {
    Object.assign(this, client);
  }
}

/**
 * Legacy Flutterwave v3 SDK surface: the delegated `PayweaveClient` plus the
 * legacy root `provider` + `version` props (the namespace-level
 * `flutterwave.version` comes from the delegated client itself).
 *
 * @deprecated Superseded by `PayweaveClient` (unified-config.md §7) — construct
 * through `createPayweave({ flutterwave: { ... } })`. Removed at v1.0.0 (PW-1101).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- deliberate: the constructor `Object.assign`s the delegated client, so every merged-interface member exists at runtime.
export interface FlutterwaveV3SDK extends PayweaveClient<FlutterwaveV3AliasKeyedConfig> {
  /** Legacy root discriminator — not present on `PayweaveClient`. */
  readonly provider: "flutterwave";
  /** Legacy root version — the delegated client only carries `flutterwave.version`. */
  readonly version: "v3";
}

/**
 * @deprecated Superseded by `PayweaveClient` (unified-config.md §7) — construct
 * through `createPayweave({ flutterwave: { ... } })`. Removed at v1.0.0 (PW-1101).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the merged interface above.
export class FlutterwaveV3SDK {
  readonly provider = "flutterwave" as const;
  readonly version = "v3" as const;

  constructor(client: PayweaveClient<FlutterwaveV3AliasKeyedConfig>) {
    Object.assign(this, client);
  }
}

/**
 * Legacy Flutterwave v4 SDK surface: the delegated `PayweaveClient` plus the
 * legacy root `provider` + `version` props. The `flutterwave` namespace is the
 * honest v4 type ({@link FlutterwaveV4Client}) — the runtime never mounted the
 * v3-only resources for v4 (TDD §11 version isolation).
 *
 * @deprecated Superseded by `PayweaveClient` (unified-config.md §7) — construct
 * through `createPayweave({ flutterwave: { version: "v4", ... } })`. Removed at
 * v1.0.0 (PW-1101).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- deliberate: the constructor `Object.assign`s the delegated client, so every merged-interface member exists at runtime.
export interface FlutterwaveV4SDK extends PayweaveClient<FlutterwaveV4AliasKeyedConfig> {
  /** Legacy root discriminator — not present on `PayweaveClient`. */
  readonly provider: "flutterwave";
  /** Legacy root version — the delegated client only carries `flutterwave.version`. */
  readonly version: "v4";
}

/**
 * @deprecated Superseded by `PayweaveClient` (unified-config.md §7) — construct
 * through `createPayweave({ flutterwave: { version: "v4", ... } })`. Removed at
 * v1.0.0 (PW-1101).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the merged interface above.
export class FlutterwaveV4SDK {
  readonly provider = "flutterwave" as const;
  readonly version = "v4" as const;

  constructor(client: PayweaveClient<FlutterwaveV4AliasKeyedConfig>) {
    Object.assign(this, client);
  }
}

/**
 * Union of the concrete Flutterwave surfaces.
 * @deprecated Removed at v1.0.0 with the legacy facade (PW-1101).
 */
export type FlutterwaveSDK = FlutterwaveV3SDK | FlutterwaveV4SDK;

/**
 * Map a config type to its concrete SDK surface at compile time (TDD §7.1).
 * A `const` generic on the factories preserves inline literals so this resolves
 * without `as const`.
 * @deprecated Narrowing now comes from config-key presence on
 * `createPayweave` (unified-config.md §4). Removed at v1.0.0 (PW-1101).
 */
export type PaymentSDKFor<C extends SDKConfig> = C extends { provider: "paystack" }
  ? PaystackSDK
  : C extends { provider: "flutterwave"; version: "v4" }
    ? FlutterwaveV4SDK
    : C extends { provider: "flutterwave" }
      ? FlutterwaveV3SDK
      : never;

/**
 * Narrow a `createFlutterwave` config to v3 or v4.
 * @deprecated Removed at v1.0.0 with the legacy facade (PW-1101).
 */
export type FlutterwaveSDKFor<C> = C extends { version: "v4" }
  ? FlutterwaveV4SDK
  : FlutterwaveV3SDK;

/** `Omit` that distributes over unions, preserving each member's own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Create a Paystack SDK.
 *
 * @deprecated Since PW-504 this is a thin alias that delegates to
 * `createPayweave` (unified-config.md §6) and is removed at v1.0.0 (PW-1101).
 * Replace with:
 * ```ts
 * import { createPayweave } from "payweave";
 * const payweave = createPayweave({ paystack: { secretKey } });
 * ```
 * Behavior is identical (§9): `sdk.paystack.*`, `sdk.unified.*` (now also on
 * the client root), and `sdk.webhooks.*` all keep working.
 */
export function createPaystack<const C extends Omit<PaystackConfig, "provider">>(
  cfg: C,
): PaystackSDK {
  emitLegacyDeprecation("createPaystack()", "createPayweave({ paystack: { ... } })", cfg);
  // §6 table: `createPaystack(cfg)` → `createPayweave({ paystack: cfg })`.
  // C is bounded by (and structurally equal to) PaystackProviderConfig; pinning
  // the literal type keeps the delegated client type at the alias's keyed shape.
  const client = createPayweave({ paystack: cfg as PaystackProviderConfig });
  return new PaystackSDK(client);
}

/**
 * Create a Flutterwave SDK (v3 unless `version: "v4"`).
 *
 * @deprecated Since PW-504 this is a thin alias that delegates to
 * `createPayweave` (unified-config.md §6) and is removed at v1.0.0 (PW-1101).
 * Replace with:
 * ```ts
 * import { createPayweave } from "payweave";
 * const payweave = createPayweave({ flutterwave: { secretKey } });          // v3
 * const payweaveV4 = createPayweave({ flutterwave: { version: "v4", clientId, clientSecret } });
 * ```
 * The `version` discriminator keeps narrowing the surface exactly as before
 * (§4 assertion 3); behavior is identical (§9).
 */
export function createFlutterwave<const C extends DistributiveOmit<FlutterwaveConfig, "provider">>(
  cfg: C,
): FlutterwaveSDKFor<C> {
  emitLegacyDeprecation("createFlutterwave()", "createPayweave({ flutterwave: { ... } })", cfg);
  // §6 table: `createFlutterwave(cfg)` → `createPayweave({ flutterwave: cfg })`;
  // rule 6 keeps the v3/v4 discriminator INSIDE the key, so the config passes
  // through unchanged and only the wrapper class is picked per version.
  const wrapped =
    cfg.version === "v4"
      ? new FlutterwaveV4SDK(
          createPayweave({ flutterwave: cfg as Omit<FlutterwaveV4Config, "provider"> }),
        )
      : new FlutterwaveV3SDK(
          createPayweave({ flutterwave: cfg as Omit<FlutterwaveV3Config, "provider"> }),
        );
  return wrapped as FlutterwaveSDKFor<C>;
}

/**
 * Callable-or-`new` SDK factory with provider narrowing (TDD §7.1).
 * @deprecated Removed at v1.0.0 with `PaymentSDK` (PW-1101).
 */
export interface PaymentSDKFactory {
  <const C extends SDKConfig>(cfg: C): PaymentSDKFor<C>;
  new <const C extends SDKConfig>(cfg: C): PaymentSDKFor<C>;
}

/**
 * The legacy headline entry point. Works called or `new`'d; the return type
 * narrows to the configured provider's surface.
 *
 * @deprecated Since PW-504 this is a thin alias that delegates to
 * `createPayweave` (unified-config.md §6) and is removed at v1.0.0 (PW-1101).
 * The `provider` discriminator becomes the config KEY — replace with:
 * ```ts
 * import { createPayweave } from "payweave";
 * // new PaymentSDK({ provider: "paystack", secretKey })  becomes:
 * const payweave = createPayweave({ paystack: { secretKey } });
 * ```
 */
export const PaymentSDK: PaymentSDKFactory = function PaymentSDK<const C extends SDKConfig>(
  cfg: C,
): PaymentSDKFor<C> {
  emitLegacyDeprecation("PaymentSDK()", "createPayweave({ <provider>: { ... } })", cfg);
  // §6 table: `new PaymentSDK({ provider, ...cfg })` → `createPayweave({ [provider]: cfg })`.
  const legacy = cfg as SDKConfig;
  if (legacy.provider === "paystack") {
    const { provider, ...rest } = legacy;
    void provider;
    const client = createPayweave({ paystack: rest as PaystackProviderConfig });
    return new PaystackSDK(client) as unknown as PaymentSDKFor<C>;
  }
  if (legacy.version === "v4") {
    const { provider, ...rest } = legacy;
    void provider;
    const client = createPayweave({ flutterwave: rest as Omit<FlutterwaveV4Config, "provider"> });
    return new FlutterwaveV4SDK(client) as unknown as PaymentSDKFor<C>;
  }
  const { provider, ...rest } = legacy;
  void provider;
  const client = createPayweave({ flutterwave: rest as Omit<FlutterwaveV3Config, "provider"> });
  return new FlutterwaveV3SDK(client) as unknown as PaymentSDKFor<C>;
} as PaymentSDKFactory;

// ═════════════════════════════════════════════════════════════════════════════
// createPayweave — the v1 unified entry point (unified-config.md §3–§4, PW-502).
// Providers are config KEYS; narrowing comes from key PRESENCE, not a
// `provider` discriminator. The legacy factories above are deprecation aliases
// that delegate here (PW-504).
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Provider keys actually configured (present and not `undefined`) on a config
 * `C` — the union `defaultProvider`, per-call `provider` overrides, and the
 * mounted Surface A namespaces are all typed from (§4).
 */
export type ConfiguredProvider<C extends PayweaveConfig> = {
  [K in PayweaveProviderKey]: C extends Record<K, object> ? K : never;
}[PayweaveProviderKey];

/** Per-call routing override accepted by every unified op on the client root (§3). */
export interface ProviderOverride<P extends PayweaveProviderKey = PayweaveProviderKey> {
  /** Route THIS call to a specific configured provider instead of `defaultProvider`. */
  provider?: P;
}

/**
 * The unified ops (Surface B) as they appear on the `PayweaveClient` ROOT: the
 * {@link UnifiedNamespace} signatures widened with a per-call `provider`
 * override typed to the CONFIGURED keys only (§4 assertion 2).
 */
export interface PayweaveUnifiedOps<P extends PayweaveProviderKey = PayweaveProviderKey> {
  checkout: {
    create(input: CheckoutCreateInput & ProviderOverride<P>): Promise<CheckoutCreateResult>;
  };
  verify(input: VerifyInput & ProviderOverride<P>): Promise<VerifyResult>;
  refunds: {
    create(input: RefundCreateInput & ProviderOverride<P>): Promise<RefundCreateResult>;
  };
  transfers: {
    create(input: TransferCreateInput & ProviderOverride<P>): Promise<TransferCreateResult>;
  };
  banks: {
    list(input: BanksListInput & ProviderOverride<P>): Promise<UnifiedBank[]>;
    resolveAccount(
      input: ResolveAccountInput & ProviderOverride<P>,
    ): Promise<ResolvedAccountResult>;
  };
}

/** The Surface A namespace at `payweave.flutterwave` when `version` is omitted or `"v3"`. */
export type FlutterwaveV3Client = FlutterwaveClient & { readonly version: "v3" };

/**
 * The Surface A namespace at `payweave.flutterwave` for `version: "v4"`
 * configs. v4 resources are a later wave (TDD §11: v3/v4 are version-isolated,
 * never shared), so today this exposes only the shared transport — the type
 * deliberately hides the v3-only resource fields the class leaves unmounted at
 * runtime for v4.
 */
export type FlutterwaveV4Client = Pick<FlutterwaveClient, "http"> & { readonly version: "v4" };

// ── Billing surface type inference (plans-and-features.md §10, PW-802) ──────
// `products` becomes type-safe through these three extraction types: every
// plan id, every feature id, and feature ids narrowed to one `type` (powers
// `report`'s metered-only compile-time guard). All three resolve to `never`
// when `C` has no `products` key at all — `never` is only satisfiable by
// nothing, so `subscribe`/`check`/`report` become uncallable with a real id
// (unified-config.md §3 note: "calling `subscribe` with no `products` is a
// type error"). `const C extends PayweaveConfig` on `createPayweave` (below)
// is what keeps every literal id intact through here — including when
// `products` is defined in, and imported from, another module entirely (§10:
// "inference survives `products` being imported from another module").

/** Every plan id declared in `C["products"]` (§10) — `never` when `products` is not configured. */
export type PlanIds<C extends PayweaveConfig> = C extends { products: readonly (infer P)[] }
  ? P extends { id: infer Id extends string }
    ? Id
    : never
  : never;

/** Every feature id used across `C["products"]`'s `includes` arrays (§10) — `never` when `products` is not configured. */
export type FeatureIds<C extends PayweaveConfig> = C extends { products: readonly (infer P)[] }
  ? P extends { includes: readonly (infer Inc)[] }
    ? Inc extends { featureId: infer Id extends string }
      ? Id
      : never
    : never
  : never;

/**
 * {@link FeatureIds} narrowed to inclusions of one feature `type` (§10) —
 * `FeatureIdsOf<C, "metered">` is intended to make `report`'s `featureId` a
 * compile-time error for a boolean feature id (§10, `unified-config.md` §4
 * assertion 4).
 *
 * KNOWN LIMITATION (flagged, not hidden — agent-playbook §6, PW-802 report):
 * `Plan<Id, Group, FeatureIds>["includes"]` (PW-801, `src/products/plan.ts`,
 * forbidden file for this ticket) is declared as
 * `readonly FeatureInclusion<FeatureIds>[]` — ONE bare string union shared
 * identically by BOTH `BooleanFeatureInclusion<FeatureIds>` and
 * `MeteredFeatureInclusion<FeatureIds>`, with no per-id type tag anywhere
 * accessible. Concretely: for a plan with feature ids `"a" | "b"`, its
 * `includes` type structurally allows a `type: "metered"` reading of `"a"`
 * AND `"b"` (and independently a `type: "boolean"` reading of both) whether
 * or not that combination was ever actually constructed — the ACTUAL
 * per-item correlation between one feature id and its one true type exists
 * only transiently at `plan()`'s own call site (`Def["includes"]`, before
 * `plan()`'s return-type cast erases it) and cannot be recovered from a
 * `Plan` VALUE afterwards. The practical effect, verified empirically: this
 * type currently resolves to the SAME set as {@link FeatureIds} for EITHER
 * `Type`, regardless of which ids are genuinely boolean vs metered — it does
 * not yet narrow. This is the exact case §10 hedges for ("a compile-time
 * error WHERE THE PRODUCTS ARRAY MAKES THE TYPE KNOWN") — the runtime
 * {@link PayweaveValidationError} guard (PW-902) is therefore the reliable,
 * UNCONDITIONAL enforcement of "report only accepts metered features," not
 * this type. The definition below is kept (rather than being collapsed to a
 * plain alias of `FeatureIds`) so `report`'s signature — and this type's
 * name/shape — need not change if a follow-up ticket widens `Plan.includes`
 * to carry per-id type correlation; this logic would then start narrowing
 * correctly with zero call-site changes.
 */
export type FeatureIdsOf<C extends PayweaveConfig, Type extends FeatureType> = C extends {
  products: readonly (infer P)[];
}
  ? P extends { includes: readonly (infer Inc)[] }
    ? Inc extends { featureId: infer Id extends string; type: Type }
      ? Id
      : never
    : never
  : never;

/**
 * `subscribe()`'s input (plans-and-features.md §11). `planId` is typed to
 * {@link PlanIds}; `provider` defaults to `defaultProvider` and must be a
 * configured, billing-capable provider (providers.md §4). Runtime lands with
 * PW-804 — today `subscribe` always rejects with {@link PayweaveConfigError}.
 */
export interface SubscribeInput<C extends PayweaveConfig> {
  /** YOUR user id (external id) — Payweave maps it to provider customers (§11.1). */
  customerId: string;
  planId: PlanIds<C>;
  /** Defaults to `defaultProvider`; must be a configured, billing-capable provider. */
  provider?: ConfiguredProvider<C>;
  /** Checkout redirect target on success (provider-dependent, §11). */
  successUrl?: string;
  /** Checkout redirect target on cancel (provider-dependent, §11). */
  cancelUrl?: string;
}

/**
 * `subscribe()`'s discriminated result (§11): a paid plan returns a checkout
 * redirect; a free or default plan activates (or no-ops) locally with no
 * provider object. PW-804 owns the runtime that produces this.
 */
export type SubscribeResult =
  | { status: "checkout"; checkoutUrl: string; reference: string }
  | { status: "active"; planId: string; subscription: PwSubscription | null };

/**
 * `check()`'s input (plans-and-features.md §1, unified-config.md §3).
 * `featureId` is typed to {@link FeatureIds} — any feature, boolean or
 * metered.
 */
export interface CheckInput<C extends PayweaveConfig> {
  customerId: string;
  featureId: FeatureIds<C>;
  /** Atomic gate (database.md §5, metered-usage.md §6): consume 1 unit iff allowed, in ONE operation. */
  consume?: boolean;
}

/**
 * `check()`'s result (metered-usage.md §3, matched verbatim). `balance`/
 * `limit`/`resetsAt` are `null` for boolean features (no usage to track) and
 * for a metered feature the resolved plan doesn't include — a normal
 * "upsell" answer, never an error (metered-usage.md §4).
 */
export interface CheckResult {
  /** Boolean feature: plan includes it. Metered: remaining balance > 0. */
  allowed: boolean;
  /** Remaining units this period; `null` for boolean features or a plan lacking the feature. */
  balance: number | null;
  /** The plan's configured limit; `null` alongside `balance`. */
  limit: number | null;
  /** End of the current billing period; `null` alongside `balance`. */
  resetsAt: Date | null;
  /** The plan that answered — may be the group's default plan id (metered-usage.md §4). */
  planId: string;
}

/**
 * `report()`'s input (plans-and-features.md §1, unified-config.md §3).
 * `featureId` is typed to {@link FeatureIdsOf}`<C, "metered">`, which is
 * INTENDED to make a boolean feature id a compile-time error here (§10) —
 * see that type's doc comment for a currently-known gap (it does not yet
 * narrow, given `Plan.includes`'s type shape from PW-801). The RUNTIME
 * {@link PayweaveValidationError} guard (PW-902) unconditionally rejects a
 * boolean feature id regardless of what the compiler can prove.
 */
export interface ReportInput<C extends PayweaveConfig> {
  customerId: string;
  featureId: FeatureIdsOf<C, "metered">;
  /** Positive safe integer; defaults to `1` when omitted (metered-usage.md §3). */
  amount?: number;
}

/** `report()`'s result — the post-decrement balance snapshot (metered-usage.md §3). */
export interface ReportResult {
  balance: number;
  resetsAt: Date;
}

/**
 * The always-present part of a {@link PayweaveClient}: root props, webhooks,
 * and the unified ops on the ROOT (§3). Provider namespaces are added by the
 * conditional intersections in {@link PayweaveClient}.
 */
export interface PayweaveClientBase<C extends PayweaveConfig> {
  /** Configured provider ids in canonical order, e.g. `["stripe", "paystack"]`. */
  readonly providers: readonly ConfiguredProvider<C>[];
  /** Resolved routing default for unified ops (§2 rule 3). */
  readonly defaultProvider: ConfiguredProvider<C>;
  /** Single client-wide environment — mixed test/live is rejected at construction. */
  readonly environment: "test" | "live";
  /**
   * One namespace for ALL configured providers — the provider is auto-detected
   * from the signature header name and dispatched to its own verifier (§5);
   * unconfigured, ambiguous, or unknown headers fail closed.
   */
  readonly webhooks: WebhooksNamespace;
  /**
   * @deprecated The unified ops live on the client ROOT since PW-502 — call
   * `payweave.checkout.create(...)`, not `payweave.unified.checkout.create(...)`.
   * This alias points at the SAME functions and is removed at v1.0.0 (§3).
   */
  readonly unified: PayweaveUnifiedOps<ConfiguredProvider<C>>;
  /**
   * The unified-ops capability matrix (providers.md §3.3, PW-607) — which of
   * the six unified ops each CONFIGURED provider supports; data, not prose
   * (PW-1102 renders it). No argument returns one entry per configured
   * provider; a provider argument returns just that provider's per-op matrix.
   * This is read-only introspection — it never throws for an unsupported op
   * (that's `assertUnifiedCapability`'s job on the actual call path); it DOES
   * throw {@link PayweaveConfigError} if `provider` names a key this client
   * does not have configured.
   */
  capabilities(): Readonly<
    Partial<Record<ConfiguredProvider<C>, Readonly<Record<UnifiedOpName, UnifiedOpCapability>>>>
  >;
  capabilities(
    provider: ConfiguredProvider<C>,
  ): Readonly<Record<UnifiedOpName, UnifiedOpCapability>>;
  /**
   * The `payweave/db/*` adapter passed as `database`, or `undefined` when the
   * billing surface isn't configured (unified-config.md §3). Additive PW-804
   * wiring: PW-802 resolved this into `ResolvedPayweaveConfig` but never
   * attached it to the returned client — `src/cli/status.ts` duck-typed
   * around the gap (`StatusClientLike`) until now; it picks this up with no
   * changes needed there.
   */
  readonly database?: DatabaseAdapter | undefined;
  /**
   * Cross-plan-validated, minor-units-resolved `products` (plans-and-features.md
   * §9, PW-802), or `undefined` when not configured. See {@link database}'s
   * doc comment — same additive PW-804 wiring.
   */
  readonly products?: readonly ResolvedProduct[] | undefined;
  /**
   * `BillingSync` (plans-and-features.md §12, PW-803) — push `products`'
   * plan/feature definitions to the database and every configured
   * billing-capable provider (Stripe: Products + Prices; Paystack: Plans;
   * Flutterwave: deferred, see `src/products/sync.ts`'s doc comment for the
   * verified ⚠️ resolution). Idempotent: re-running with unchanged content
   * makes zero provider API writes (§13); a crash mid-push is resumable via
   * `pwv_`-tagged adoption instead of blind-creating duplicates. Exists on
   * the client ALWAYS; throws {@link PayweaveConfigError} at runtime without
   * both `database` and `products` configured. The future `payweave push`
   * CLI command (PW-1004) drives this same function.
   */
  sync(): Promise<SyncResult>;
  /**
   * Billing surface (plans-and-features.md §11) — exists on the client
   * ALWAYS (unified-config.md §3), but `planId`/`featureId` are typed to
   * `products` (§10): with no `products` configured, {@link PlanIds} is
   * `never` and this is a compile-time error to call with a real plan id.
   * Throws {@link PayweaveConfigError} at runtime when `database` isn't
   * configured (unified-config.md §3) — implemented by PW-804
   * (`src/products/subscribe.ts`).
   */
  subscribe(input: SubscribeInput<C>): Promise<SubscribeResult>;
  /**
   * Billing surface (plans-and-features.md §1, metered-usage.md §1–§4) —
   * `featureId` is typed to every feature id across `products` (§10). Throws
   * {@link PayweaveConfigError} at runtime when `database` isn't configured
   * (unified-config.md §3) — implemented by PW-902 (`src/products/usage.ts`).
   */
  check(input: CheckInput<C>): Promise<CheckResult>;
  /**
   * Billing surface (plans-and-features.md §1, metered-usage.md §1–§4) —
   * `featureId` is intended to be typed to only the METERED feature ids
   * across `products` (§10); see {@link FeatureIdsOf}'s doc comment for a
   * currently-known gap in that narrowing. The RUNTIME
   * {@link PayweaveValidationError} guard enforces metered-only
   * unconditionally regardless of what the compiler can prove; throws
   * {@link PayweaveConfigError} when `database` isn't configured
   * (unified-config.md §3) — implemented by PW-902 (`src/products/usage.ts`).
   */
  report(input: ReportInput<C>): Promise<ReportResult>;
}

/**
 * The readonly client `createPayweave` returns (§3): unified ops on the root
 * routed to `defaultProvider`, plus one Surface A namespace per CONFIGURED
 * provider — an absent config key is a compile-time AND runtime absence (§4
 * assertion 1), and `flutterwave.version: "v4"` narrows its namespace to the
 * v4 surface (assertion 3).
 */
export type PayweaveClient<C extends PayweaveConfig> = PayweaveClientBase<C> &
  PayweaveUnifiedOps<ConfiguredProvider<C>> &
  (C extends Record<"stripe", object> ? { readonly stripe: StripeClient } : unknown) &
  (C extends Record<"paystack", object> ? { readonly paystack: PaystackClient } : unknown) &
  (C extends { flutterwave: { version: "v4" } }
    ? { readonly flutterwave: FlutterwaveV4Client }
    : C extends Record<"flutterwave", object>
      ? { readonly flutterwave: FlutterwaveV3Client }
      : unknown);

/**
 * Compile-time half of §2 rule 3 (§4 assertion 2): an inline `defaultProvider`
 * must name a CONFIGURED key. The resolver enforces the same rule at runtime
 * for configs assembled dynamically (where `C` is too wide to check).
 */
type ValidatePayweaveInput<C extends PayweaveConfig> = C extends { defaultProvider: infer D }
  ? [D] extends [ConfiguredProvider<C> | undefined]
    ? unknown
    : { defaultProvider: ConfiguredProvider<C> }
  : unknown;

/**
 * Unified ops for a configured `stripe` key (PW-607). The capability matrix
 * (`unified/mappings.ts`'s `UNIFIED_CAPABILITY_MATRIX`, providers.md §3.3)
 * says stripe does NOT support `transfers.create`/`banks.*` in v1 — the
 * `guardedRoute` wrapper in `createPayweave` asserts that BEFORE a call ever
 * reaches this namespace, so the two branches below are unreachable through
 * the public surface; they still throw the same typed capability error
 * defensively, in case that guard is ever bypassed.
 *
 * `checkout.create`/`verify`/`refunds.create` ARE capability-supported on
 * stripe (§3.3 maps them onto `checkout.sessions`/`paymentIntents`/`refunds`)
 * but the unified implementation that actually calls those Stripe resources
 * (`src/unified/stripe.ts`) has not shipped yet — that is separate follow-up
 * work, out of scope for this capability-matrix change. Calling them today
 * rejects with an honest "not implemented yet" error, distinct from a
 * capability gap.
 */
function stripeUnifiedNamespace(): UnifiedNamespace {
  const notImplemented = (op: UnifiedOpName): Promise<never> =>
    Promise.reject(
      new PayweaveError(
        `stripe unified "${op}" is supported in principle (providers.md §3.3) but not implemented ` +
          "yet — the resource endpoints landed (PW-602/PW-605), the unified mapping " +
          "(`src/unified/stripe.ts`) has not. Use the per-call `provider` override to route to " +
          "another configured provider, or call the Surface A `payweave.stripe.*` resources directly.",
        { provider: "stripe", isRetryable: false },
      ),
    );
  const capabilityGap = (op: UnifiedOpName): Promise<never> => {
    try {
      assertUnifiedCapability("stripe", op);
    } catch (err) {
      return Promise.reject(err);
    }
    /* istanbul ignore next -- defensive: unreachable while the matrix marks this op unsupported */
    return Promise.reject(new PayweaveError(`${op} is not supported on stripe.`, { provider: "stripe" }));
  };
  return {
    checkout: { create: () => notImplemented("checkout.create") },
    verify: () => notImplemented("verify"),
    refunds: { create: () => notImplemented("refunds.create") },
    transfers: { create: () => capabilityGap("transfers.create") },
    banks: {
      list: () => capabilityGap("banks.list"),
      resolveAccount: () => capabilityGap("banks.resolveAccount"),
    },
  };
}

/**
 * Create the unified Payweave client (unified-config.md §1–§4).
 *
 * Providers are optional top-level config KEYS (`stripe` / `paystack` /
 * `flutterwave`); at least one is required. The returned client is readonly and
 * fully constructed up front — one {@link HttpClient} per configured provider,
 * no lazy provider init. Unified ops sit on the client root and route to
 * `defaultProvider` unless overridden per call; Surface A namespaces exist
 * ONLY for configured keys (compile-time and runtime).
 *
 * Throws {@link PayweaveConfigError} synchronously for invalid config.
 *
 * @example
 * const payweave = createPayweave({
 *   paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY! },
 *   flutterwave: { secretKey: process.env.FLW_SECRET_KEY! },
 *   defaultProvider: "paystack",
 * });
 * await payweave.checkout.create({ amount: { value: 500_000, currency: "NGN" }, customer: { email } });
 * await payweave.banks.list({ provider: "flutterwave", country: "NG" }); // per-call override
 * payweave.paystack.transactions.initialize({ ... });                    // Surface A
 */
export function createPayweave<const C extends PayweaveConfig>(
  config: C & ValidatePayweaveInput<C>,
): PayweaveClient<C> {
  const resolved = resolvePayweaveConfig(config);

  // One HttpClient per configured provider (§3), built with the exact same
  // wiring as the legacy facade; Surface A namespaces and unified routing
  // share the instance.
  const surfaces: {
    stripe?: StripeClient;
    paystack?: PaystackClient;
    flutterwave?: FlutterwaveClient;
  } = {};
  const unifiedByProvider: Partial<Record<PayweaveProviderKey, UnifiedNamespace>> = {};

  for (const key of resolved.providers) {
    const entry = resolved.providerConfigs[key];
    if (entry === undefined) continue; // unreachable — the resolver populates every configured key
    if (key === "paystack") {
      const http = buildHttpClient(entry);
      surfaces.paystack = new PaystackClient(http);
      unifiedByProvider.paystack = createPaystackUnified(http);
    } else if (key === "flutterwave") {
      const http = buildHttpClient(entry);
      const version = entry.version === "v4" ? "v4" : "v3";
      surfaces.flutterwave = new FlutterwaveClient(http, version, entry.encryptionKey);
      unifiedByProvider.flutterwave = createFlutterwaveUnified(http, version);
    } else {
      // Stripe's transport comes from PW-601's options — form-encoded bodies +
      // pinned Stripe-Version (providers.md §3.1) — never the JSON default.
      surfaces.stripe = new StripeClient(new HttpClient(stripeHttpOptions(entry)));
      unifiedByProvider.stripe = stripeUnifiedNamespace();
    }
  }

  const routeTo = (override: PayweaveProviderKey | undefined): UnifiedNamespace => {
    const key = override ?? resolved.defaultProvider;
    const ns = unifiedByProvider[key];
    if (ns === undefined) {
      // Compile-time-impossible via ConfiguredProvider<C>; reachable when the
      // override comes from untyped/dynamic code — fail with a config error.
      throw new PayweaveConfigError(
        `provider "${key}" is not configured on this client — configured: ${resolved.providers.join(", ")}.`,
        { provider: key },
      );
    }
    return ns;
  };

  /**
   * Resolve + capability-guard a unified op call (providers.md §3.3, PW-607):
   * confirm the target provider is CONFIGURED first (existing `routeTo`
   * behavior, unchanged — a config problem is more fundamental than a
   * capability gap), THEN assert the op is capability-supported on it —
   * throwing the typed `PayweaveValidationError` from
   * `unified/mappings.ts#assertUnifiedCapability` naming the provider + op
   * (e.g. `transfers.create` on stripe) BEFORE any request would be sent.
   */
  const guardedRoute = (
    op: UnifiedOpName,
    override: PayweaveProviderKey | undefined,
  ): UnifiedNamespace => {
    const ns = routeTo(override);
    assertUnifiedCapability(override ?? resolved.defaultProvider, op);
    return ns;
  };

  // The root unified ops strip the per-call `provider` override before
  // delegating so it can never leak into an outgoing request body.
  const unified: PayweaveUnifiedOps = {
    checkout: {
      create: ({ provider, ...input }) =>
        guardedRoute("checkout.create", provider).checkout.create(input),
    },
    verify: ({ provider, ...input }) => guardedRoute("verify", provider).verify(input),
    refunds: {
      create: ({ provider, ...input }) =>
        guardedRoute("refunds.create", provider).refunds.create(input),
    },
    transfers: {
      create: ({ provider, ...input }) =>
        guardedRoute("transfers.create", provider).transfers.create(input),
    },
    banks: {
      list: ({ provider, ...input }) => guardedRoute("banks.list", provider).banks.list(input),
      resolveAccount: ({ provider, ...input }) =>
        guardedRoute("banks.resolveAccount", provider).banks.resolveAccount(input),
    },
  };

  // `payweave.capabilities()` (providers.md §3.3, PW-607) — read-only
  // introspection over the CONFIGURED providers' slice of
  // `UNIFIED_CAPABILITY_MATRIX`. Overloaded: no-arg returns one entry per
  // configured provider; a provider name returns just that provider's matrix
  // (and throws `PayweaveConfigError` for an unconfigured provider, mirroring
  // `routeTo`'s "not configured" behavior).
  function capabilities(): Readonly<
    Partial<Record<PayweaveProviderKey, Readonly<Record<UnifiedOpName, UnifiedOpCapability>>>>
  >;
  function capabilities(
    provider: PayweaveProviderKey,
  ): Readonly<Record<UnifiedOpName, UnifiedOpCapability>>;
  function capabilities(
    provider?: PayweaveProviderKey,
  ):
    | Readonly<Record<UnifiedOpName, UnifiedOpCapability>>
    | Readonly<Partial<Record<PayweaveProviderKey, Readonly<Record<UnifiedOpName, UnifiedOpCapability>>>>> {
    if (provider !== undefined) {
      if (!resolved.providers.includes(provider)) {
        throw new PayweaveConfigError(
          `provider "${provider}" is not configured on this client — configured: ${resolved.providers.join(", ")}.`,
          { provider },
        );
      }
      return UNIFIED_CAPABILITY_MATRIX[provider];
    }
    const out: Partial<Record<PayweaveProviderKey, Readonly<Record<UnifiedOpName, UnifiedOpCapability>>>> =
      {};
    for (const key of resolved.providers) out[key] = UNIFIED_CAPABILITY_MATRIX[key];
    return out;
  }

  // Billing surface (plans-and-features.md §11, metered-usage.md §1–§4,
  // unified-config.md §3): the methods exist on the client ALWAYS —
  // `planId`/`featureId` are typed to `products` at compile time (§10,
  // PlanIds/FeatureIds/FeatureIdsOf above). `subscribe` is real as of PW-804
  // (`src/products/subscribe.ts`); `check`/`report` are real as of PW-902
  // (`src/products/usage.ts`) — both throw `PayweaveConfigError` at call time
  // when `database` isn't configured, regardless of what the type system
  // could prove statically (unified-config.md §3).

  // The billing module (PW-804) only needs the resolved database/products +
  // provider routing info + the mounted Surface A clients it drives checkout
  // through — never the full `PayweaveClient<C>` (would be circular: this
  // function is still building it). PW-902 (`src/products/usage.ts`) reuses
  // the exact same shape.
  const billingContext: BillingContext = {
    database: resolved.database,
    products: resolved.products,
    providers: resolved.providers,
    defaultProvider: resolved.defaultProvider,
    stripe: surfaces.stripe,
    paystack: surfaces.paystack,
  };

  const client = {
    providers: resolved.providers,
    defaultProvider: resolved.defaultProvider,
    environment: resolved.environment,
    // Multi-provider header dispatch (unified-config.md §5, PW-503): the
    // provider is detected from the signature header NAME, then verified with
    // that provider's existing timing-safe verifier — fail closed on
    // unconfigured/ambiguous/unknown headers. `billingContext` (below) is
    // threaded through so every constructed event's `.apply()` (PW-805) can
    // reach the database — additive, same object PW-804/PW-902 already use.
    webhooks: createWebhookDispatch(resolved, billingContext),
    // Root ops and the deprecated `unified` alias share the SAME functions (§3).
    checkout: unified.checkout,
    verify: unified.verify,
    refunds: unified.refunds,
    transfers: unified.transfers,
    banks: unified.banks,
    unified,
    capabilities,
    // Additive PW-804 wiring — see `PayweaveClientBase.database`'s doc comment.
    database: resolved.database,
    products: resolved.products,
    subscribe: (input: BillingSubscribeInput) => billingSubscribe(billingContext, input),
    // PW-803 — BillingSync push.
    sync: () => billingSync(billingContext),
    // PW-902 — metered usage (real implementations, not stubs).
    check: (input: BillingCheckInput) => billingCheck(billingContext, input),
    report: (input: BillingReportInput) => billingReport(billingContext, input),
    ...surfaces,
  };

  return Object.freeze(client) as unknown as PayweaveClient<C>;
}
