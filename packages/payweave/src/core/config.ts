/**
 * Config schema, environment inference, and base-URL resolution.
 *
 * Two roots live here:
 *
 * 1. **Provider-KEYED root** (`payweaveConfigSchema` + `resolvePayweaveConfig`)
 *    — the primary entry point. Providers are optional top-level keys
 *    (`stripe` / `paystack` / `flutterwave`); `createPayweave` mounts on this.
 * 2. **Discriminated root** (`sdkConfigSchema` + `resolveConfig`) — internal
 *    per-provider resolution that the keyed root delegates to for the actual
 *    paystack/flutterwave environment-inference and base-URL logic.
 *
 * Invalid config throws {@link PayweaveConfigError} synchronously — we never
 * send a request with a key we cannot classify.
 */
import { z } from "zod";
import type { DatabaseAdapter } from "../db/index";
import { resolvePlanPricing, type Plan, type ResolvedPlanPrice } from "../products/plan";
import { PayweaveConfigError } from "./errors";
import type { FetchLike } from "./http";
import type { Logger } from "./logger";

// ── Base URLs ────────────────────────────────────────────────────────────────
/** Paystack REST base — same host for test and live (env is key-derived). */
export const PAYSTACK_BASE_URL = "https://api.paystack.co";
/** Flutterwave v3 REST base — same host for test and live (env is key-derived). */
export const FLW_V3_BASE_URL = "https://api.flutterwave.com/v3";
/**
 * ⚠️ VERIFY AT BUILD TIME against developer.flutterwave.com → Environments with
 * the version selector pinned to v4. v4 uses a distinct sandbox host and OAuth,
 * with explicit (not key-inferred) environments. These are PLACEHOLDERS.
 */
export const FLW_V4_BASE_URL = "https://api.flutterwave.cloud/f4bexperience";
/** ⚠️ VERIFY AT BUILD TIME — v4 sandbox host (placeholder, see above). */
export const FLW_V4_SANDBOX_URL = "https://api.flutterwave.cloud/developersandbox";
/**
 * ⚠️ VERIFY AT BUILD TIME — v4 OAuth token endpoint / grant / TTL against the
 * v4 Authentication docs. Consumed by the OAuth auth strategy (core/http).
 */
export const FLW_V4_TOKEN_URL =
  "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";
/** Stripe REST base — one host for test AND live; env is key-derived. */
export const STRIPE_BASE_URL = "https://api.stripe.com";
/**
 * The Stripe API version this SDK was built against, pinned via the
 * `Stripe-Version` header on EVERY request so provider-side version drift
 * cannot change payload shapes under us. Overridable per
 * client through `stripe.apiVersion`. Current version confirmed at
 * https://docs.stripe.com/api/versioning (verified 2026-07-12): monthly
 * releases are `YYYY-MM-DD.<major-release-name>`.
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia";

// ── Schema ───────────────────────────────────────────────────────────────────
const commonFields = {
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  baseUrl: z.string().min(1).optional(),
  fetch: z.custom<FetchLike>((v) => typeof v === "function").optional(),
  environment: z.enum(["test", "live"]).optional(),
  logger: z.custom<Logger>((v) => typeof v === "function").optional(),
  allowInsecureBaseUrl: z.boolean().optional(),
};

const paystackConfigSchema = z.object({
  provider: z.literal("paystack"),
  secretKey: z.string().min(1),
  ...commonFields,
});

const flwV3ConfigSchema = z.object({
  provider: z.literal("flutterwave"),
  version: z.literal("v3").default("v3"),
  secretKey: z.string().min(1),
  encryptionKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  ...commonFields,
});

const flwV4ConfigSchema = z.object({
  provider: z.literal("flutterwave"),
  version: z.literal("v4"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  encryptionKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  ...commonFields,
});

/** Flutterwave union, discriminated on `version` (`v3` default applied below). */
const flutterwaveConfigSchema = z.discriminatedUnion("version", [
  flwV3ConfigSchema,
  flwV4ConfigSchema,
]);

