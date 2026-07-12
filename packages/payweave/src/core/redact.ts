/**
 * Secret redaction (TDD §12/§15, PRD §6.3). Every value that could reach a log
 * sink or an error's `toJSON()` is passed through {@link redact} first. Fails
 * safe: on any doubt, mask. This is a security-critical module — the redaction
 * unit tests are release-blocking (no `sk_`, `FLWSECK`, `Authorization` bearer
 * material, or PAN may survive serialization).
 */

/** Replacement token substituted for any masked value. */
export const REDACTED = "[REDACTED]";

/**
 * Key names (matched case-insensitively) whose VALUES must always be masked.
 * Covers auth headers, every `*secret*`/`*key*`/`*token*` field, and the card
 * data enumerated in the security checklist (PAN, CVV, expiry, PIN).
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /authorization/i,
  /secret/i,
  /key/i, // secretKey, encryptionKey, apiKey, publicKey, api_key, ...
  /token/i, // access_token, refresh_token — v4 OAuth tokens
  /authorization_code/i,
  /card[_-]?number/i,
  /^pan$/i,
  /cvv|cvc|cvn/i,
  /^expiry/i, // expiry, expiryMonth, expiry_year, expiryDate
  /^exp[_-]?(month|year)$/i,
  /^pin$/i,
  /password/i,
];

/**
 * Substrings that betray secret material even under an innocently-named key.
 * Belt-and-braces value scrub so a mislabelled field can never leak a live key.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /sk_(test|live)_[A-Za-z0-9]+/gi, // Paystack secret keys
  /FLWSECK(_TEST)?-[A-Za-z0-9-]+/gi, // Flutterwave v3 secret keys
  /Bearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer <token>
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function scrubString(value: string): string {
  let out = value;
  for (const re of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Deep-clone `value`, masking any sensitive key's value and scrubbing secret
 * material from strings. Handles plain objects, arrays, `Headers`, `Map`, and
 * cyclic references. Non-plain objects (Error, Date, etc.) are stringified
 * defensively rather than walked.
 *
 * @param value - Arbitrary, untrusted data (request/response body, headers).
 * @returns A redacted structural copy safe to serialize and log.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet());
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;

  // Web Headers → plain object (so header keys are subject to masking).
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    const obj: Record<string, unknown> = {};
    value.forEach((v, k) => {
      obj[k] = isSensitiveKey(k) ? REDACTED : scrubString(v);
    });
    return obj;
  }

  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const key = String(k);
      obj[key] = isSensitiveKey(key) ? REDACTED : redactInner(v, seen);
    }
    return obj;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out = value.map((v) => redactInner(v, seen));
    seen.delete(value);
    return out;
  }

  if (typeof value === "object") {
    // Uint8Array / Buffer and other binary — never inspect contents.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return "[binary]";
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactInner(v, seen);
    }
    seen.delete(value);
    return out;
  }

  return undefined;
}
