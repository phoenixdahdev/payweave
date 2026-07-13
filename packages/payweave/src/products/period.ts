/**
 * Billing-period math for metered features (metered-usage.md §5, PW-901).
 *
 * All arithmetic is UTC on epoch milliseconds — no timezone or DST logic in v1
 * (metered-usage.md §5). `day`/`week` are fixed 86_400_000 / 604_800_000 ms
 * multiples of the anchor; UTC has no DST, so a "day" is always exactly 24h.
 *
 * THE invariant: period math is ANCHOR-RELATIVE. Period `n` is
 * `[advance(anchor, reset, n), advance(anchor, reset, n + 1))` — every
 * boundary is derived by adding `n` whole intervals to the ORIGINAL anchor,
 * with end-of-month clamping applied once per result. Iterating `advance` on
 * clamped outputs is forbidden: a Jan 31 anchor yields Feb 28/29, **Mar 31**,
 * Apr 30, May 31, … — never the drifted Jan 31 → Feb 28 → Mar 28 → … sequence.
 *
 * These functions are internal until PW-505 wires `src/products/` into the
 * exports map; PW-902 consumes them for the lazy reset inside
 * `balances.consume`.
 */
import { PayweaveValidationError } from "../core/errors";

/** Reset interval for a metered feature (plans-and-features.md §2). */
export type ResetInterval = "day" | "week" | "month" | "year";

/** Exactly 24 UTC hours in milliseconds (metered-usage.md §5). */
export const DAY_MS = 86_400_000;

/** Exactly 7 UTC days in milliseconds (metered-usage.md §5). */
export const WEEK_MS = 604_800_000;

/**
 * One billing period, half-open: `start` inclusive, `end` exclusive. All
 * values are UTC epoch milliseconds; `index` is the zero-based period number
 * relative to the anchor (period 0 starts AT the anchor).
 */
export type BillingPeriod = { index: number; start: number; end: number };

/** Throws unless `value` is an integer epoch-milliseconds timestamp. */
function assertEpochMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new PayweaveValidationError(
      `${name} must be an integer epoch-milliseconds timestamp — got ${value}`,
    );
  }
}

/** Throws unless `value` is a safe integer >= `min`. */
function assertCount(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new PayweaveValidationError(`${name} must be a safe integer >= ${min} — got ${value}`);
  }
}