/**
 * Top-level SDK config schema: a `discriminatedUnion` on `provider` (faster and
 * with precise, targeted errors vs a sequential `z.union`). The preprocess
 * injects the default `version: "v3"` for a Flutterwave config that omits it,
 * BEFORE discrimination, so the nested version-discriminated union can route it
 * — `version: "v4"` opts into the OAuth shape (`clientId` + `clientSecret`).
 */
export const sdkConfigSchema = z.preprocess((val) => {
  if (
    val !== null &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    (val as Record<string, unknown>).provider === "flutterwave" &&
    !("version" in val)
  ) {
    return { ...(val as Record<string, unknown>), version: "v3" };
  }
  return val;
}, z.discriminatedUnion("provider", [paystackConfigSchema, flutterwaveConfigSchema]));

export type PaystackConfig = z.input<typeof paystackConfigSchema>;
export type FlutterwaveV3Config = z.input<typeof flwV3ConfigSchema>;
export type FlutterwaveV4Config = z.input<typeof flwV4ConfigSchema>;
export type FlutterwaveConfig = FlutterwaveV3Config | FlutterwaveV4Config;
export type SDKConfig = PaystackConfig | FlutterwaveConfig;

/** Fully-resolved config: defaults applied, environment + baseUrl decided. */
export interface ResolvedConfig {
  provider: "paystack" | "flutterwave";
  version: "v3" | "v4" | undefined;
  environment: "test" | "live";
  baseUrl: string;
  secretKey: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  encryptionKey: string | undefined;
  webhookSecret: string | undefined;
  timeoutMs: number;
  maxRetries: number;
  fetch: FetchLike | undefined;
  logger: Logger | undefined;
  allowInsecureBaseUrl: boolean;
  /** v4 only — OAuth token endpoint the auth strategy hits. */
  tokenUrl: string | undefined;
}

/** Defaults. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Infer `"test" | "live"` from a Paystack / Flutterwave-v3 / Stripe secret key
 * prefix. Throws {@link PayweaveConfigError} naming the expected prefixes for a
 * malformed/unrecognized key (we never send a request with a key we can't
 * classify). Flutterwave v4 does NOT use this — its environment is explicit.
 */
export function inferEnvironment(
  provider: "paystack" | "flutterwave" | "stripe",
  secretKey: string,
): "test" | "live" {
  if (provider === "paystack") {
    if (secretKey.startsWith("sk_test_")) return "test";
    if (secretKey.startsWith("sk_live_")) return "live";
    throw new PayweaveConfigError(
      "Unrecognized Paystack secret key — expected an 'sk_test_' or 'sk_live_' prefix.",
      { provider },
    );
  }
  if (provider === "stripe") {
    // Standard keys (sk_) and restricted keys (rk_) both carry the env in the
    // prefix. A bare "rk_" without test/live is unclassifiable.
    if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
    if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
    throw new PayweaveConfigError(
      "Unrecognized Stripe secret key — expected an 'sk_test_', 'sk_live_', 'rk_test_', or 'rk_live_' prefix.",
      { provider },
    );
  }
  if (secretKey.startsWith("FLWSECK_TEST-")) return "test";
  if (secretKey.startsWith("FLWSECK-")) return "live";
  throw new PayweaveConfigError(
    "Unrecognized Flutterwave secret key — expected an 'FLWSECK_TEST-' or 'FLWSECK-' prefix.",
    { provider },
  );
}

function toConfigError(err: unknown): PayweaveConfigError {
  if (err instanceof z.ZodError) {
    const detail = err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return new PayweaveConfigError(`Invalid Payweave config — ${detail}`);
  }
  if (err instanceof PayweaveConfigError) return err;
  return new PayweaveConfigError(
    `Invalid Payweave config — ${err instanceof Error ? err.message : String(err)}`,
  );
}

