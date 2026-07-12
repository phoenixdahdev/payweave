/**
 * Error taxonomy (PRD §6.3, TDD §6.3). One base class + eight subclasses; a
 * single {@link mapHttpError} converts an HTTP status + body into the right
 * class. `toJSON()` is always safe to log — `raw` is passed through `redact()`.
 * Public SDK methods MUST only ever throw a {@link PayweaveError} subclass.
 */
import { redact } from "./redact";

/** Providers the SDK targets. `"unknown"` covers pre-classification failures. */
export type PayweaveProvider = "paystack" | "flutterwave";

/**
 * Common shape carried by every Payweave error. Optional fields explicitly
 * include `undefined` so they can be built from possibly-undefined values under
 * `exactOptionalPropertyTypes`.
 */
export interface PayweaveErrorOptions {
  provider?: PayweaveProvider | "unknown" | undefined;
  httpStatus?: number | undefined;
  providerCode?: string | undefined;
  providerMessage?: string | undefined;
  requestId?: string | undefined;
  raw?: unknown;
  isRetryable?: boolean | undefined;
  cause?: unknown;
}

/**
 * Base class for every error the SDK throws. Never thrown directly for HTTP
 * failures — use {@link mapHttpError} — but usable for bespoke conditions.
 */
export class PayweaveError extends Error {
  readonly provider: PayweaveProvider | "unknown";
  readonly httpStatus: number | undefined;
  readonly providerCode: string | undefined;
  readonly providerMessage: string | undefined;
  readonly requestId: string | undefined;
  readonly raw: unknown;
  readonly isRetryable: boolean;

  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PayweaveError";
    this.provider = options.provider ?? "unknown";
    this.httpStatus = options.httpStatus;
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage;
    this.requestId = options.requestId;
    this.raw = options.raw;
    this.isRetryable = options.isRetryable ?? false;
    // Cleaner stack traces on V8.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, new.target);
    }
  }

  /** Serialization that is always safe to log — `raw` is redacted. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      providerMessage: this.providerMessage,
      requestId: this.requestId,
      isRetryable: this.isRetryable,
      raw: redact(this.raw),
    };
  }
}

/** Bad/missing keys, provider mismatch, env conflict — thrown synchronously. */
export class PayweaveConfigError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: false, ...options });
    this.name = "PayweaveConfigError";
  }
}

/** 401 / invalid credentials. Not retryable. */
export class PayweaveAuthError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: false, ...options });
    this.name = "PayweaveAuthError";
  }
}

/** 400/422 or a local Zod validation failure before sending. Not retryable. */
export class PayweaveValidationError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: false, ...options });
    this.name = "PayweaveValidationError";
  }
}

/** 404 — unknown reference, recipient, resource. Not retryable. */
export class PayweaveNotFoundError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: false, ...options });
    this.name = "PayweaveNotFoundError";
  }
}

/** 429 — exposes `retryAfterMs` when the provider sent a `Retry-After`. */
export class PayweaveRateLimitError extends PayweaveError {
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    options: PayweaveErrorOptions & { retryAfterMs?: number } = {},
  ) {
    const { retryAfterMs, ...rest } = options;
    super(message, { isRetryable: true, ...rest });
    this.name = "PayweaveRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

/** 5xx or a provider-reported processing failure. Retryable. */
export class PayweaveProviderError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: true, ...options });
    this.name = "PayweaveProviderError";
  }
}

/** Timeout / DNS / connection reset. Always retryable (`isRetryable = true`). */
export class PayweaveNetworkError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { ...options, isRetryable: true });
    this.name = "PayweaveNetworkError";
  }
}

/** Signature mismatch / malformed webhook. Fails closed. Not retryable. */
export class PayweaveWebhookVerificationError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: false, ...options });
    this.name = "PayweaveWebhookVerificationError";
  }
}

/** Fields pulled defensively out of a provider error envelope. */
interface ExtractedBody {
  providerMessage: string | undefined;
  providerCode: string | undefined;
  requestId: string | undefined;
}

function extractBody(body: unknown): ExtractedBody {
  if (body === null || typeof body !== "object") {
    return { providerMessage: undefined, providerCode: undefined, requestId: undefined };
  }
  const rec = body as Record<string, unknown>;
  const message = typeof rec.message === "string" ? rec.message : undefined;
  const codeRaw = rec.code ?? rec.errorCode ?? rec.error_code ?? rec.type;
  const code =
    typeof codeRaw === "string"
      ? codeRaw
      : typeof codeRaw === "number"
        ? String(codeRaw)
        : undefined;
  const idRaw = rec.requestId ?? rec.request_id ?? rec.reference;
  const requestId = typeof idRaw === "string" ? idRaw : undefined;
  return { providerMessage: message, providerCode: code, requestId };
}

/** Extra signals the HTTP layer already parsed (headers) and can pass down. */
export interface MapHttpErrorExtra {
  retryAfterMs?: number;
  requestId?: string;
}

/**
 * The single status → error-class mapping used everywhere (TDD §6.3). No
 * per-resource error mapping is permitted. `body` is the parsed provider
 * envelope (or `undefined`); `extra` carries header-derived signals.
 *
 * - 401 → {@link PayweaveAuthError}
 * - 400 / 422 → {@link PayweaveValidationError}
 * - 404 → {@link PayweaveNotFoundError}
 * - 429 → {@link PayweaveRateLimitError} (with `retryAfterMs`)
 * - 5xx → {@link PayweaveProviderError} (retryable)
 * - everything else → {@link PayweaveProviderError}
 */
export function mapHttpError(
  provider: PayweaveProvider,
  status: number,
  body: unknown,
  extra: MapHttpErrorExtra = {},
): PayweaveError {
  const { providerMessage, providerCode, requestId } = extractBody(body);
  const base: PayweaveErrorOptions = {
    provider,
    httpStatus: status,
    providerCode,
    providerMessage,
    requestId: extra.requestId ?? requestId,
    raw: body,
  };
  const summary = providerMessage ? `: ${providerMessage}` : "";

  if (status === 401 || status === 403) {
    return new PayweaveAuthError(
      `${provider} authentication failed (${status})${summary}`,
      base,
    );
  }
  if (status === 400 || status === 422) {
    return new PayweaveValidationError(
      `${provider} rejected the request (${status})${summary}`,
      base,
    );
  }
  if (status === 404) {
    return new PayweaveNotFoundError(`${provider} resource not found (404)${summary}`, base);
  }
  if (status === 429) {
    return new PayweaveRateLimitError(
      `${provider} rate limit exceeded (429)${summary}`,
      extra.retryAfterMs !== undefined ? { ...base, retryAfterMs: extra.retryAfterMs } : base,
    );
  }
  if (status >= 500) {
    return new PayweaveProviderError(`${provider} server error (${status})${summary}`, base);
  }
  return new PayweaveProviderError(
    `${provider} returned an unexpected status (${status})${summary}`,
    { ...base, isRetryable: false },
  );
}
