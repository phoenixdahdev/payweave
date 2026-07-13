/**
 * SQL translation of `src/products/period.ts`'s anchor-relative billing-period
 * math, for the ONE place `balances.consume`'s single-statement design needs
 * it: recomputing an EXISTING row's current window from its own stored
 * `anchor`/`reset_interval` when a lazy reset is due (metered-usage.md §5,
 * database.md §5 pg bullet — "this ticket's headline").
 *
 * ── Why this exists instead of reading the row in JS (deviation from the
 * sqlite/drizzle adapters) ──────────────────────────────────────────────────
 * `src/db/sqlite/adapter.ts` and `src/db/drizzle/postgres-adapter.ts` both
 * read the current row (locked, in a transaction), decide in JS via
 * `currentPeriod()` directly, and write the result back — sidestepping any
 * need to reimplement calendar math in SQL, at the cost of an explicit
 * multi-statement transaction. PW-704's brief is explicit that the DIRECT
 * `pg` adapter's headline requirement is different: `consume` must be ONE
 * statement leveraging pg's native row locking (database.md §5: "pg row
 * locking / single-statement atomicity — NOT a read-then-write"). Getting
 * that MUST express the reset-due branch's period math as SQL evaluated
 * against the locked row's own `anchor`/`reset_interval` — hence this module.
 *
 * The FRESH-row branch of `consume` (no existing row) needs NO SQL month
 * math at all: `src/db/postgres/adapter.ts` computes that branch's
 * `period_start`/`period_end` by calling `currentPeriod()` directly in JS
 * (zero drift risk — it IS the oracle) and passes the result in as bind
 * parameters. Only the reset-due branch — which by construction must react
 * to the EXISTING row's own anchor, visible only inside the SQL statement via
 * a `FOR UPDATE`-locked CTE (`./sql.ts`) — needs the translation below.
 *
 * ── The translation, term for term ──────────────────────────────────────────
 * `period.ts`'s `currentPeriod(anchorMs, reset, nowMs)`:
 *   1. `estimate` — an O(1) guess at the period index (day/week: integer
 *      division of the elapsed ms; month/year: integer division of the
 *      elapsed CALENDAR months, ignoring day-of-month/time-of-day) that is
 *      PROVEN to never overshoot the true index and to undershoot it by AT
 *      MOST 2 (`period.ts`'s own comment).
 *   2. `index = max(0, estimate - 1)` — never negative; the -1 makes room for
 *      the undershoot correction below without ever having to walk backwards.
 *   3. A `while` loop increments `index` while `nowMs >= advance(index+1)` —
 *      bounded to AT MOST 2 iterations by the estimate's proven error bound.
 *
 * SQL has no `while`. Since step 3 is bounded to exactly 0, 1, or 2
 * increments, it is UNROLLED into a closed form: evaluate `advance` at four
 * candidate offsets from `index0` (0..3 — offsets 1..3 cover every possible
 * final index, and offset 3 additionally covers `period_end` when the final
 * index is `index0 + 2`), then a single `CASE` picks the right pair using two
 * strict-less-than comparisons (`advance` is strictly increasing in its
 * count argument, so comparing against `adv1`/`adv2` alone is sufficient —
 * see {@link buildPeriodMathSql}'s `increments` expression). This is
 * algebraically IDENTICAL to `period.ts`'s loop, not an approximation.
 *
 * `advance`'s own month/year clamping (`addUtcMonthsClamped`) — add whole
 * calendar months to the anchor's UTC components, clamping day-of-month to
 * the target month's length ONCE per result, never iterating on a clamped
 * output — is reproduced via `make_timestamptz` with explicit UTC field
 * arithmetic (`AT TIME ZONE 'UTC'` on every extract, so the result is
 * independent of the connection's `timezone` session setting — postgres
 * itself does NOT clamp end-of-month interval arithmetic the way `period.ts`
 * does: `timestamptz '2026-01-31' + interval '1 month'` overflows to March,
 * it does not clamp to Feb 28, which is exactly the bug this hand-rolled
 * expression avoids).
 *
 * VERIFICATION NOTE (no docker in this environment — see the ticket's
 * handoff report): this SQL cannot be executed against a real postgres here.
 * `test/db/postgres.test.ts` instead cross-checks a byte-for-byte JS mirror
 * of this exact formula (same operations: `Math.floor` for `FLOOR`, `%` +
 * normalization for `MOD`, the same four-candidate/`CASE` structure) against
 * `src/products/period.ts`'s `currentPeriod` across day/week/month/year,
 * leap years, end-of-month anchors, and both directions of drift — the
 * strongest confidence available without a live database; a real postgres
 * run (PW-710's CI matrix) is the only thing that can confirm postgres's
 * own `EXTRACT`/`make_timestamptz`/interval semantics agree with the mirror.
 */