function guardBaseUrl(
  baseUrl: string,
  allowInsecure: boolean,
  logger: Logger | undefined,
  provider: "paystack" | "flutterwave" | "stripe",
): void {
  if (/^https:\/\//i.test(baseUrl)) return;
  if (!allowInsecure) {
    throw new PayweaveConfigError(
      `Refusing non-HTTPS baseUrl "${baseUrl}". Set allowInsecureBaseUrl: true to override (testing only).`,
      { provider },
    );
  }
  logger?.({
    type: "warn",
    message: `⚠️  INSECURE baseUrl "${baseUrl}" — credentials will be sent unencrypted. Never do this in production.`,
  });
}

/**
 * Parse + fully resolve raw SDK config. Applies defaults, infers the
 * environment (throwing on conflict with an explicit `environment`), selects
 * the base URL, and enforces the HTTPS guard. Throws
 * {@link PayweaveConfigError} synchronously for any invalid input.
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  let parsed: z.output<typeof sdkConfigSchema>;
  try {
    parsed = sdkConfigSchema.parse(input);
  } catch (err) {
    throw toConfigError(err);
  }

  const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = parsed.maxRetries ?? DEFAULT_MAX_RETRIES;
  const allowInsecureBaseUrl = parsed.allowInsecureBaseUrl ?? false;
  const logger = parsed.logger;

  if (parsed.provider === "paystack") {
    const environment = resolveKeyedEnvironment("paystack", parsed.secretKey, parsed.environment);
    const baseUrl = parsed.baseUrl ?? PAYSTACK_BASE_URL;
    guardBaseUrl(baseUrl, allowInsecureBaseUrl, logger, "paystack");
    return {
      provider: "paystack",
      version: undefined,
      environment,
      baseUrl,
      secretKey: parsed.secretKey,
      clientId: undefined,
      clientSecret: undefined,
      encryptionKey: undefined,
      webhookSecret: undefined,
      timeoutMs,
      maxRetries,
      fetch: parsed.fetch,
      logger,
      allowInsecureBaseUrl,
      tokenUrl: undefined,
    };
  }

  // Flutterwave
  if (parsed.version === "v4") {
    // v4: environment is explicit (default "test"); separate sandbox host.
    const environment = parsed.environment ?? "test";
    const baseUrl =
      parsed.baseUrl ?? (environment === "test" ? FLW_V4_SANDBOX_URL : FLW_V4_BASE_URL);
    guardBaseUrl(baseUrl, allowInsecureBaseUrl, logger, "flutterwave");
    return {
      provider: "flutterwave",
      version: "v4",
      environment,
      baseUrl,
      secretKey: undefined,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      encryptionKey: parsed.encryptionKey,
      webhookSecret: parsed.webhookSecret,
      timeoutMs,
      maxRetries,
      fetch: parsed.fetch,
      logger,
      allowInsecureBaseUrl,
      tokenUrl: FLW_V4_TOKEN_URL,
    };
  }

  // Flutterwave v3
  const environment = resolveKeyedEnvironment("flutterwave", parsed.secretKey, parsed.environment);
  const baseUrl = parsed.baseUrl ?? FLW_V3_BASE_URL;
  guardBaseUrl(baseUrl, allowInsecureBaseUrl, logger, "flutterwave");
  return {
    provider: "flutterwave",
    version: "v3",
    environment,
    baseUrl,
    secretKey: parsed.secretKey,
    clientId: undefined,
    clientSecret: undefined,
    encryptionKey: parsed.encryptionKey,
    webhookSecret: parsed.webhookSecret,
    timeoutMs,
    maxRetries,
    fetch: parsed.fetch,
    logger,
    allowInsecureBaseUrl,
    tokenUrl: undefined,
  };
}

function resolveKeyedEnvironment(
  provider: "paystack" | "flutterwave" | "stripe",
  secretKey: string,
  explicit: "test" | "live" | undefined,
): "test" | "live" {
  const inferred = inferEnvironment(provider, secretKey);
  if (explicit && explicit !== inferred) {
    throw new PayweaveConfigError(
      `environment "${explicit}" conflicts with the ${provider} key prefix (which indicates "${inferred}"). ` +
        `Remove the explicit environment or use a matching key.`,
      { provider },
    );
  }
  return inferred;
}

// ═════════════════════════════════════════════════════════════════════════════
// Provider-KEYED root — the primary entry point that `createPayweave` mounts
// on. The plumbing above (base URLs, commonFields, per-provider sub-schemas,
// inferEnvironment, guards) is shared with the `sdkConfigSchema`/`resolveConfig`
// root below.
// ═════════════════════════════════════════════════════════════════════════════

/** Canonical provider-key order — also the iteration order of resolution. */
export const PAYWEAVE_PROVIDER_KEYS = ["stripe", "paystack", "flutterwave"] as const;

const providerKeySchema = z.enum(PAYWEAVE_PROVIDER_KEYS);

/** Union of the top-level provider config keys accepted by `createPayweave`. */
export type PayweaveProviderKey = z.infer<typeof providerKeySchema>;

/**
 * Stripe per-provider config.
 * `secretKey` accepts standard (`sk_*`) and restricted (`rk_*`) keys
 * (https://docs.stripe.com/api/authentication — verified 2026-07-12); env is
 * inferred from the prefix by {@link inferEnvironment}. Auth headers and the
 * form-encoding transport are wired by `src/stripe/http-options`.
 */
export const stripeProviderConfigSchema = z.object({
  secretKey: z.string().min(1),
  /** `whsec_*` — REQUIRED before any `webhooks.*` call (fail closed); optional here. */
  webhookSecret: z.string().optional(),
  /** Pins the `Stripe-Version` header; defaults to {@link STRIPE_API_VERSION}. */
  apiVersion: z.string().optional(),
  /**
   * Connect platforms only — a connected account id (`acct_*`) sent as the
   * `Stripe-Account` header on every request so calls act on that account
   * (https://docs.stripe.com/connect/authentication — verified 2026-07-12).
   */
  accountId: z.string().min(1).optional(),
  ...commonFields,
});

/** Paystack per-provider config — the legacy shape minus its `provider` discriminator. */
export const paystackProviderConfigSchema = paystackConfigSchema.omit({ provider: true });

/**
 * Flutterwave per-provider config. Reuses {@link flutterwaveConfigSchema} (and
 * the legacy root's v3-default preprocess behavior) UNCHANGED — rule 6: the
 * `version` discriminator (`"v3"` default, `"v4"` opt-in) lives INSIDE the
 * `flutterwave` key; the top-level shape does not change per version. The
 * preprocess injects the `provider` literal the reused union expects plus the
 * `"v3"` default, exactly as the legacy root does.
 */
export const flutterwaveProviderConfigSchema = z.preprocess((val) => {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const withDefaults: Record<string, unknown> = { ...(val as Record<string, unknown>) };
    if (!("version" in withDefaults)) withDefaults.version = "v3";
    withDefaults.provider = "flutterwave";
    return withDefaults;
  }
  return val;
}, flutterwaveConfigSchema);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const storeHasMethod = (store: unknown, method: string): boolean =>
  isPlainObject(store) && typeof store[method] === "function";

