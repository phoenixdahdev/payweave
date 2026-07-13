/**
 * `pwv_<ulid>` id generation for the Drizzle adapter (docs/v1/database.md §2,
 * PW-708). Deliberately self-contained — NOT imported from
 * `src/db/sqlite/id.ts` (that directory is PW-706's, read-only for this
 * ticket) — each first-party adapter owns an independent copy so the
 * disjoint-directory parallel-safety the epic brief describes
 * (`epic-07-database.md` PW-704…709 preamble) holds for real, not just by
 * convention. This is a minimal, dependency-free ULID implementation (spec:
 * https://github.com/ulid/spec) — no third-party `ulid` package, keeping the
 * SDK's zod-only `dependencies` rule intact (database.md §7). Monotonicity
 * within the same millisecond is NOT implemented (row ids only need to be
 * unique, not strictly sortable under sub-ms bursts); randomness is
 * `node:crypto`'s CSPRNG.
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