const DAY_MS = "86400000";
const WEEK_MS = "604800000";

/** `(EXTRACT(DAY FROM (last day of the given year/month)))::int` — the target month's length. */
function daysInMonthExpr(yearExpr: string, monthExpr: string): string {
  return (
    `(EXTRACT(DAY FROM (make_date((${yearExpr})::int, (${monthExpr})::int, 1) + ` +
    `INTERVAL '1 month - 1 day')))::int`
  );
}

/**
 * `addUtcMonthsClamped(anchor, totalMonths)` (period.ts) as a SQL scalar
 * expression. `anchorUtc` must already be a `(col AT TIME ZONE 'UTC')`
 * expression (a tz-naive UTC wall-clock `timestamp`); `totalMonthsExpr` is a
 * SQL integer expression for the (possibly negative) total month offset.
 * Returns a `timestamptz` expression, constructed with an EXPLICIT `'UTC'`
 * zone so the result never depends on the connection's `timezone` setting.
 */
function clampedMonthAddExpr(anchorUtc: string, totalMonthsExpr: string): string {
  const rawMonths = `((EXTRACT(MONTH FROM ${anchorUtc}))::int - 1 + (${totalMonthsExpr}))`;
  const year = `((EXTRACT(YEAR FROM ${anchorUtc}))::int + FLOOR((${rawMonths})::numeric / 12))::int`;
  const monthIndex = `(MOD(MOD((${rawMonths})::int, 12) + 12, 12))::int`;
  const month = `(${monthIndex} + 1)`;
  const day = `LEAST((EXTRACT(DAY FROM ${anchorUtc}))::int, ${daysInMonthExpr(year, month)})`;
  return (
    `make_timestamptz(${year}, ${month}, (${day})::int, ` +
    `(EXTRACT(HOUR FROM ${anchorUtc}))::int, (EXTRACT(MINUTE FROM ${anchorUtc}))::int, ` +
    `(EXTRACT(SECOND FROM ${anchorUtc}))::double precision, 'UTC')`
  );
}

/**
 * `advance(anchor, reset, n)` (period.ts) as a SQL scalar expression, over
 * generic column/parameter references. `anchorRaw`/`nowRaw` are `timestamptz`
 * expressions; `resetIntervalRaw` is a `text` expression valued
 * `'day'|'week'|'month'|'year'`; `nExpr` is a (possibly parenthesized) SQL
 * integer expression for the count of whole intervals.
 */
function advanceExpr(anchorRaw: string, resetIntervalRaw: string, nExpr: string): string {
  const anchorUtc = `(${anchorRaw} AT TIME ZONE 'UTC')`;
  return `(CASE ${resetIntervalRaw}
    WHEN 'day' THEN ${anchorRaw} + ((${nExpr}) * ${DAY_MS}) * INTERVAL '1 millisecond'
    WHEN 'week' THEN ${anchorRaw} + ((${nExpr}) * ${WEEK_MS}) * INTERVAL '1 millisecond'
    WHEN 'month' THEN ${clampedMonthAddExpr(anchorUtc, `(${nExpr}) * 1`)}
    WHEN 'year' THEN ${clampedMonthAddExpr(anchorUtc, `(${nExpr}) * 12`)}
  END)`;
}