/**
 * Cheap structural check for the real `DatabaseAdapter` contract: the six
 * stores must be present with one spot-checked method each, plus `dialect` +
 * `transaction`. Deliberately NOT
 * a deep validation — adapters are `payweave/db/*` factory outputs that
 * validate their own input eagerly; this guard exists to
 * catch handing us a raw driver/ORM client (e.g. a `PrismaClient`) instead of
 * `prismaAdapter(prisma)`.
 */
const isDatabaseAdapter = (v: unknown): v is DatabaseAdapter =>
  isPlainObject(v) &&
  typeof v.dialect === "string" &&
  typeof v.transaction === "function" &&
  storeHasMethod(v.customers, "upsert") &&
  storeHasMethod(v.plans, "pushVersion") &&
  storeHasMethod(v.subscriptions, "getActive") &&
  storeHasMethod(v.balances, "consume") &&
  storeHasMethod(v.webhookEvents, "claim") &&
  storeHasMethod(v.migrations, "apply");

const databaseAdapterSchema = z.custom<DatabaseAdapter>(
  isDatabaseAdapter,
  "expected a payweave/db/* database adapter object",
);

/**
 * Cheap structural check for a real `plan()` output: a spot
 * check on `id`/`default`/`includes`, mirroring {@link isDatabaseAdapter}'s
 * philosophy — deliberately NOT a deep validation (`plan()` already validated
 * the definition eagerly at definition time; this guard exists to catch a
 * raw plain object standing in for a `plan()` call).
 */
