/**
 * Payweave — one SDK, every provider, woven together.
 *
 * Public facade (TDD §7.1): `createPaystack`, `createFlutterwave`, and the
 * callable-or-`new` `PaymentSDK` factory with compile-time provider narrowing.
 * Surface A resources and the unified layer are filled in later waves — the
 * client shells and typed stubs are wired here now.
 */
import { PayweaveError, PayweaveConfigError, type PayweaveProvider } from "./core/errors";
import {
  resolveConfig,
  type ResolvedConfig,
  type SDKConfig,
  type PaystackConfig,
  type FlutterwaveConfig,
} from "./core/config";
import { HttpClient, bearer, oauthClientCredentials, type AuthStrategy } from "./core/http";
import type { HeaderLookup } from "./core/provider";
import { SDK_VERSION } from "./core/version";
import { verifyPaystack } from "./webhooks/paystack";
import { verifyFlutterwaveV3 } from "./webhooks/flutterwave";
import { verifyFlutterwaveV4 } from "./webhooks/flutterwave-v4";
import { constructEvent as constructWebhookEvent, type WebhookEvent } from "./webhooks/index";
import { PaystackClient } from "./paystack/client";
import { FlutterwaveClient } from "./flutterwave/client";

export { SDK_VERSION as VERSION } from "./core/version";

