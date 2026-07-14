/**
 * Payweave — one SDK, every provider, woven together.
 *
 * Public facade: `createPayweave` (`PayweaveClient`) with config-key-presence
 * narrowing — pass the provider(s) you want as keys on the config object and
 * get a fully-typed client back.
 */
import { PayweaveError, PayweaveConfigError, type PayweaveProvider } from "./core/errors";
import {
  resolvePayweaveConfig,
  type ResolvedConfig,
  type PayweaveConfig,
  type PayweaveProviderKey,
  type ResolvedProduct,
} from "./core/config";
import { HttpClient, bearer, oauthClientCredentials, type AuthStrategy } from "./core/http";
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
// unified integration code.
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
  // Capability matrix — the shape `capabilities()` returns.
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
  // Provider-keyed root — what `createPayweave` takes.
  PayweaveConfig,
  PayweaveProviderKey,
  StripeProviderConfig,
  PaystackProviderConfig,
  FlutterwaveProviderConfig,
  ResolvedPayweaveConfig,
  ResolvedProviderConfig,
  // Cross-plan-validated, minor-units-resolved `products`.
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

// ── Products ─────────────────────────────────────────────────────────────────
// `feature`/`plan` are re-exported from the package root. Full domain
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

// `payweave.sync()`'s result shape — see
// `./products/sync` for the full `BillingSync` engine this re-exports from.
export type { SyncResult, SyncPlanResult, SyncProviderAction } from "./products/sync";

// ── Webhooks namespace ───────────────────────────────────────────────────────
/** Raw-body + headers input shared by every webhook operation. */
export interface WebhookInput {
  /** Exact received bytes — never a re-serialized object. */
  rawBody: string | Uint8Array;
  /** `Headers` or a plain/array header map; looked up case-insensitively. */
  headers: HeaderLookup;
}

/** The `payweave.webhooks` surface — multi-provider signature dispatch. */
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

// ═════════════════════════════════════════════════════════════════════════════
// createPayweave — the unified entry point. Providers are config KEYS;
// narrowing comes from key PRESENCE, not a `provider` discriminator.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Provider keys actually configured (present and not `undefined`) on a config
 * `C` — the union `defaultProvider`, per-call `provider` overrides, and the
 * mounted Surface A namespaces are all typed from.
 */
export type ConfiguredProvider<C extends PayweaveConfig> = {
  [K in PayweaveProviderKey]: C extends Record<K, object> ? K : never;
}[PayweaveProviderKey];

/** Per-call routing override accepted by every unified op on the client root. */
export interface ProviderOverride<P extends PayweaveProviderKey = PayweaveProviderKey> {
  /** Route THIS call to a specific configured provider instead of `defaultProvider`. */
  provider?: P;
}

/**
 * The unified ops (Surface B) as they appear on the `PayweaveClient` ROOT: the
 * {@link UnifiedNamespace} signatures widened with a per-call `provider`
 * override typed to the CONFIGURED keys only.
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
 * configs. v4 resources are a later wave — v3/v4 are version-isolated and
 * never shared, so today this exposes only the shared transport. The type
 * deliberately hides the v3-only resource fields the class leaves unmounted at
 * runtime for v4.
 */
export type FlutterwaveV4Client = Pick<FlutterwaveClient, "http"> & { readonly version: "v4" };

// ── Billing surface type inference ──────
// `products` becomes type-safe through these three extraction types: every
// plan id, every feature id, and feature ids narrowed to one `type` (powers
// `report`'s metered-only compile-time guard). All three resolve to `never`
// when `C` has no `products` key at all — `never` is only satisfiable by
// nothing, so `subscribe`/`check`/`report` become uncallable with a real id;
// calling `subscribe` with no `products` configured is a type error.
// `const C extends PayweaveConfig` on `createPayweave` (below) is what keeps
// every literal id intact through here — including when `products` is
// defined in, and imported from, another module entirely.

/** Every plan id declared in `C["products"]` — `never` when `products` is not configured. */
export type PlanIds<C extends PayweaveConfig> = C extends { products: readonly (infer P)[] }
  ? P extends { id: infer Id extends string }
    ? Id
    : never
  : never;