const isPlan = (v: unknown): v is Plan =>
  isPlainObject(v) &&
  typeof v.id === "string" &&
  typeof v.default === "boolean" &&
  Array.isArray(v.includes);

const planSchema = z.custom<Plan>(
  isPlan,
  "expected a plan() definition (see plans-and-features.md)",
);

/**
 * The provider-keyed root config schema. STRICT: unknown
 * top-level keys are rejected (rule 1 — catches typos like `stipe`). Rules 2–5
 * are cross-field and enforced by {@link resolvePayweaveConfig}.
 */
export const payweaveConfigSchema = z.strictObject({
  // ── Providers (at least one — rule 2, enforced in the resolver) ──
  stripe: stripeProviderConfigSchema.optional(),
  paystack: paystackProviderConfigSchema.optional(),
  flutterwave: flutterwaveProviderConfigSchema.optional(),

  /** Routing target for unified/billing calls — must name a configured key (rule 3). */
  defaultProvider: providerKeySchema.optional(),

  // ── Billing platform (billing surface activates when present) ──
  database: databaseAdapterSchema.optional(),
  products: z.array(planSchema).optional(),
  /** ISO 4217 — used by plan prices without an explicit currency. */
  defaultCurrency: z.string().min(1).optional(),

  // ── Common transport options (shared across providers) ──
  timeoutMs: commonFields.timeoutMs,
  maxRetries: commonFields.maxRetries,
  fetch: commonFields.fetch,
  logger: commonFields.logger,
  /** Explicit env — per-provider key inference still applies; conflicts throw (rule 4). */
  environment: commonFields.environment,
});

export type StripeProviderConfig = z.input<typeof stripeProviderConfigSchema>;
export type PaystackProviderConfig = z.input<typeof paystackProviderConfigSchema>;

/** `Omit` that distributes over unions, preserving each member's own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Flutterwave keyed input — the legacy v3/v4 input union minus the injected `provider`. */
export type FlutterwaveProviderConfig = DistributiveOmit<FlutterwaveConfig, "provider">;

/**
 * Input type for `createPayweave`. Assembled from
 * z.input-derived pieces rather than `z.input<typeof payweaveConfigSchema>`
 * because the `flutterwave` key's preprocess erases its input type (same
 * reason the legacy root hand-assembles `SDKConfig`), and `products` accepts
 * readonly arrays per spec.
 */
export type PayweaveConfig = {
  stripe?: StripeProviderConfig | undefined;
  paystack?: PaystackProviderConfig | undefined;
  flutterwave?: FlutterwaveProviderConfig | undefined;
  defaultProvider?: PayweaveProviderKey | undefined;
  /** The `payweave/db/*` adapter powering the billing surface. */
  database?: DatabaseAdapter | undefined;
  /** `plan()` outputs — plan/feature ids become type-safe. */
  products?: readonly Plan[] | undefined;
  defaultCurrency?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: FetchLike | undefined;
  logger?: Logger | undefined;
  environment?: "test" | "live" | undefined;
};

/**
 * One provider's fully-resolved config — shaped like the legacy
 * {@link ResolvedConfig} (so `createPayweave` builds one `HttpClient` per
 * provider via the same wiring) plus the Stripe-only `apiVersion` passthrough.
 */
export interface ResolvedProviderConfig extends Omit<ResolvedConfig, "provider"> {
  provider: PayweaveProviderKey;
  /** Stripe only — pins the `Stripe-Version` header. */
  apiVersion: string | undefined;
  /** Stripe only — Connect `Stripe-Account` header (`acct_*`), absent for other providers. */
  accountId?: string | undefined;
}

/**
 * One plan AFTER config-parse-time price resolution: `price` is already
 * integer minor units (or `undefined` for a free plan) — no float ever
 * crosses the config boundary. Every other field is exactly what `plan()`
 * returned.
 */
export type ResolvedProduct = Omit<Plan, "price"> & { readonly price: ResolvedPlanPrice | undefined };