/** Number of days in a UTC month (`monthIndex` 0-based, any overflow-free year). */
function daysInUtcMonth(year: number, monthIndex: number): number {
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add whole calendar months to an anchor instant, clamping the day-of-month
 * to the target month's length ONCE for this result. Time of day is preserved
 * verbatim (UTC components).
 */
function addUtcMonthsClamped(anchorMs: number, months: number): number {
  const anchor = new Date(anchorMs);
  const totalMonths = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(totalMonths / 12);
  const monthIndex = ((totalMonths % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthIndex));
  return Date.UTC(
    year,
    monthIndex,
    day,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

/**
 * Advance an anchor instant by `count` whole reset intervals
 * (metered-usage.md §5's `advance(anchor, reset, n)`).
 *
 * - `day` / `week`: fixed {@link DAY_MS} / {@link WEEK_MS} multiples — pure
 *   integer ms arithmetic, DST-free by construction (UTC).
 * - `month` / `year`: calendar addition on the ANCHOR's UTC components with
 *   end-of-month clamping applied once to the result. A Jan 31 anchor gives
 *   Feb 28 (Feb 29 in leap years) at `count` 1 and Mar 31 at `count` 2. A
 *   Feb 29 anchor advanced whole years (or multiples of 12 months) lands on
 *   Feb 29 in leap years and clamps to Feb 28 otherwise.
 *
 * `count` must be a non-negative safe integer — period boundaries never look
 * backwards from the anchor. Throws {@link PayweaveValidationError} on invalid
 * input or when the result falls outside the representable Date range.
 *
 * @example advance(Date.UTC(2025, 0, 31), "month", 1) // Date.UTC(2025, 1, 28)
 * @example advance(Date.UTC(2025, 0, 31), "month", 2) // Date.UTC(2025, 2, 31) — no drift
 */
export function advance(anchorMs: number, reset: ResetInterval, count: number): number {
  assertEpochMs(anchorMs, "anchorMs");
  assertCount(count, "count", 0);
  let result: number;
  switch (reset) {
    case "day":
      result = anchorMs + count * DAY_MS;
      break;
    case "week":
      result = anchorMs + count * WEEK_MS;
      break;
    case "month":
      result = addUtcMonthsClamped(anchorMs, count);
      break;
    case "year":
      result = addUtcMonthsClamped(anchorMs, count * 12);
      break;
    default: {
      const invalid: never = reset;
      throw new PayweaveValidationError(`unknown reset interval: ${String(invalid)}`);
    }
  }
  if (!Number.isSafeInteger(result)) {
    throw new PayweaveValidationError(
      `advance(${anchorMs}, '${reset}', ${count}) is outside the representable date range`,
    );
  }
  return result;
}

/**
 * Multi-period roll-forward (metered-usage.md §5's lazy reset): the CURRENT
 * billing period for `nowMs` — the smallest `index >= 0` with
 * `nowMs < advance(anchorMs, reset, (index + 1) * every)`. A balance row idle
 * for many periods lands directly in the window containing `nowMs`, never an
 * intermediate one. Runs in O(1): a calendar estimate corrected by at most a
 * couple of exact `advance` probes.
 *
 * Boundaries are half-open — `nowMs` exactly at a period end belongs to the
 * NEXT period. Every boundary is derived anchor-relatively via {@link advance},
 * so end-of-month clamping never drifts the cycle day (Jan 31 anchor, now in
 * mid-March → period `[Feb 28, Mar 31)`, not `[…, Mar 28)`).
 *
 * `nowMs` before the anchor clamps to period 0 (`[anchor, advance(anchor, …, every))`).
 * The spec is silent here: anchors are seeded at or before first use, so an
 * earlier `nowMs` means clock skew, and the conservative behavior for the
 * consume path is the first period rather than a throw.
 *
 * `every` (default 1) is the number of reset intervals per period, for
 * multi-interval cycles such as quarterly (`reset: "month", every: 3`). The
 * v1 plan schema always uses 1.
 *
 * @example currentPeriod(Date.UTC(2025, 0, 31), "month", Date.UTC(2025, 2, 15))
 * // { index: 1, start: Date.UTC(2025, 1, 28), end: Date.UTC(2025, 2, 31) }
 */
export function currentPeriod(
  anchorMs: number,
  reset: ResetInterval,
  nowMs: number,
  every: number = 1,
): BillingPeriod {
  assertEpochMs(anchorMs, "anchorMs");
  assertEpochMs(nowMs, "nowMs");
  assertCount(every, "every", 1);

  // O(1) estimate of the period index. `estimate` is at most `true index + 1`
  // (float rounding for day/week; calendar-month distance ignores day-of-month
  // and time-of-day for month/year), so `estimate - 1` NEVER overshoots the
  // true index and undershoots it by at most 2.
  let estimate: number;
  if (reset === "day" || reset === "week") {
    const periodMs = (reset === "day" ? DAY_MS : WEEK_MS) * every;
    estimate = Math.floor((nowMs - anchorMs) / periodMs);
  } else {
    const monthsPerPeriod = (reset === "month" ? 1 : 12) * every;
    const anchor = new Date(anchorMs);
    const now = new Date(nowMs);
    const monthDiff =
      (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - anchor.getUTCMonth());
    estimate = Math.floor(monthDiff / monthsPerPeriod);
  }

  // Walk up to the spec's answer — the smallest `index` whose exclusive end is
  // beyond `nowMs` (metered-usage.md §5). The estimate never overshoots, so at
  // most two exact anchor-relative probes run; `advance` is strictly
  // increasing in `count`, so the loop terminates.
  let index = Math.max(0, estimate - 1);
  while (nowMs >= advance(anchorMs, reset, (index + 1) * every)) {
    index += 1;
  }

  return {
    index,
    start: advance(anchorMs, reset, index * every),
    end: advance(anchorMs, reset, (index + 1) * every),
  };
}