/** Every feature id used across `C["products"]`'s `includes` arrays — `never` when `products` is not configured. */
export type FeatureIds<C extends PayweaveConfig> = C extends { products: readonly (infer P)[] }
  ? P extends { includes: readonly (infer Inc)[] }
    ? Inc extends { featureId: infer Id extends string }
      ? Id
      : never
    : never
  : never;

/**
 * {@link FeatureIds} narrowed to inclusions of one feature `type` —
 * `FeatureIdsOf<C, "metered">` is intended to make `report`'s `featureId` a
 * compile-time error for a boolean feature id.
 *
 * KNOWN LIMITATION (flagged, not hidden):
 * `Plan<Id, Group, FeatureIds>["includes"]` (`src/products/plan.ts`) is
 * declared as `readonly FeatureInclusion<FeatureIds>[]` — ONE bare string
 * union shared identically by BOTH `BooleanFeatureInclusion<FeatureIds>` and
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
 * not yet narrow. This is the exact case a compile-time error would need the
 * products array to make the type known for — the runtime
 * {@link PayweaveValidationError} guard is therefore the reliable,
 * UNCONDITIONAL enforcement of "report only accepts metered features," not
 * this type. The definition below is kept (rather than being collapsed to a
 * plain alias of `FeatureIds`) so `report`'s signature — and this type's
 * name/shape — need not change if a follow-up widens `Plan.includes` to
 * carry per-id type correlation; this logic would then start narrowing
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
 * `subscribe()`'s input. `planId` is typed to
 * {@link PlanIds}; `provider` defaults to `defaultProvider` and must be a
 * configured, billing-capable provider.
 */
export interface SubscribeInput<C extends PayweaveConfig> {
  /** YOUR user id (external id) — Payweave maps it to provider customers. */
  customerId: string;
  planId: PlanIds<C>;
  /** Defaults to `defaultProvider`; must be a configured, billing-capable provider. */
  provider?: ConfiguredProvider<C>;
  /** Checkout redirect target on success (provider-dependent). */
  successUrl?: string;
  /** Checkout redirect target on cancel (provider-dependent). */
  cancelUrl?: string;
}

/**
 * `subscribe()`'s discriminated result: a paid plan returns a checkout
 * redirect; a free or default plan activates (or no-ops) locally with no
 * provider object.
 */
export type SubscribeResult =
  | { status: "checkout"; checkoutUrl: string; reference: string }
  | { status: "active"; planId: string; subscription: PwSubscription | null };

/**
 * `check()`'s input. `featureId` is typed to {@link FeatureIds} — any
 * feature, boolean or metered.
 */
export interface CheckInput<C extends PayweaveConfig> {
  customerId: string;
  featureId: FeatureIds<C>;
  /** Atomic gate: consume 1 unit iff allowed, in ONE operation. */
  consume?: boolean;
}

/**
 * `check()`'s result. `balance`/`limit`/`resetsAt` are `null` for boolean
 * features (no usage to track) and for a metered feature the resolved plan
 * doesn't include — a normal "upsell" answer, never an error.
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
  /** The plan that answered — may be the group's default plan id. */
  planId: string;
}

/**
 * `report()`'s input. `featureId` is typed to {@link FeatureIdsOf}`<C,
 * "metered">`, which is INTENDED to make a boolean feature id a compile-time
 * error here — see that type's doc comment for a currently-known gap (it
 * does not yet narrow, given `Plan.includes`'s type shape). The RUNTIME
 * {@link PayweaveValidationError} guard unconditionally rejects a
 * boolean feature id regardless of what the compiler can prove.
 */
export interface ReportInput<C extends PayweaveConfig> {
  customerId: string;
  featureId: FeatureIdsOf<C, "metered">;
  /** Positive safe integer; defaults to `1` when omitted. */
  amount?: number;
}

/** `report()`'s result — the post-decrement balance snapshot. */
export interface ReportResult {
  balance: number;
  resetsAt: Date;
}