/** Fully-resolved keyed root: what `createPayweave` consumes. */
export interface ResolvedPayweaveConfig {
  /** Configured provider keys in canonical order ({@link PAYWEAVE_PROVIDER_KEYS}). */
  providers: readonly PayweaveProviderKey[];
  defaultProvider: PayweaveProviderKey;
  /** Single client-wide environment — mixed test/live is rejected (rule 4). */
  environment: "test" | "live";
  /** Per-provider resolved configs keyed by provider. */
  providerConfigs: Readonly<Partial<Record<PayweaveProviderKey, ResolvedProviderConfig>>>;
  database: DatabaseAdapter | undefined;
  /** Cross-plan-validated, minor-units-resolved products. */
  products: readonly ResolvedProduct[] | undefined;
  defaultCurrency: string | undefined;
  timeoutMs: number;
  maxRetries: number;
  fetch: FetchLike | undefined;
  logger: Logger | undefined;
}

/** Rule 2's exact message. */
const AT_LEAST_ONE_PROVIDER =
  "configure at least one provider — e.g. createPayweave({ stripe: { secretKey } })";

type RootParsed = z.output<typeof payweaveConfigSchema>;

/** Drop `undefined` values so an explicit `{ timeoutMs: undefined }` cannot clobber a root default. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Root transport options merged UNDER each provider key (the sub-config wins). */
function rootTransport(parsed: RootParsed): Record<string, unknown> {
  return compact({
    timeoutMs: parsed.timeoutMs,
    maxRetries: parsed.maxRetries,
    fetch: parsed.fetch,
    logger: parsed.logger,
    environment: parsed.environment,
  });
}

function resolveStripeEntry(
  sub: z.output<typeof stripeProviderConfigSchema>,
  parsed: RootParsed,
): ResolvedProviderConfig {
  const logger = sub.logger ?? parsed.logger;
  const allowInsecureBaseUrl = sub.allowInsecureBaseUrl ?? false;
  // Rule 4: env is key-inferred; an explicit environment (key-level beats root)
  // that conflicts with the prefix throws inside resolveKeyedEnvironment.
  const environment = resolveKeyedEnvironment(
    "stripe",
    sub.secretKey,
    sub.environment ?? parsed.environment,
  );
  const baseUrl = sub.baseUrl ?? STRIPE_BASE_URL;
  guardBaseUrl(baseUrl, allowInsecureBaseUrl, logger, "stripe");
  return {
    provider: "stripe",
    version: undefined,
    environment,
    baseUrl,
    secretKey: sub.secretKey,
    clientId: undefined,
    clientSecret: undefined,
    encryptionKey: undefined,
    webhookSecret: sub.webhookSecret,
    timeoutMs: sub.timeoutMs ?? parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: sub.maxRetries ?? parsed.maxRetries ?? DEFAULT_MAX_RETRIES,
    fetch: sub.fetch ?? parsed.fetch,
    logger,
    allowInsecureBaseUrl,
    tokenUrl: undefined,
    apiVersion: sub.apiVersion,
    accountId: sub.accountId,
  };
}

/**
 * Delegate a paystack/flutterwave key to the legacy {@link resolveConfig} —
 * base-URL defaults, the HTTPS guard, v3/v4 handling, and per-key env
 * inference (rule 4's per-key half) are reused rather than re-implemented.
 */
function resolveLegacyEntry(
  key: "paystack" | "flutterwave",
  sub: object,
  parsed: RootParsed,
): ResolvedProviderConfig {
  const merged = { ...rootTransport(parsed), ...compact({ ...sub }), provider: key };
  return { ...resolveConfig(merged), apiVersion: undefined };
}

// ── Cross-plan validation + price resolution ────────────────────────────────
// These rules need the WHOLE `products` array, unlike `plan()`'s own
// per-plan checks (cross-plan rules belong to config parse, not there).
// Every violation here is a {@link PayweaveConfigError} (a config-parse
// failure); the one exception is the money conversion below, whose
// decimal-guard/amount-bound failures are the spec-fixed
// {@link PayweaveValidationError} from `resolvePlanPricing`, propagated
// unchanged.