// Re-export the config types + core errors consumers need to type their code.
export type {
  SDKConfig,
  PaystackConfig,
  FlutterwaveConfig,
  FlutterwaveV3Config,
  FlutterwaveV4Config,
  ResolvedConfig,
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
export type { WebhookEvent } from "./webhooks/index";

// ── Webhooks namespace ───────────────────────────────────────────────────────
/** Raw-body + headers input shared by every webhook operation (TDD §10). */
export interface WebhookInput {
  /** Exact received bytes — never a re-serialized object. */
  rawBody: string | Uint8Array;
  /** `Headers` or a plain/array header map; looked up case-insensitively. */
  headers: HeaderLookup;
}

/** The `sdk.webhooks` surface. */
export interface WebhooksNamespace {
  /** Verify a webhook signature (timing-safe, fails closed). */
  verify(input: WebhookInput): boolean;
  /** Verify or throw {@link PayweaveWebhookVerificationError}. */
  verifyOrThrow(input: WebhookInput): void;
  /** Verify + parse + normalize into a typed {@link WebhookEvent}. */
  constructEvent(input: WebhookInput): WebhookEvent;
}

function getHeader(headers: HeaderLookup, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function createWebhooks(resolved: ResolvedConfig): WebhooksNamespace {
  const provider = resolved.provider;

  function verify(input: WebhookInput): boolean {
    if (provider === "paystack") {
      // Paystack: webhookSecret is unsupported; the API secret key is the HMAC key.
      const secret = resolved.webhookSecret ?? resolved.secretKey;
      if (!secret) {
        throw new PayweaveConfigError("Missing Paystack secret key for webhook verification.", {
          provider,
        });
      }
      return verifyPaystack(input.rawBody, getHeader(input.headers, "x-paystack-signature"), secret);
    }
    // Flutterwave (v3 + v4): the dashboard secret hash is REQUIRED — fail closed.
    if (!resolved.webhookSecret) {
      throw new PayweaveConfigError(
        "Flutterwave webhook verification requires `webhookSecret` (the dashboard secret hash).",
        { provider },
      );
    }
    if (resolved.version === "v4") {
      return verifyFlutterwaveV4(
        input.rawBody,
        getHeader(input.headers, "flutterwave-signature"),
        resolved.webhookSecret,
      );
    }
    return verifyFlutterwaveV3(getHeader(input.headers, "verif-hash"), resolved.webhookSecret);
  }

  return {
    verify,
    verifyOrThrow(input) {
      if (!verify(input)) {
        throw new PayweaveError("Webhook signature verification failed.", {
          provider,
          isRetryable: false,
        });
      }
    },
    constructEvent(input: WebhookInput): WebhookEvent {
      // Delegate to the webhooks/ normalizer, reusing THIS namespace's verify
      // dispatch (provider + version already bound) — verification stays in the
      // timing-safe primitives and is never re-implemented here.
      return constructWebhookEvent({
        rawBody: input.rawBody,
        headers: input.headers,
        provider,
        version: resolved.version,
        verify,
        logger: resolved.logger,
      });
    },
  };
}

// ── Unified namespace (typed stubs) ──────────────────────────────────────────
/** The `sdk.unified` surface (Surface B). Stubs throw until a later wave. */
export interface UnifiedNamespace {
  checkout: { create(input: unknown): Promise<never> };
  verify(input: unknown): Promise<never>;
  refunds: { create(input: unknown): Promise<never> };
  transfers: { create(input: unknown): Promise<never> };
  banks: {
    list(input: unknown): Promise<never>;
    resolveAccount(input: unknown): Promise<never>;
  };
}

function notImplemented(feature: string, provider: PayweaveProvider): never {
  throw new PayweaveError(`unified.${feature} is not yet implemented (lands in a later wave).`, {
    provider,
  });
}

function createUnified(provider: PayweaveProvider): UnifiedNamespace {
  return {
    checkout: { create: () => notImplemented("checkout.create", provider) },
    verify: () => notImplemented("verify", provider),
    refunds: { create: () => notImplemented("refunds.create", provider) },
    transfers: { create: () => notImplemented("transfers.create", provider) },
    banks: {
      list: () => notImplemented("banks.list", provider),
      resolveAccount: () => notImplemented("banks.resolveAccount", provider),
    },
  };
}

// ── HTTP wiring ──────────────────────────────────────────────────────────────
function buildAuth(resolved: ResolvedConfig): AuthStrategy {
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

function buildHttpClient(resolved: ResolvedConfig): HttpClient {
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

// ── SDK classes ──────────────────────────────────────────────────────────────
/**
 * Shared base for every provider SDK. Exposes readonly `provider` +
 * `environment`, and holds the shared {@link HttpClient} plus the `webhooks` and
 * `unified` namespaces. `version` is declared on the Flutterwave subclasses only
 * (Paystack clients expose no `version`, per PRD §6.1).
 */
abstract class BaseSDK {
  readonly provider: PayweaveProvider;
  readonly environment: "test" | "live";
  /** Shared HTTP client — protected so provider clients/resources use it. */
  protected readonly http: HttpClient;
  readonly webhooks: WebhooksNamespace;
  readonly unified: UnifiedNamespace;

  protected constructor(resolved: ResolvedConfig) {
    this.provider = resolved.provider;
    this.environment = resolved.environment;
    this.http = buildHttpClient(resolved);
    this.webhooks = createWebhooks(resolved);
    this.unified = createUnified(resolved.provider);
  }
}

/** Paystack SDK — Surface A under `.paystack`. No `version` (Paystack is unversioned). */
export class PaystackSDK extends BaseSDK {
  override readonly provider = "paystack" as const;
  readonly paystack: PaystackClient;

  constructor(resolved: ResolvedConfig) {
    super(resolved);
    this.paystack = new PaystackClient(this.http);
  }
}

/** Flutterwave v3 SDK — Surface A under `.flutterwave`; `version: "v3"`. */
export class FlutterwaveV3SDK extends BaseSDK {
  override readonly provider = "flutterwave" as const;
  readonly version = "v3" as const;
  readonly flutterwave: FlutterwaveClient;

  constructor(resolved: ResolvedConfig) {
    super(resolved);
    this.flutterwave = new FlutterwaveClient(this.http, "v3", resolved.encryptionKey);
  }
}

/** Flutterwave v4 SDK — Surface A under `.flutterwave`; `version: "v4"`. */
export class FlutterwaveV4SDK extends BaseSDK {
  override readonly provider = "flutterwave" as const;
  readonly version = "v4" as const;
  readonly flutterwave: FlutterwaveClient;

  constructor(resolved: ResolvedConfig) {
    super(resolved);
    this.flutterwave = new FlutterwaveClient(this.http, "v4");
  }
}

/** Union of the concrete Flutterwave surfaces. */
export type FlutterwaveSDK = FlutterwaveV3SDK | FlutterwaveV4SDK;

// ── Factories + narrowing ────────────────────────────────────────────────────
/**
 * Map a config type to its concrete SDK surface at compile time (TDD §7.1).
 * A `const` generic on the factories preserves inline literals so this resolves
 * without `as const`.
 */
export type PaymentSDKFor<C extends SDKConfig> = C extends { provider: "paystack" }
  ? PaystackSDK
  : C extends { provider: "flutterwave"; version: "v4" }
    ? FlutterwaveV4SDK
    : C extends { provider: "flutterwave" }
      ? FlutterwaveV3SDK
      : never;

/** Narrow a `createFlutterwave` config to v3 or v4. */
export type FlutterwaveSDKFor<C> = C extends { version: "v4" }
  ? FlutterwaveV4SDK
  : FlutterwaveV3SDK;

/** `Omit` that distributes over unions, preserving each member's own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function instantiate(resolved: ResolvedConfig): PaystackSDK | FlutterwaveSDK {
  if (resolved.provider === "paystack") return new PaystackSDK(resolved);
  if (resolved.version === "v4") return new FlutterwaveV4SDK(resolved);
  return new FlutterwaveV3SDK(resolved);
}

/** Create a fully-typed Paystack SDK. */
export function createPaystack<const C extends Omit<PaystackConfig, "provider">>(
  cfg: C,
): PaystackSDK {
  return new PaystackSDK(resolveConfig({ ...cfg, provider: "paystack" }));
}

/** Create a fully-typed Flutterwave SDK (v3 unless `version: "v4"`). */
export function createFlutterwave<const C extends DistributiveOmit<FlutterwaveConfig, "provider">>(
  cfg: C,
): FlutterwaveSDKFor<C> {
  const resolved = resolveConfig({ ...cfg, provider: "flutterwave" });
  return instantiate(resolved) as FlutterwaveSDKFor<C>;
}

/** Callable-or-`new` SDK factory with provider narrowing (TDD §7.1). */
export interface PaymentSDKFactory {
  <const C extends SDKConfig>(cfg: C): PaymentSDKFor<C>;
  new <const C extends SDKConfig>(cfg: C): PaymentSDKFor<C>;
}

/**
 * The headline entry point. Works called or `new`'d; the return type narrows to
 * the configured provider's surface.
 *
 * @example
 * const ps = new PaymentSDK({ provider: "paystack", secretKey });   // PaystackSDK
 * const fw = PaymentSDK({ provider: "flutterwave", secretKey });    // FlutterwaveV3SDK
 */
export const PaymentSDK: PaymentSDKFactory = function PaymentSDK<const C extends SDKConfig>(
  cfg: C,
): PaymentSDKFor<C> {
  return instantiate(resolveConfig(cfg)) as unknown as PaymentSDKFor<C>;
} as PaymentSDKFactory;
