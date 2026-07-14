/**
 * `pwv_<ulid>` id generation for the SQLite adapter.
 * `src/db/schema.ts`'s `pwIdSchema` requires `pwv_` followed by a
 * 26-character Crockford-Base32 ULID; no ULID generator exists anywhere in
 * `src/` (checked: `src/unified/reference.ts`'s `pwv_`-prefixed generator
 * strips dashes from a `randomUUID()` — 32 hex characters, not a 26-char
 * Crockford ULID, and serves a different purpose (cross-provider references,
 * not row ids), so it is not reused here.
 *
 * This is a minimal, dependency-free ULID implementation (spec:
 * https://github.com/ulid/spec) — no third-party `ulid` package, keeping the
 * SDK's zod-only `dependencies` rule intact. Monotonicity
 * within the same millisecond is NOT implemented (out of scope for row ids
 * that only need to be unique, not strictly sortable under sub-ms bursts);
 * randomness is `node:crypto`'s CSPRNG.
 */
import { randomInt } from "node:crypto";

/** Crockford's Base32 alphabet (32 symbols; excludes I, L, O, U). */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(timeMs: number, len: number): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
    throw new RangeError(`ulid: time must be a non-negative safe integer — got ${timeMs}`);
  }
  let remaining = timeMs;
  let out = "";
  for (let i = 0; i < len; i++) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING.charAt(randomInt(0, ENCODING_LEN));
  }
  return out;
}

/** A fresh ULID (26 chars: 10 time + 16 random), uppercase Crockford Base32. */
export function ulid(timeMs: number = Date.now()): string {
  return encodeTime(timeMs, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

/**
 * A fresh Payweave row id: `pwv_` + a 26-char ULID — matches
 * `src/db/schema.ts`'s `pwIdSchema` exactly.
 */
export function generatePwId(timeMs: number = Date.now()): string {
  return `pwv_${ulid(timeMs)}`;
}