/** Rule: plan ids are unique across the whole `products` array. */
function assertUniquePlanIds(products: readonly Plan[]): void {
  const seen = new Set<string>();
  for (const p of products) {
    if (seen.has(p.id)) {
      throw new PayweaveConfigError(
        `duplicate plan id "${p.id}" — plan ids must be unique across products.`,
      );
    }
    seen.add(p.id);
  }
}

/** Rule: at most one `default: true` plan per group. */
function assertOneDefaultPerGroup(products: readonly Plan[]): void {
  const defaultPlanIdByGroup = new Map<string, string>();
  for (const p of products) {
    if (!p.default || p.group === undefined) continue;
    const existing = defaultPlanIdByGroup.get(p.group);
    if (existing !== undefined) {
      throw new PayweaveConfigError(
        `group "${p.group}" has more than one default plan ("${existing}" and "${p.id}") — only one ` +
          "plan per group can be default: true.",
      );
    }
    defaultPlanIdByGroup.set(p.group, p.id);
  }
}

/** Rule: a feature id is never used with conflicting `type`s across plans. */
function assertNoConflictingFeatureTypes(products: readonly Plan[]): void {
  const typeByFeatureId = new Map<string, { type: string; planId: string }>();
  for (const p of products) {
    for (const inclusion of p.includes) {
      const existing = typeByFeatureId.get(inclusion.featureId);
      if (existing === undefined) {
        typeByFeatureId.set(inclusion.featureId, { type: inclusion.type, planId: p.id });
        continue;
      }
      if (existing.type !== inclusion.type) {
        throw new PayweaveConfigError(
          `feature "${inclusion.featureId}" is used as both "${existing.type}" (plan "${existing.planId}") ` +
            `and "${inclusion.type}" (plan "${p.id}") — a feature must have the same type everywhere.`,
        );
      }
    }
  }
}

/**
 * Cross-plan validation + price resolution over the WHOLE `products` array —
 * runs once at config parse, after rule 5 (`products` require `database`)
 * has already passed. In order:
 *
 * 1. plan ids are unique across the array;
 * 2. at most one `default: true` plan per group;
 * 3. a feature id is never used with conflicting `type`s across plans;
 * 4. every paid plan resolves a currency (its own, or `defaultCurrency`) and
 *    converts to integer minor units via {@link resolvePlanPricing} — "neither
 *    present" is this function's own {@link PayweaveConfigError}; the
 *    decimal-guard/amount-bound failures from `resolvePlanPricing` itself are
 *    {@link PayweaveValidationError}, propagated unchanged.
 *
 * Returns `undefined` when `products` was not configured.
 */
function resolveProducts(
  products: readonly Plan[] | undefined,
  defaultCurrency: string | undefined,
): readonly ResolvedProduct[] | undefined {
  if (products === undefined) return undefined;

  assertUniquePlanIds(products);
  assertOneDefaultPerGroup(products);
  assertNoConflictingFeatureTypes(products);

  return products.map((p): ResolvedProduct => {
    if (p.price === undefined) {
      return { ...p, price: undefined };
    }
    const currency = p.price.currency ?? defaultCurrency;
    if (currency === undefined) {
      throw new PayweaveConfigError(
        `plan "${p.id}": price has no currency — set price.currency or configure defaultCurrency.`,
      );
    }
    return { ...p, price: resolvePlanPricing(p, currency) };
  });
}

/**
 * Parse + fully resolve a provider-keyed `createPayweave` config, enforcing
 * six resolution rules in order:
 *
 * 1. strict parse — unknown top-level keys throw (typos like `stipe`);
 * 2. at least one provider key;
 * 3. `defaultProvider` (single-provider default / required with multiple /
 *    must name a configured key);
 * 4. per-key environment inference (Paystack + Flutterwave-v3 + Stripe key
 *    prefixes; Flutterwave v4 explicit), explicit-`environment` conflicts,
 *    and mixed-environment rejection across providers;
 * 5. `products` require `database`;
 * 6. Flutterwave's `version` discriminator stays inside its key (v3 default).
 *
 * Throws {@link PayweaveConfigError} synchronously for every violation.
 */
