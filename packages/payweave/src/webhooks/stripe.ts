/**
 * Stripe webhook verification (providers.md §3.4, PW-606). HMAC-SHA256 over
 * `${t}.${rawBody}` keyed with the endpoint signing secret (`whsec_*`), hex
 * digest. The `stripe-signature` header carries `t=<unix seconds>` plus one
 * `v1=<hex hmac>` per active secret (several during a key roll — accept if ANY
 * matches); non-`v1` schemes (`v0` is a fake, test-only scheme) are ignored to
 * prevent downgrade attacks. Timing-safe with a length-guard on EVERY `v1`
 * candidate; replays outside ±`toleranceSec` (default 300s, Stripe's library
 * default of 5 minutes) are rejected in both directions. Fails closed on a
 * missing/malformed header, missing/non-numeric `t`, no `v1`, or empty secret.
 *
 * Docs: https://docs.stripe.com/webhooks#verify-manually
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Stripe's documented library default tolerance: 5 minutes. */
const DEFAULT_TOLERANCE_SEC = 300;

/** Options for {@link verifyStripe}. */
export interface VerifyStripeOptions {
  /** Max allowed `|now − t|` in seconds. Default `300` (Stripe's 5 minutes). */
  toleranceSec?: number;
  /** Clock returning Unix SECONDS — injectable for tests. Default: `Date.now()/1000`. */
  now?: () => number;
}

/** Sibling length-guarded `timingSafeEqual` (paystack/flutterwave-v4 pattern). */
function matchesExpected(expected: Buffer, candidate: string): boolean {
  const received = Buffer.from(candidate, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * @param rawBody - Exact received bytes (never a re-serialized object).
 * @param signatureHeader - Value of the `stripe-signature` header.
 * @param webhookSecret - Endpoint signing secret (`whsec_*`) — NOT the API key.
 * @param options - Tolerance override / injectable clock (tests only).
 * @returns `true` iff any `v1` signature matches AND `t` is within tolerance;
 *   `false` otherwise (never throws).
 */
export function verifyStripe(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
  options?: VerifyStripeOptions,
): boolean {
  // Runtime type guards: the "never throws" contract must hold for plain-JS
  // callers passing wrong types — fail closed instead. NOTE: an empty STRING
  // body stays accepted (Stripe signs `${t}.` over it); only wrong types and
  // an empty secret are rejected here.
  if (typeof webhookSecret !== "string" || webhookSecret.length === 0) return false;
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) return false;
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) return false;

  // Parse `t=...,v1=...[,v1=...,v0=...]`. Whole items are trimmed because
  // proxies may normalize comma-separated headers with `, `; whitespace INSIDE
  // an item (e.g. `t =123`) still fails closed. Unknown schemes are skipped
  // (never verified); an item without `=` or a duplicate `t` is malformed —
  // fail closed.
  let timestampRaw: string | undefined;
  const candidates: string[] = [];
  for (const rawItem of signatureHeader.split(",")) {
    const item = rawItem.trim();
    const eq = item.indexOf("=");
    if (eq === -1) return false;
    const scheme = item.slice(0, eq);
    const value = item.slice(eq + 1);
    if (scheme === "t") {
      if (timestampRaw !== undefined) return false;
      timestampRaw = value;
    } else if (scheme === "v1") {
      candidates.push(value);
    }
  }
  if (timestampRaw === undefined || !/^\d+$/.test(timestampRaw)) return false;
  if (candidates.length === 0) return false;

  const timestamp = Number(timestampRaw);
  const nowSec = options?.now !== undefined ? options.now() : Math.floor(Date.now() / 1000);
  const toleranceSec = options?.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const withinTolerance = Math.abs(nowSec - timestamp) <= toleranceSec;

  // Sign `${t}.` + the raw body bytes exactly as received (two updates so a
  // Uint8Array body is never decoded/re-encoded).
  const hmac = createHmac("sha256", webhookSecret);
  hmac.update(`${timestampRaw}.`);
  hmac.update(rawBody);
  const expected = Buffer.from(hmac.digest("hex"), "utf8");

  // Compare EVERY candidate timing-safely — no early exit, so observable time
  // never depends on which (if any) signature matched. Non-hex or wrong-length
  // candidates simply fail the comparison (fail closed).
  let matched = false;
  for (const candidate of candidates) {
    matched = matchesExpected(expected, candidate) || matched;
  }

  return withinTolerance && matched;
}