/**
 * The always-present part of a {@link PayweaveClient}: root props, webhooks,
 * and the unified ops on the ROOT. Provider namespaces are added by the
 * conditional intersections in {@link PayweaveClient}.
 */
export interface PayweaveClientBase<C extends PayweaveConfig> {
  /** Configured provider ids in canonical order, e.g. `["stripe", "paystack"]`. */
  readonly providers: readonly ConfiguredProvider<C>[];
  /** Resolved routing default for unified ops. */
  readonly defaultProvider: ConfiguredProvider<C>;
  /** Single client-wide environment — mixed test/live is rejected at construction. */
  readonly environment: "test" | "live";
  /**
   * One namespace for ALL configured providers — the provider is auto-detected
   * from the signature header name and dispatched to its own verifier;
   * unconfigured, ambiguous, or unknown headers fail closed.
   */
  readonly webhooks: WebhooksNamespace;
  /**
   * The unified-ops capability matrix — which of the six unified ops each
   * CONFIGURED provider supports; data, not prose. No argument returns one
   * entry per configured provider; a provider argument returns just that
   * provider's per-op matrix. This is read-only introspection — it never
   * throws for an unsupported op (that's `assertUnifiedCapability`'s job on
   * the actual call path); it DOES throw {@link PayweaveConfigError} if
   * `provider` names a key this client does not have configured.
   */
  capabilities(): Readonly<
    Partial<Record<ConfiguredProvider<C>, Readonly<Record<UnifiedOpName, UnifiedOpCapability>>>>
  >;
  capabilities(
    provider: ConfiguredProvider<C>,
  ): Readonly<Record<UnifiedOpName, UnifiedOpCapability>>;
  /**
   * The `payweave/db/*` adapter passed as `database`, or `undefined` when the
   * billing surface isn't configured.
   */
  readonly database?: DatabaseAdapter | undefined;
  /**
   * Cross-plan-validated, minor-units-resolved `products`, or `undefined`
   * when not configured. See {@link database}'s doc comment.
   */
  readonly products?: readonly ResolvedProduct[] | undefined;
  /**
   * `BillingSync` — push `products`' plan/feature definitions to the
   * database and every configured billing-capable provider (Stripe:
   * Products + Prices; Paystack: Plans; Flutterwave: deferred, see
   * `src/products/sync.ts`'s doc comment for the verified ⚠️ resolution).
   * Idempotent: re-running with unchanged content makes zero provider API
   * writes; a crash mid-push is resumable via `pwv_`-tagged adoption instead
   * of blind-creating duplicates. Exists on the client ALWAYS; throws
   * {@link PayweaveConfigError} at runtime without both `database` and
   * `products` configured. The `payweave push` CLI command drives this same
   * function.
   */
  sync(): Promise<SyncResult>;
  /**
   * Billing surface — exists on the client ALWAYS, but `planId`/`featureId`
   * are typed to `products`: with no `products` configured, {@link PlanIds}
   * is `never` and this is a compile-time error to call with a real plan id.
   * Throws {@link PayweaveConfigError} at runtime when `database` isn't
   * configured — implemented in `src/products/subscribe.ts`.
   */
  subscribe(input: SubscribeInput<C>): Promise<SubscribeResult>;
  /**
   * Billing surface — `featureId` is typed to every feature id across
   * `products`. Throws {@link PayweaveConfigError} at runtime when
   * `database` isn't configured — implemented in `src/products/usage.ts`.
   */
  check(input: CheckInput<C>): Promise<CheckResult>;
  /**
   * Billing surface — `featureId` is intended to be typed to only the
   * METERED feature ids across `products`; see {@link FeatureIdsOf}'s doc
   * comment for a currently-known gap in that narrowing. The RUNTIME
   * {@link PayweaveValidationError} guard enforces metered-only
   * unconditionally regardless of what the compiler can prove; throws
   * {@link PayweaveConfigError} when `database` isn't configured —
   * implemented in `src/products/usage.ts`.
   */
  report(input: ReportInput<C>): Promise<ReportResult>;
}