export function resolvePayweaveConfig(input: unknown): ResolvedPayweaveConfig {
  // Rule 1 — strict parse.
  let parsed: RootParsed;
  try {
    parsed = payweaveConfigSchema.parse(input);
  } catch (err) {
    throw toConfigError(err);
  }

  // Rule 2 — at least one provider key (explicit `undefined` counts as absent).
  const providers = PAYWEAVE_PROVIDER_KEYS.filter((key) => parsed[key] !== undefined);
  const [firstProvider] = providers;
  if (firstProvider === undefined) {
    throw new PayweaveConfigError(AT_LEAST_ONE_PROVIDER);
  }

  // Rule 3 — defaultProvider resolution.
  let defaultProvider: PayweaveProviderKey;
  if (parsed.defaultProvider !== undefined) {
    if (!providers.includes(parsed.defaultProvider)) {
      throw new PayweaveConfigError(
        `defaultProvider "${parsed.defaultProvider}" is not a configured provider — ` +
          `configured: ${providers.join(", ")}.`,
      );
    }
    defaultProvider = parsed.defaultProvider;
  } else if (providers.length === 1) {
    defaultProvider = firstProvider;
  } else {
    throw new PayweaveConfigError(
      `multiple providers configured (${providers.join(", ")}) — set defaultProvider to one of them.`,
    );
  }

  // Rule 4 — resolve each key (per-key inference/conflicts throw inside), then
  // check the explicit root environment and mixed environments across keys.
  const providerConfigs: Partial<Record<PayweaveProviderKey, ResolvedProviderConfig>> = {};
  const environments: Array<readonly [PayweaveProviderKey, "test" | "live"]> = [];
  if (parsed.stripe !== undefined) {
    const entry = resolveStripeEntry(parsed.stripe, parsed);
    providerConfigs.stripe = entry;
    environments.push(["stripe", entry.environment]);
  }
  if (parsed.paystack !== undefined) {
    const entry = resolveLegacyEntry("paystack", parsed.paystack, parsed);
    providerConfigs.paystack = entry;
    environments.push(["paystack", entry.environment]);
  }
  if (parsed.flutterwave !== undefined) {
    const entry = resolveLegacyEntry("flutterwave", parsed.flutterwave, parsed);
    providerConfigs.flutterwave = entry;
    environments.push(["flutterwave", entry.environment]);
  }

  if (parsed.environment !== undefined) {
    for (const [key, env] of environments) {
      if (env !== parsed.environment) {
        throw new PayweaveConfigError(
          `environment "${parsed.environment}" conflicts with the ${key} provider's ` +
            `resolved environment "${env}". Remove the explicit environment or align the ${key} config.`,
          { provider: key },
        );
      }
    }
  }

  const distinctEnvs = new Set(environments.map(([, env]) => env));
  if (distinctEnvs.size > 1) {
    const detail = environments.map(([key, env]) => `${key} is "${env}"`).join(", ");
    throw new PayweaveConfigError(
      `mixed environments across providers — ${detail}. ` +
        "One Payweave client must be all-test or all-live; use separate clients to mix.",
    );
  }
  const firstEnvironment = environments[0];
  if (firstEnvironment === undefined) {
    // Unreachable: `providers` is non-empty (rule 2) and every key resolved.
    throw new PayweaveConfigError(AT_LEAST_ONE_PROVIDER);
  }

  // Rule 5 — products require a database.
  if (parsed.products !== undefined && parsed.database === undefined) {
    throw new PayweaveConfigError("plans need a database — pass a payweave/db/* adapter");
  }

  // Cross-plan validation + price resolution needs the whole array, so it
  // happens here rather than inside `plan()`.
  const products = resolveProducts(parsed.products, parsed.defaultCurrency);

  return {
    providers,
    defaultProvider,
    environment: firstEnvironment[1],
    providerConfigs,
    database: parsed.database,
    products,
    defaultCurrency: parsed.defaultCurrency,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: parsed.maxRetries ?? DEFAULT_MAX_RETRIES,
    fetch: parsed.fetch,
    logger: parsed.logger,
  };
}
