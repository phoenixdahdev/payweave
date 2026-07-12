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
} from "./http";

export {
  defineProvider,
  type ProviderAdapter,
  type ProviderEvent,
  type UnifiedEvent,
  type UnifiedOps,
  type EnvSpec,
  type HeaderLookup,
} from "./provider";

export { SDK_VERSION } from "./version";
