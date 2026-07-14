/**
 * Retry policy (TDD §6.2, PRD §6.4). Full-jitter exponential backoff for
 * network errors and 429/5xx. Eligibility is deliberately conservative: only
 * GETs, or POSTs the caller made idempotent with an `idempotencyKey`. A bare
 * POST (a charge) is NEVER auto-retried.
 */

/** Tunable backoff parameters. */
export interface RetryPolicy {
  /** Max retry attempts AFTER the initial try (TDD default: 2). */
  maxRetries: number;
  /** Base backoff in ms (TDD: 250). */
  baseMs: number;
  /** Backoff cap in ms (TDD: 8000). */
  capMs: number;
}

/** Default retry policy. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseMs: 250,
  capMs: 8_000,
};

/** HTTP statuses that are retryable (transient) per TDD §6.2. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** `Retry-After` is honored but capped at this ceiling. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** True when `status` is one we may retry (given eligibility + attempts left). */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Retry eligibility by method + idempotency. GET is always eligible;
 * any other method is eligible ONLY when the caller supplied an idempotency key.
 * This is what guarantees a bare POST charge is never silently re-sent.
 */
export function isRetryableRequest(method: string, idempotencyKey?: string): boolean {
  return method.toUpperCase() === "GET" || idempotencyKey != null;
}

/**
 * Full-jitter backoff: `random(0, min(cap, base * 2^attempt))`.
 * `attempt` is 0-based (0 = first retry). `rng` is injectable for deterministic
 * tests.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rng: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.floor(rng() * ceiling);
}

/**
 * Parse a `Retry-After` header value — either delta-seconds or an HTTP-date —
 * into milliseconds, capped at {@link RETRY_AFTER_CAP_MS}. Returns `null` when
 * absent or unparseable (caller falls back to computed backoff).
 *
 * @param headerValue - Raw `Retry-After` header (or `null`).
 * @param now - Current epoch ms (injectable for tests).
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;

  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }

  // HTTP-date form
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(0, when - now), RETRY_AFTER_CAP_MS);
  }
  return null;
}
