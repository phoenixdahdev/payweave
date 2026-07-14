/**
 * The aggregation-pipeline expression computing the CURRENT anchor-relative
 * billing period `{ index, start, end }` for a `pw_feature_balances` document
 * — the in-pipeline analog of `src/products/period.ts`'s `currentPeriod()`:
 * reset-if-expired + decrement in one server-side operation, `$dateAdd` by n
 * intervals FROM THE ANCHOR — never iterate on previously clamped outputs.
 *
 * ── Why this can be a closed-form / small-bounded pipeline expression ──────
 * - `day`/`week`: fixed-width epoch-ms periods — `index = floor((now - anchor)
 *   / periodMs)`, clamped to >= 0. This is EXACT, no correction pass needed:
 *   `period.ts`'s own `currentPeriod()` computes the identical closed form
 *   for these two intervals (its "estimate → walk-up loop" degenerates to a
 *   single exact step here, verified by the property test in
 *   `test/db/mongodb.test.ts`).
 * - `month`/`year`: `period.ts`'s `currentPeriod()` doc comment PROVES its own
 *   calendar-only estimate (`(nowYear-anchorYear)*12 + (nowMonth-anchorMonth)`,
 *   ignoring day-of-month/time-of-day) never overshoots the true period index
 *   by more than 1 and `estimate - 1` never undershoots it by more than 2 —
 *   i.e. the true index is ALWAYS one of exactly three candidates:
 *   `estimate-1`, `estimate`, `estimate+1` (each clamped to >= 0). This
 *   pipeline computes that SAME calendar-only estimate via `$dateToParts`
 *   (mirroring `period.ts` field-for-field, not re-deriving new math) and
 *   picks the smallest of those candidates whose `$dateAdd`-computed end
 *   exceeds `now` — a bounded, loop-free `$switch`, never an iterative
 *   correction. A 4th candidate (`estimate+2`) is checked too as a
 *   documented safety margin beyond `period.ts`'s own proven bound.
 *
 * ── The one assumption only a real `mongod` can confirm ────────────────────
 * `$dateAdd` with `unit: "month"` must clamp an out-of-range resulting
 * day-of-month to the target month's last day, exactly like `period.ts`'s
 * `addUtcMonthsClamped` (documented MongoDB behavior — e.g. adding 1 month to
 * `2020-01-31` yields `2020-02-29`). This sandbox has no real `mongod` to
 * execute the pipeline against; the CI conformance run (both standalone
 * and replica-set topologies) is the actual proof. `test/db/mongodb.test.ts`
 * instead proves the ALGORITHM correct: {@link simulatePeriodPipeline} is a
 * pure-JS re-implementation of this exact expression tree (same estimate,
 * same bounded candidates, same `advance()` calls `period.ts` itself uses for
 * the clamped month/year arithmetic) property-tested against
 * `currentPeriod()` across hundreds of anchors/resets/`now`s including leap
 * years, end-of-month anchors, and multi-period idle jumps. The only thing
 * that test CANNOT verify is whether MongoDB's real `$dateAdd`/`$dateToParts`/
 * `$switch`/`$let` operators behave as modeled — only a real docker-backed CI
 * run against a real `mongod` can confirm that.
 */
import { DAY_MS, WEEK_MS, advance, type ResetInterval } from "../../products/period";

export { DAY_MS, WEEK_MS };

/**
 * Build the aggregation expression for `{ index, start, end }` given
 * expressions for the document's `anchor` (a Date) and `resetInterval`
 * (a string), and the caller's `now` baked in as a literal — use the
 * caller's `now` parameter, never `$$NOW` — this pipeline is
 * built fresh, in JS, per `consume()` call, so `now` is always a plain Date
 * literal, never the server clock).
 */
