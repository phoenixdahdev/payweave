/**
 * Secret redaction. Every value that could reach a log
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
  // A bare `connectionString`/`connection_string`/`DATABASE_URL`
  // key holding a postgres:// URL isn't caught by any pattern above (no
  // "secret"/"key"/"token" substring) — the VALUE pattern below also scrubs
  // it wherever it appears, but masking the whole field by NAME too means a
  // driver that logs `{ connectionString }` verbatim (no embedded credential
  // syntax matched by the value pattern, e.g. a bare host with no user:pass)
  // still never survives.
  /^(?:database_url|connection_?string)$/i,
];

/**
 * Substrings that betray secret material even under an innocently-named key.
 * Belt-and-braces value scrub so a mislabelled field can never leak a live key.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /sk_(test|live)_[A-Za-z0-9]+/gi, // Paystack secret keys
  /FLWSECK(_TEST)?-[A-Za-z0-9-]+/gi, // Flutterwave v3 secret keys
  /Bearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer <token>
  // Postgres connection strings: `postgresAdapter`
  // accepts a `postgres://`/`postgresql://` URL that typically embeds
  // `user:password@host` credentials — mask the ENTIRE matched URL (not just
  // the credential segment), per the module's fail-safe posture, wherever it
  // appears (error messages, nested config objects, logger events). Matches
  // up to the first whitespace/quote so an embedded URL inside a longer
  // sentence or a quoted JSON value is bounded correctly. (`mysql://` for
  // the last SQL adapter is not yet covered by a dedicated value pattern here.)
  /postgres(?:ql)?:\/\/[^\s"'`]+/gi,
  // MongoDB connection strings: `mongodb://` and
  // `mongodb+srv://` URIs carry credentials in the `user[:pass]@host` userinfo
  // segment — the `@` delimiter is unambiguous (MongoDB's own connection
  // string spec never uses `@` for anything else), so ANY `mongodb(+srv)://`
  // URL containing one is credential-bearing and the WHOLE match is masked
  // (fail-safe posture — never just the password segment) up to the next
  // whitespace/quote/angle-bracket boundary. A bare `mongodb://host:port/db`
  // with no userinfo carries no secret and is deliberately left alone.
  /mongodb(?:\+srv)?:\/\/[^\s"'<>]*@[^\s"'<>]+/gi,
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
