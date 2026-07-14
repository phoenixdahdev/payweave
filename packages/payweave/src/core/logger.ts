/**
 * Structured logging primitives. The SDK NEVER calls `console.*`
 * in `src/`; every diagnostic goes through an injected {@link Logger}. Payloads
 * are always passed through `redact()` before they reach a logger.
 */

/** Categories of structured event the HTTP core and config layer emit. */
export type SdkLogEventType =
  | "request"
  | "response"
  | "retry"
  | "error"
  | "schema_drift"
  | "warn";

/**
 * A single structured log event. `type` is the discriminator; everything else
 * is free-form (already redacted). Consumers pattern-match on `type`.
 */
export interface SdkLogEvent {
  type: SdkLogEventType;
  message?: string;
  [key: string]: unknown;
}

/** Injected logging hook. Provided via SDK config; optional everywhere. */
export type Logger = (event: SdkLogEvent) => void;
