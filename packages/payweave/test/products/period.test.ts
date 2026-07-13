import { describe, expect, it } from "vitest";
import {
  advance,
  currentPeriod,
  DAY_MS,
  WEEK_MS,
  type ResetInterval,
} from "../../src/products/period";
import { PayweaveValidationError } from "../../src/core/errors";

/** Independent last-day-of-month oracle for clamp assertions. */
function daysIn(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

describe("constants", () => {
  it("day/week are the fixed UTC millisecond multiples from metered-usage.md §5", () => {
    expect(DAY_MS).toBe(86_400_000);
    expect(WEEK_MS).toBe(604_800_000);
  });
});

describe("advance() — monthly clamping, anchor-relative (no drift)", () => {
  it("walks the canonical Jan 31 sequence: Jan 31 → Feb 28 → Mar 31 → Apr 30 → May 31", () => {
    const anchor = Date.UTC(2025, 0, 31);
    expect(advance(anchor, "month", 0)).toBe(Date.UTC(2025, 0, 31));
    expect(advance(anchor, "month", 1)).toBe(Date.UTC(2025, 1, 28));
    expect(advance(anchor, "month", 2)).toBe(Date.UTC(2025, 2, 31));
    expect(advance(anchor, "month", 3)).toBe(Date.UTC(2025, 3, 30));
    expect(advance(anchor, "month", 4)).toBe(Date.UTC(2025, 4, 31));
  });

  it("leap-year variant: Jan 31 2028 → Feb 29 → Mar 31 → Apr 30", () => {
    const anchor = Date.UTC(2028, 0, 31);
    expect(advance(anchor, "month", 1)).toBe(Date.UTC(2028, 1, 29));
    expect(advance(anchor, "month", 2)).toBe(Date.UTC(2028, 2, 31));
    expect(advance(anchor, "month", 3)).toBe(Date.UTC(2028, 3, 30));
  });

  it("differs from the forbidden iterate-on-clamped-output approach", () => {
    const anchor = Date.UTC(2025, 0, 31);
    // Iterating from the clamped Feb 28 would drift to Mar 28 …
    const drifted = advance(advance(anchor, "month", 1), "month", 1);
    expect(drifted).toBe(Date.UTC(2025, 2, 28));
    // … the anchor-relative result stays on the anchor day.
    expect(advance(anchor, "month", 2)).toBe(Date.UTC(2025, 2, 31));
  });

  it("clamps 31-day anchors into 30-day months", () => {
    expect(advance(Date.UTC(2025, 2, 31), "month", 1)).toBe(Date.UTC(2025, 3, 30));
    expect(advance(Date.UTC(2025, 7, 31), "month", 1)).toBe(Date.UTC(2025, 8, 30));
    expect(advance(Date.UTC(2025, 9, 31), "month", 1)).toBe(Date.UTC(2025, 10, 30));
  });

  it("handles every-3-months from Nov 30 (interval count > 1)", () => {
    const anchor = Date.UTC(2025, 10, 30);
    expect(advance(anchor, "month", 3)).toBe(Date.UTC(2026, 1, 28)); // clamp 30 → 28
    expect(advance(anchor, "month", 6)).toBe(Date.UTC(2026, 4, 30));
    expect(advance(anchor, "month", 9)).toBe(Date.UTC(2026, 7, 30));
    expect(advance(anchor, "month", 12)).toBe(Date.UTC(2026, 10, 30));
    // Leap variant: Nov 30 2027 + 3 months lands on Feb 29 2028.
    expect(advance(Date.UTC(2027, 10, 30), "month", 3)).toBe(Date.UTC(2028, 1, 29));
  });

  it("never clamps month-start anchors", () => {
    const anchor = Date.UTC(2025, 0, 1, 8, 30);
    expect(advance(anchor, "month", 1)).toBe(Date.UTC(2025, 1, 1, 8, 30));
    expect(advance(anchor, "month", 2)).toBe(Date.UTC(2025, 2, 1, 8, 30));
    expect(advance(anchor, "month", 13)).toBe(Date.UTC(2026, 1, 1, 8, 30));
  });

  it("preserves the anchor's UTC time of day through clamping", () => {
    const anchor = Date.UTC(2025, 0, 31, 15, 23, 45, 678);
    expect(advance(anchor, "month", 1)).toBe(Date.UTC(2025, 1, 28, 15, 23, 45, 678));
    expect(advance(anchor, "month", 2)).toBe(Date.UTC(2025, 2, 31, 15, 23, 45, 678));
  });

  it("wraps across year boundaries", () => {
    expect(advance(Date.UTC(2025, 10, 15), "month", 3)).toBe(Date.UTC(2026, 1, 15));
    expect(advance(Date.UTC(2025, 11, 31), "month", 1)).toBe(Date.UTC(2026, 0, 31));
    expect(advance(Date.UTC(2025, 11, 31), "month", 2)).toBe(Date.UTC(2026, 1, 28));
    expect(advance(Date.UTC(2025, 5, 30), "month", 20)).toBe(Date.UTC(2027, 1, 28));
  });
});

describe("advance() — yearly (Feb 29 anchors)", () => {
  const feb29 = Date.UTC(2028, 1, 29);

  it("clamps Feb 29 + 1 year to Feb 28 in the non-leap target year", () => {
    expect(advance(feb29, "year", 1)).toBe(Date.UTC(2029, 1, 28));
    expect(advance(feb29, "year", 2)).toBe(Date.UTC(2030, 1, 28));
    expect(advance(feb29, "year", 3)).toBe(Date.UTC(2031, 1, 28));
  });

  it("returns to Feb 29 when the target year is a leap year", () => {
    expect(advance(feb29, "year", 4)).toBe(Date.UTC(2032, 1, 29));
    expect(advance(feb29, "year", 8)).toBe(Date.UTC(2036, 1, 29));
  });

  it("agrees with the equivalent whole-multiple-of-12 month advance", () => {
    expect(advance(feb29, "month", 12)).toBe(advance(feb29, "year", 1));
    expect(advance(feb29, "month", 12)).toBe(Date.UTC(2029, 1, 28));
    expect(advance(feb29, "month", 48)).toBe(advance(feb29, "year", 4));
    expect(advance(feb29, "month", 48)).toBe(Date.UTC(2032, 1, 29));
  });

  it("keeps non-EOM anchors on their day", () => {
    expect(advance(Date.UTC(2025, 11, 31, 23, 59, 59, 999), "year", 1)).toBe(
      Date.UTC(2026, 11, 31, 23, 59, 59, 999),
    );
    expect(advance(Date.UTC(2025, 6, 4), "year", 10)).toBe(Date.UTC(2035, 6, 4));
  });
});

describe("advance() — day/week fixed multiples", () => {
  const anchor = Date.UTC(2025, 2, 8, 12, 0, 0, 0); // spans the US DST switch (Mar 9 2025)

  it("day: exact 86_400_000 ms multiples", () => {
    expect(advance(anchor, "day", 1)).toBe(anchor + DAY_MS);
    expect(advance(anchor, "day", 7)).toBe(anchor + 7 * DAY_MS);
    expect(advance(anchor, "day", 365)).toBe(anchor + 365 * DAY_MS);
  });

  it("week: exact 604_800_000 ms multiples", () => {
    expect(advance(anchor, "week", 1)).toBe(anchor + WEEK_MS);
    expect(advance(anchor, "week", 52)).toBe(anchor + 52 * WEEK_MS);
  });

  it("is unaffected by DST transitions — UTC has none, days are always 24h", () => {
    // Crossing 2025-03-09 (US spring-forward) and 2025-10-26 (EU fall-back):
    expect(advance(anchor, "day", 2) - anchor).toBe(2 * DAY_MS);
    const octAnchor = Date.UTC(2025, 9, 25, 12, 0);
    expect(advance(octAnchor, "day", 2) - octAnchor).toBe(2 * DAY_MS);
    expect(new Date(advance(octAnchor, "day", 2)).getUTCHours()).toBe(12);
  });
});

describe("advance() — input validation", () => {
  const anchor = Date.UTC(2025, 0, 1);

  it("rejects negative or fractional counts", () => {
    expect(() => advance(anchor, "month", -1)).toThrow(PayweaveValidationError);
    expect(() => advance(anchor, "month", 1.5)).toThrow(PayweaveValidationError);
    expect(() => advance(anchor, "day", Number.NaN)).toThrow(PayweaveValidationError);
  });

  it("rejects non-integer anchors", () => {
    expect(() => advance(Number.NaN, "month", 1)).toThrow(PayweaveValidationError);
    expect(() => advance(0.5, "day", 1)).toThrow(PayweaveValidationError);
    expect(() => advance(Number.POSITIVE_INFINITY, "week", 1)).toThrow(PayweaveValidationError);
  });

  it("rejects an unknown reset interval at runtime", () => {
    expect(() => advance(anchor, "quarter" as ResetInterval, 1)).toThrow(
      PayweaveValidationError,
    );
    expect(() => advance(anchor, "quarter" as ResetInterval, 1)).toThrow(
      /unknown reset interval/,
    );
  });

  it("rejects results outside the representable date range", () => {
    const nearMax = Date.UTC(275760, 0, 1); // max Date is Sep 13, 275760
    expect(() => advance(nearMax, "year", 1)).toThrow(/outside the representable date range/);
    expect(() => advance(0, "day", Number.MAX_SAFE_INTEGER)).toThrow(PayweaveValidationError);
  });
});

describe("currentPeriod() — boundaries are [start, end) and anchor-relative", () => {
  const anchor = Date.UTC(2025, 0, 31); // canonical Jan 31 monthly anchor
  const feb28 = Date.UTC(2025, 1, 28);
  const mar31 = Date.UTC(2025, 2, 31);

  it("now at the anchor is period 0", () => {
    expect(currentPeriod(anchor, "month", anchor)).toEqual({
      index: 0,
      start: anchor,
      end: feb28,
    });
  });

  it("now exactly at a period end belongs to the next period (end exclusive)", () => {
    expect(currentPeriod(anchor, "month", feb28)).toEqual({
      index: 1,
      start: feb28,
      end: mar31,
    });
  });

  it("one ms before/after a boundary lands on either side", () => {
    expect(currentPeriod(anchor, "month", feb28 - 1).index).toBe(0);
    expect(currentPeriod(anchor, "month", feb28 + 1).index).toBe(1);
    expect(currentPeriod(anchor, "month", mar31 - 1).index).toBe(1);
    expect(currentPeriod(anchor, "month", mar31).index).toBe(2);
  });

  it("mid-March now yields [Feb 28, Mar 31) — roll-forward does not drift", () => {
    expect(currentPeriod(anchor, "month", Date.UTC(2025, 2, 15))).toEqual({
      index: 1,
      start: feb28,
      end: mar31, // NOT Mar 28
    });
  });

  it("now before the anchor clamps to period 0 (documented: spec-silent, clock-skew tolerant)", () => {
    expect(currentPeriod(anchor, "month", anchor - 1)).toEqual({
      index: 0,
      start: anchor,
      end: feb28,
    });
    expect(currentPeriod(anchor, "day", anchor - 400 * DAY_MS).index).toBe(0);
    expect(currentPeriod(anchor, "year", 0).start).toBe(anchor);
  });

  it("a row idle for many years lands directly in the current window", () => {
    const oldAnchor = Date.UTC(2020, 0, 31);
    const now = Date.UTC(2033, 5, 15); // 13y 4.5m later
    expect(currentPeriod(oldAnchor, "month", now)).toEqual({
      index: 160,
      start: Date.UTC(2033, 4, 31),
      end: Date.UTC(2033, 5, 30),
    });
  });

  it("a daily row idle for 1000+ days lands in the current window", () => {
    const t0 = Date.UTC(2025, 3, 7, 9, 15);
    const period = currentPeriod(t0, "day", t0 + 1000 * DAY_MS + DAY_MS / 2);
    expect(period).toEqual({
      index: 1000,
      start: t0 + 1000 * DAY_MS,
      end: t0 + 1001 * DAY_MS,
    });
  });
});

describe("currentPeriod() — units and interval counts (`every`)", () => {
  it("daily periods", () => {
    const t0 = Date.UTC(2025, 5, 1, 6, 0);
    expect(currentPeriod(t0, "day", t0 + 3 * DAY_MS + DAY_MS / 2)).toEqual({
      index: 3,
      start: t0 + 3 * DAY_MS,
      end: t0 + 4 * DAY_MS,
    });
  });

  it("weekly periods", () => {
    const t0 = Date.UTC(2025, 5, 2); // a Monday
    expect(currentPeriod(t0, "week", t0 + 15 * DAY_MS)).toEqual({
      index: 2,
      start: t0 + 2 * WEEK_MS,
      end: t0 + 3 * WEEK_MS,
    });
  });

  it("biweekly (every: 2 weeks)", () => {
    const t0 = Date.UTC(2025, 5, 2);
    expect(currentPeriod(t0, "week", t0 + 15 * DAY_MS, 2)).toEqual({
      index: 1,
      start: t0 + 2 * WEEK_MS,
      end: t0 + 4 * WEEK_MS,
    });
    expect(currentPeriod(t0, "week", t0 + 2 * WEEK_MS - 1, 2).index).toBe(0);
  });

  it("quarterly (every: 3 months) from a Nov 30 anchor", () => {
    const anchor = Date.UTC(2025, 10, 30);
    const q1 = Date.UTC(2026, 1, 28); // Nov 30 + 3mo, clamped
    const q2 = Date.UTC(2026, 4, 30); // Nov 30 + 6mo — back on the 30th
    expect(currentPeriod(anchor, "month", Date.UTC(2026, 0, 15), 3)).toEqual({
      index: 0,
      start: anchor,
      end: q1,
    });
    expect(currentPeriod(anchor, "month", q1, 3)).toEqual({ index: 1, start: q1, end: q2 });
    expect(currentPeriod(anchor, "month", q2 - 1, 3).index).toBe(1);
    expect(currentPeriod(anchor, "month", q2, 3).index).toBe(2);
  });

  it("yearly from a Feb 29 anchor", () => {
    const anchor = Date.UTC(2028, 1, 29);
    const y1 = Date.UTC(2029, 1, 28); // clamped
    expect(currentPeriod(anchor, "year", y1 - 1)).toEqual({ index: 0, start: anchor, end: y1 });
    expect(currentPeriod(anchor, "year", y1)).toEqual({
      index: 1,
      start: y1,
      end: Date.UTC(2030, 1, 28),
    });
    expect(currentPeriod(anchor, "year", Date.UTC(2032, 2, 1))).toEqual({
      index: 4,
      start: Date.UTC(2032, 1, 29), // leap year — back on the 29th
      end: Date.UTC(2033, 1, 28),
    });
  });
});

describe("currentPeriod() — input validation", () => {
  const anchor = Date.UTC(2025, 0, 1);

  it("rejects invalid `every`", () => {
    expect(() => currentPeriod(anchor, "month", anchor, 0)).toThrow(PayweaveValidationError);
    expect(() => currentPeriod(anchor, "month", anchor, -2)).toThrow(PayweaveValidationError);
    expect(() => currentPeriod(anchor, "month", anchor, 1.5)).toThrow(PayweaveValidationError);
  });

  it("rejects non-integer anchor/now", () => {
    expect(() => currentPeriod(Number.NaN, "month", anchor)).toThrow(PayweaveValidationError);
    expect(() => currentPeriod(anchor, "month", Number.NaN)).toThrow(PayweaveValidationError);
    expect(() => currentPeriod(anchor, "month", 1.5)).toThrow(PayweaveValidationError);
  });
});

describe("property-style grid: period N start == anchor advanced N intervals", () => {
  // Anchors covering 31-day EOM, leap-Feb EOM, non-leap-Feb EOM, 30-day EOM,
  // mid-month, and month-start — all with a non-midnight time of day.
  const anchors = [
    Date.UTC(2028, 0, 31, 10, 20, 30, 400),
    Date.UTC(2028, 1, 29, 10, 20, 30, 400),
    Date.UTC(2027, 1, 28, 10, 20, 30, 400),
    Date.UTC(2028, 3, 30, 10, 20, 30, 400),
    Date.UTC(2028, 5, 15, 10, 20, 30, 400),
    Date.UTC(2028, 2, 1, 10, 20, 30, 400),
  ];
  const units: ResetInterval[] = ["day", "week", "month", "year"];
  const counts = [0, 1, 2, 3, 5, 11, 12, 13, 24, 25, 36, 47, 48, 60];

  it("currentPeriod at (and just before) each derived boundary returns exactly period N", () => {
    for (const anchor of anchors) {
      for (const unit of units) {
        for (const n of counts) {
          const startN = advance(anchor, unit, n);
          const endN = advance(anchor, unit, n + 1);
          const atStart = currentPeriod(anchor, unit, startN);
          expect(atStart.index).toBe(n);
          expect(atStart.start).toBe(startN);
          expect(atStart.end).toBe(endN);
          const beforeEnd = currentPeriod(anchor, unit, endN - 1);
          expect(beforeEnd.index).toBe(n);
          expect(beforeEnd.start).toBe(startN);
        }
      }
    }
  });

  it("month/year results match an independent clamp oracle and preserve time of day", () => {
    for (const anchor of anchors) {
      const a = new Date(anchor);
      for (const unit of ["month", "year"] as const) {
        for (const n of counts) {
          const months = unit === "month" ? n : n * 12;
          const result = new Date(advance(anchor, unit, n));
          const totalMonths = a.getUTCMonth() + months;
          const expectedYear = a.getUTCFullYear() + Math.floor(totalMonths / 12);
          const expectedMonth = ((totalMonths % 12) + 12) % 12;
          expect(result.getUTCFullYear()).toBe(expectedYear);
          expect(result.getUTCMonth()).toBe(expectedMonth);
          expect(result.getUTCDate()).toBe(
            Math.min(a.getUTCDate(), daysIn(expectedYear, expectedMonth)),
          );
          expect(result.getUTCHours()).toBe(10);
          expect(result.getUTCMinutes()).toBe(20);
          expect(result.getUTCSeconds()).toBe(30);
          expect(result.getUTCMilliseconds()).toBe(400);
        }
      }
    }
  });

  it("advance is strictly increasing in the interval count", () => {
    for (const anchor of anchors) {
      for (const unit of units) {
        let previous = advance(anchor, unit, 0);
        for (let n = 1; n <= 60; n += 1) {
          const next = advance(anchor, unit, n);
          expect(next).toBeGreaterThan(previous);
          previous = next;
        }
      }
    }
  });

  it("anchor-day restoration: every 31-day target month restores a 31st-day anchor", () => {
    const anchor = Date.UTC(2028, 0, 31, 10, 20, 30, 400);
    for (let n = 0; n <= 24; n += 1) {
      const result = new Date(advance(anchor, "month", n));
      const last = daysIn(result.getUTCFullYear(), result.getUTCMonth());
      expect(result.getUTCDate()).toBe(last === 31 ? 31 : last);
    }
  });
});