/**
 * The readonly client `createPayweave` returns: unified ops on the root
 * routed to `defaultProvider`, plus one Surface A namespace per CONFIGURED
 * provider — an absent config key is a compile-time AND runtime absence, and
 * `flutterwave.version: "v4"` narrows its namespace to the v4 surface.
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
 * Compile-time check that an inline `defaultProvider` must name a CONFIGURED
 * key. The resolver enforces the same rule at runtime for configs assembled
 * dynamically (where `C` is too wide to check).
 */
type ValidatePayweaveInput<C extends PayweaveConfig> = C extends { defaultProvider: infer D }
  ? [D] extends [ConfiguredProvider<C> | undefined]
    ? unknown
    : { defaultProvider: ConfiguredProvider<C> }
  : unknown;

/**
 * Unified ops for a configured `stripe` key. The capability matrix
 * (`unified/mappings.ts`'s `UNIFIED_CAPABILITY_MATRIX`) says stripe does NOT
 * support `transfers.create`/`banks.*` — the `guardedRoute` wrapper in
 * `createPayweave` asserts that BEFORE a call ever reaches this namespace, so
 * the two branches below are unreachable through the public surface; they
 * still throw the same typed capability error defensively, in case that
 * guard is ever bypassed.
 *
 * `checkout.create`/`verify`/`refunds.create` ARE capability-supported on
 * stripe (mapped onto `checkout.sessions`/`paymentIntents`/`refunds`) but the
 * unified implementation that actually calls those Stripe resources
 * (`src/unified/stripe.ts`) has not shipped yet — that is separate follow-up
 * work. Calling them today rejects with an honest "not implemented yet"
 * error, distinct from a capability gap.
 */
function stripeUnifiedNamespace(): UnifiedNamespace {
  const notImplemented = (op: UnifiedOpName): Promise<never> =>
    Promise.reject(
      new PayweaveError(
        `stripe unified "${op}" is supported in principle but not implemented ` +
          "yet — the resource endpoints landed, but the unified mapping " +
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
 * Create the unified Payweave client.
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

  // One HttpClient per configured provider, built with the exact same
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
      // Stripe's transport uses its own options — form-encoded bodies +
      // pinned Stripe-Version — never the JSON default.
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
   * Resolve + capability-guard a unified op call:
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

  // `payweave.capabilities()` — read-only
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

  // Billing surface: the methods exist on the client ALWAYS — `planId`/
  // `featureId` are typed to `products` at compile time (PlanIds/FeatureIds/
  // FeatureIdsOf above). `subscribe` is implemented in
  // `src/products/subscribe.ts`; `check`/`report` are implemented in
  // `src/products/usage.ts` — both throw `PayweaveConfigError` at call time
  // when `database` isn't configured, regardless of what the type system
  // could prove statically.

  // The billing module only needs the resolved database/products +
  // provider routing info + the mounted Surface A clients it drives checkout
  // through — never the full `PayweaveClient<C>` (would be circular: this
  // function is still building it). `src/products/usage.ts` reuses the exact
  // same shape.
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
    // Multi-provider header dispatch: the
    // provider is detected from the signature header NAME, then verified with
    // that provider's existing timing-safe verifier — fail closed on
    // unconfigured/ambiguous/unknown headers. `billingContext` (below) is
    // threaded through so every constructed event's `.apply()` can
    // reach the database — the same object the billing surface below uses.
    webhooks: createWebhookDispatch(resolved, billingContext),
    checkout: unified.checkout,
    verify: unified.verify,
    refunds: unified.refunds,
    transfers: unified.transfers,
    banks: unified.banks,
    capabilities,
    // See `PayweaveClientBase.database`'s doc comment.
    database: resolved.database,
    products: resolved.products,
    subscribe: (input: BillingSubscribeInput) => billingSubscribe(billingContext, input),
    // BillingSync push.
    sync: () => billingSync(billingContext),
    // metered usage (real implementations, not stubs).
    check: (input: BillingCheckInput) => billingCheck(billingContext, input),
    report: (input: BillingReportInput) => billingReport(billingContext, input),
    ...surfaces,
  };

  return Object.freeze(client) as unknown as PayweaveClient<C>;
}
