// core/ — HttpClient, retry, errors, Money, config, redact, provider contract.
// Public subpath: `payweave/core`.

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
  mapHttpError,
  type PayweaveProvider,
  type PayweaveErrorOptions,
  type MapHttpErrorExtra,
} from "./errors";

export { redact, REDACTED } from "./redact";

export type { Logger, SdkLogEvent, SdkLogEventType } from "./logger";

export {
  type Money,
  CURRENCY_EXPONENTS,
  DEFAULT_EXPONENT,
  exponentFor,
  money,
  assertMoney,
  toMajor,
  toMinor,
} from "./money";

export {
  PAYSTACK_BASE_URL,
  FLW_V3_BASE_URL,
  FLW_V4_BASE_URL,
  FLW_V4_SANDBOX_URL,
  FLW_V4_TOKEN_URL,
  STRIPE_BASE_URL,
  STRIPE_API_VERSION,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  sdkConfigSchema,
  resolveConfig,
  inferEnvironment,
  type ResolvedConfig,
  type SDKConfig,
  type PaystackConfig,
  type FlutterwaveConfig,
  type FlutterwaveV3Config,
  type FlutterwaveV4Config,
  // v1 provider-keyed root — `createPayweave` mounts on these.
  PAYWEAVE_PROVIDER_KEYS,
  payweaveConfigSchema,
  resolvePayweaveConfig,
  stripeProviderConfigSchema,
  paystackProviderConfigSchema,
  flutterwaveProviderConfigSchema,
  type PayweaveProviderKey,
  type PayweaveConfig,
  type StripeProviderConfig,
  type PaystackProviderConfig,
  type FlutterwaveProviderConfig,
  type ResolvedProviderConfig,
  type ResolvedPayweaveConfig,
  // Cross-plan-validated, minor-units-resolved `products` — the real
  // `Plan` type itself lives on the `payweave/products` subpath.
  type ResolvedProduct,
} from "./config";

export {
  DEFAULT_RETRY_POLICY,
  RETRYABLE_STATUSES,
  RETRY_AFTER_CAP_MS,
  isRetryableStatus,
  isRetryableRequest,
  backoffDelay,
  parseRetryAfter,
  type RetryPolicy,
} from "./retry";

export {
  HttpClient,
  bearer,
  oauthClientCredentials,
  type AuthStrategy,
  type HttpClientOptions,
  type RequestOptions,
  type QueryValue,
  type BodyEncoder,
  type EncodedBody,
} from "./http";

export {
  defineProvider,
  readHeader,
  type ProviderAdapter,
  type ProviderEvent,
  type UnifiedEvent,
  type UnifiedOps,
  type BillingOps,
  type EnvSpec,
  type HeaderLookup,
} from "./provider";

export { SDK_VERSION } from "./version";