/**
 * The O(1) `estimate` (period.ts) as a SQL scalar expression — day/week: the
 * floored elapsed-ms ratio; month/year: the floored elapsed-calendar-months
 * ratio (component-wise, ignoring day-of-month/time-of-day, exactly like
 * `period.ts`'s `monthDiff`).
 */
function estimateExpr(anchorRaw: string, resetIntervalRaw: string, nowRaw: string): string {
  const anchorUtc = `(${anchorRaw} AT TIME ZONE 'UTC')`;
  const nowUtc = `(${nowRaw} AT TIME ZONE 'UTC')`;
  // ROUND (not a bare cast) protects against float epsilon in EXTRACT(EPOCH ...)
  // landing just under/over a whole millisecond for the same instant twice.
  const diffMs = `ROUND(EXTRACT(EPOCH FROM (${nowRaw} - ${anchorRaw})) * 1000)`;
  const monthDiff =
    `(((EXTRACT(YEAR FROM ${nowUtc}))::int - (EXTRACT(YEAR FROM ${anchorUtc}))::int) * 12 + ` +
    `((EXTRACT(MONTH FROM ${nowUtc}))::int - (EXTRACT(MONTH FROM ${anchorUtc}))::int))`;
  return `((CASE ${resetIntervalRaw}
    WHEN 'day' THEN FLOOR((${diffMs})::numeric / ${DAY_MS})
    WHEN 'week' THEN FLOOR((${diffMs})::numeric / ${WEEK_MS})
    WHEN 'month' THEN FLOOR((${monthDiff})::numeric / 1)
    WHEN 'year' THEN FLOOR((${monthDiff})::numeric / 12)
  END)::bigint)`;
}

/** The `{ periodStart, periodEnd }` SQL expression pair for `currentPeriod(anchor, reset, now)`. */
export interface PeriodMathSql {
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * Build the `period_start`/`period_end` SQL expressions for
 * `currentPeriod(anchorRaw, resetIntervalRaw, nowRaw)` (period.ts), over
 * arbitrary column/parameter references (used against a `FOR UPDATE`-locked
 * existing row's own `anchor`/`reset_interval` — see the module header).
 *
 * Unrolls `period.ts`'s bounded-2-iteration correction loop into four
 * candidate `advance()` evaluations (offsets 0..3 from the O(1) estimate)
 * plus one `CASE` that picks the true index from two strict comparisons —
 * see the module header for the full derivation.
 */
export function buildPeriodMathSql(
  anchorRaw: string,
  resetIntervalRaw: string,
  nowRaw: string,
): PeriodMathSql {
  const estimate = estimateExpr(anchorRaw, resetIntervalRaw, nowRaw);
  const index0 = `(GREATEST(0, (${estimate}) - 1))`;
  const adv = (offset: number): string =>
    advanceExpr(anchorRaw, resetIntervalRaw, `(${index0}) + ${offset}`);
  const adv0 = adv(0);
  const adv1 = adv(1);
  const adv2 = adv(2);
  const adv3 = adv(3);
  // `advance` is strictly increasing in its count argument (period.ts), so
  // comparing `nowRaw` against `adv1`/`adv2` alone determines how many of the
  // (at most 2) corrections apply — exactly `period.ts`'s while loop, unrolled.
  const increments = `(CASE WHEN ${nowRaw} < ${adv1} THEN 0 WHEN ${nowRaw} < ${adv2} THEN 1 ELSE 2 END)`;
  return {
    periodStart: `(CASE ${increments} WHEN 0 THEN ${adv0} WHEN 1 THEN ${adv1} ELSE ${adv2} END)`,
    periodEnd: `(CASE ${increments} WHEN 0 THEN ${adv1} WHEN 1 THEN ${adv2} ELSE ${adv3} END)`,
  };
}
