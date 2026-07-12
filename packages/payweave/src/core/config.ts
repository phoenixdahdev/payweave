/**
 * Config schema, environment inference, and base-URL resolution (TDD §6.5,
 * PRD §6.1). A Zod discriminated union on `provider` (Flutterwave further
 * discriminated on `version`, defaulting to `"v3"`). Invalid config throws
 * {@link PayweaveConfigError} synchronously — we never send a request with a
 * key we cannot classify.
 */
import { z } from "zod";
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

/**
 * Flutterwave union. `version` defaults to `"v3"`: a config object with no
 * `version` key is preprocessed to inject `"v3"` before discrimination, so the
 * v3 credential shape (`secretKey`) is required and `version: "v4"` opts into
 * the OAuth shape (`clientId` + `clientSecret`).
 */
const flutterwaveConfigSchema = z.preprocess((val) => {
  if (val !== null && typeof val === "object" && !Array.isArray(val) && !("version" in val)) {
    return { ...(val as Record<string, unknown>), version: "v3" };
  }
  return val;
}, z.discriminatedUnion("version", [flwV3ConfigSchema, flwV4ConfigSchema]));

/** Top-level SDK config schema (discriminated union on `provider`). */
export const sdkConfigSchema = z.union([paystackConfigSchema, flutterwaveConfigSchema]);

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

/** Defaults (PRD §6.1 CommonConfig). */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Infer `"test" | "live"` from a Paystack / Flutterwave-v3 secret key prefix.
 * Throws {@link PayweaveConfigError} naming the expected prefixes for a
 * malformed/unrecognized key (we never send a request with a key we can't
 * classify). v4 does NOT use this — its environment is explicit.
 */
export function inferEnvironment(
  provider: "paystack" | "flutterwave",
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
  provider: "paystack" | "flutterwave",
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
  provider: "paystack" | "flutterwave",
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
