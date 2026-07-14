/**
 * `pwv_<ulid>` id generation for the MongoDB adapter. Self-contained copy of
 * `src/db/sqlite/id.ts`'s implementation (that
 * module's own header explains why: no ULID generator exists anywhere in
 * `src/`, and pulling in a third-party `ulid` package would violate the SDK's
 * zod-only `dependencies` rule). Every first-party adapter
 * that needs `pwv_` ids keeps its own copy rather than reaching across
 * `src/db/<other-adapter>/` — adapter directories are disjoint by design,
 * safe to develop in parallel.
 *
 * `pw_customers`/`pw_plans`/`pw_subscriptions`/`pw_feature_balances` use this
 * as their MongoDB `_id` — documents use the row schemas
 * verbatim with `id` stored as `_id`. `pw_webhook_events`/`pw_migrations`
 * are the documented exceptions — natural keys (`dedupeKey`/`name`) ARE their
 * `_id`, no ULID involved.
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