export function buildPeriodExpr(
  nowMs: number,
  anchorExpr: unknown,
  resetExpr: unknown,
): Record<string, unknown> {
  const nowLiteral = new Date(nowMs);
  return {
    $let: {
      vars: { anchor: anchorExpr, reset: resetExpr },
      in: {
        $switch: {
          branches: [
            {
              case: { $in: ["$$reset", ["day", "week"]] },
              then: {
                $let: {
                  vars: { periodMs: { $cond: [{ $eq: ["$$reset", "day"] }, DAY_MS, WEEK_MS] } },
                  in: {
                    $let: {
                      vars: {
                        idx: {
                          $max: [
                            0,
                            {
                              $floor: {
                                $divide: [{ $subtract: [nowLiteral, "$$anchor"] }, "$$periodMs"],
                              },
                            },
                          ],
                        },
                      },
                      in: {
                        index: "$$idx",
                        start: { $add: ["$$anchor", { $multiply: ["$$idx", "$$periodMs"] }] },
                        end: {
                          $add: ["$$anchor", { $multiply: [{ $add: ["$$idx", 1] }, "$$periodMs"] }],
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
          default: {
            $let: {
              vars: {
                monthsPerPeriod: { $cond: [{ $eq: ["$$reset", "year"] }, 12, 1] },
                anchorParts: { $dateToParts: { date: "$$anchor", timezone: "UTC" } },
                nowParts: { $dateToParts: { date: nowLiteral, timezone: "UTC" } },
              },
              in: {
                $let: {
                  vars: {
                    monthDiff: {
                      $add: [
                        { $multiply: [{ $subtract: ["$$nowParts.year", "$$anchorParts.year"] }, 12] },
                        { $subtract: ["$$nowParts.month", "$$anchorParts.month"] },
                      ],
                    },
                  },
                  in: {
                    $let: {
                      vars: {
                        idx0: {
                          $max: [
                            0,
                            {
                              $subtract: [
                                { $floor: { $divide: ["$$monthDiff", "$$monthsPerPeriod"] } },
                                1,
                              ],
                            },
                          ],
                        },
                      },
                      in: {
                        $let: {
                          vars: {
                            end0: {
                              $dateAdd: {
                                startDate: "$$anchor",
                                unit: "month",
                                amount: { $multiply: [{ $add: ["$$idx0", 1] }, "$$monthsPerPeriod"] },
                              },
                            },
                            end1: {
                              $dateAdd: {
                                startDate: "$$anchor",
                                unit: "month",
                                amount: { $multiply: [{ $add: ["$$idx0", 2] }, "$$monthsPerPeriod"] },
                              },
                            },
                            end2: {
                              $dateAdd: {
                                startDate: "$$anchor",
                                unit: "month",
                                amount: { $multiply: [{ $add: ["$$idx0", 3] }, "$$monthsPerPeriod"] },
                              },
                            },
                            end3: {
                              $dateAdd: {
                                startDate: "$$anchor",
                                unit: "month",
                                amount: { $multiply: [{ $add: ["$$idx0", 4] }, "$$monthsPerPeriod"] },
                              },
                            },
                          },
                          in: {
                            $let: {
                              vars: {
                                chosenIdx: {
                                  $switch: {
                                    branches: [
                                      { case: { $lt: [nowLiteral, "$$end0"] }, then: "$$idx0" },
                                      {
                                        case: { $lt: [nowLiteral, "$$end1"] },
                                        then: { $add: ["$$idx0", 1] },
                                      },
                                      {
                                        case: { $lt: [nowLiteral, "$$end2"] },
                                        then: { $add: ["$$idx0", 2] },
                                      },
                                    ],
                                    default: { $add: ["$$idx0", 3] },
                                  },
                                },
                                chosenEnd: {
                                  $switch: {
                                    branches: [
                                      { case: { $lt: [nowLiteral, "$$end0"] }, then: "$$end0" },
                                      { case: { $lt: [nowLiteral, "$$end1"] }, then: "$$end1" },
                                      { case: { $lt: [nowLiteral, "$$end2"] }, then: "$$end2" },
                                    ],
                                    default: "$$end3",
                                  },
                                },
                              },
                              in: {
                                index: "$$chosenIdx",
                                start: {
                                  $dateAdd: {
                                    startDate: "$$anchor",
                                    unit: "month",
                                    amount: { $multiply: ["$$chosenIdx", "$$monthsPerPeriod"] },
                                  },
                                },
                                end: "$$chosenEnd",
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Pure-JS re-implementation of {@link buildPeriodExpr}'s exact algorithm — see
 * the module header. Used ONLY by `test/db/mongodb.test.ts`'s property test
 * (cross-checked against `currentPeriod()`); never imported by the adapter
 * itself (the adapter always builds and sends the real pipeline).
 */
export function simulatePeriodPipeline(
  nowMs: number,
  anchorMs: number,
  reset: ResetInterval,
): { index: number; start: number; end: number } {
  if (reset === "day" || reset === "week") {
    const periodMs = reset === "day" ? DAY_MS : WEEK_MS;
    const idx = Math.max(0, Math.floor((nowMs - anchorMs) / periodMs));
    return { index: idx, start: anchorMs + idx * periodMs, end: anchorMs + (idx + 1) * periodMs };
  }

  const monthsPerPeriod = reset === "year" ? 12 : 1;
  const anchorDate = new Date(anchorMs);
  const nowDate = new Date(nowMs);
  const monthDiff =
    (nowDate.getUTCFullYear() - anchorDate.getUTCFullYear()) * 12 +
    (nowDate.getUTCMonth() - anchorDate.getUTCMonth());
  const idx0 = Math.max(0, Math.floor(monthDiff / monthsPerPeriod) - 1);

  // `advance(anchorMs, reset, n)` already converts `n` RESET-INTERVAL counts
  // to months internally for `reset: "year"` (`period.ts`'s own `* 12`) — pass
  // period counts (`idx`/`idx+1`) directly, NOT pre-multiplied by
  // `monthsPerPeriod` (that pre-multiplication is only correct for
  // `buildPeriodExpr`'s `$dateAdd` calls, which take a raw MONTH count and
  // never go through `advance()` at all).
  for (const idx of [idx0, idx0 + 1, idx0 + 2]) {
    const end = advance(anchorMs, reset, idx + 1);
    if (nowMs < end) {
      return { index: idx, start: advance(anchorMs, reset, idx), end };
    }
  }
  const idx = idx0 + 3;
  return {
    index: idx,
    start: advance(anchorMs, reset, idx),
    end: advance(anchorMs, reset, idx + 1),
  };
}
