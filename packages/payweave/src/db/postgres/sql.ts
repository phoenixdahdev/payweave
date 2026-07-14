/**
 * The two ATOMIC, single-statement queries this adapter treats as its
 * headline requirement: `balances.consume` and `webhookEvents.claim`. Both
 * are built here (rather than inline in `./adapter.ts`) because they are, by
 * design, large — see each builder's own doc comment for why every piece of
 * SQL text below exists.
 *
 * KNOWN PERFORMANCE CHARACTERISTIC (flagged, not hidden):
 * `buildConsumeQuery`'s text is large (tens of KB) because `./period-sql.ts`'s
 * reset-due CASE expression is referenced multiple times (in `used`,
 * `period_start`, `period_end`, `updated_at`, and `applied`) and each
 * reference is a full, independent copy of the formula — required for
 * correctness (see `buildConsumeQuery`'s doc comment: every value must be
 * derived from the SAME locked `computed` CTE, not re-read post-write), but
 * it means this text is rebuilt and re-sent, uninterned, on every call. A
 * follow-up optimization worth doing once this can be verified against a
 * real postgres (no docker here): send it as a NAMED prepared statement
 * (`pool.query({ text, values, name })`) so postgres parses/plans it once per
 * connection and every subsequent call on that connection is a cheap
 * Bind+Execute. Not done yet — `Runner.query` and the mock-pool
 * test harness would need to grow a `name` parameter, and prepared-statement
 * behavior under pool connection churn is exactly the kind of thing this
 * environment cannot verify; a real docker-backed postgres run is the right
 * place to add and prove it.
 */
import { currentPeriod } from "../../products/period";
import { PW_TABLES } from "../schema";
import type { PwConsumeInput } from "../index";
import { buildPeriodMathSql } from "./period-sql";

/** A ready-to-execute parameterized query. */
export interface SqlQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

const FEATURE_BALANCES = PW_TABLES.featureBalances;
const WEBHOOK_EVENTS = PW_TABLES.webhookEvents;

/**
 * `balances.consume` — ONE `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`
 * statement (this adapter's headline requirement) that atomically:
 * lazy-resets the period if due, applies the
 * `conditional` gate, and decrements — all inside a single round trip, using
 * pg's own row locking rather than a read-then-write from the application.
 *
 * ── How the atomicity actually works ─────────────────────────────────────
 * A `WITH existing AS (SELECT ... FOR UPDATE)` CTE acquires — WITHIN this
 * same statement/transaction — a row lock on the (customer, feature, group)
 * row if one exists (0 rows if this is a first touch: nothing to lock, and
 * the subsequent `INSERT`'s own unique-constraint conflict handling
 * arbitrates any race between concurrent first-touches natively). A second
 * CTE, `computed`, derives every written value AND the `applied` flag from
 * that LOCKED row (or, for a first touch, from the `init` bind parameters)
 * exactly once. The final `INSERT ... ON CONFLICT DO UPDATE` and its
 * `RETURNING` clause then simply READ `computed`'s already-decided values via
 * correlated scalar subqueries — they never re-derive `applied`/`resetDue`
 * from the table's post-write columns, because RETURNING (like any
 * UPDATE...RETURNING) reflects values AFTER the SET clause has applied them:
 * re-deriving "was a reset due" from the NEW `period_end` would see it
 * already rolled forward and always answer "no". Reading everything off the
 * pre-write, LOCKED `computed` CTE instead sidesteps that trap entirely.
 *
 * This is genuinely one network round trip (one string sent to `pg`), and
 * the row-lock scope is exactly the (customer, feature, group) row this call
 * touches — concurrent calls for OTHER rows are unaffected, and concurrent
 * calls for the SAME row serialize on the lock exactly as
 * `SELECT ... FOR UPDATE` normally does (postgres's own row-locking
 * mechanism), never a lost update.
 *
 * ── Period math ──────────────────────────────────────────────────────────
 * The FIRST-TOUCH branch needs no SQL calendar math at all — its
 * `period_start`/`period_end` are computed by calling `currentPeriod()`
 * (the real `src/products/period.ts` oracle) directly in JS from `init`, and
 * passed in as `$13`/`$14`; there is no existing row to race against for
 * that computation. Only the RESET-DUE branch (an EXISTING row whose
 * `period_end` the locked read shows as `<= now`) needs the row's OWN
 * `anchor`/`reset_interval` re-evaluated — data only visible INSIDE this
 * statement — hence `./period-sql.ts`'s hand-rolled translation of
 * `currentPeriod`, invoked here exactly once via `buildPeriodMathSql("e.anchor",
 * "e.reset_interval", "$5")`.
 *
 * `init` is a creation template only: the `DO UPDATE SET`
 * clause never touches `"limit"`/`reset_interval`/`anchor`/`plan_id`/
 * `plan_version` — an existing row's own values for those columns always win.
 */
export function buildConsumeQuery(input: PwConsumeInput, newId: string): SqlQuery {
  const conditional = input.conditional === true;
  const freshPeriod = currentPeriod(
    input.init.anchor.getTime(),
    input.init.resetInterval,
    input.now.getTime(),
  );

  // $1 id · $2 customerId · $3 featureId · $4 group · $5 now · $6 amount ·
  // $7 conditional · $8 init.limit · $9 init.resetInterval · $10 init.anchor ·
  // $11 init.planId · $12 init.planVersion · $13 freshPeriodStart · $14 freshPeriodEnd
  const params: unknown[] = [
    newId,
    input.customerId,
    input.featureId,
    input.group,
    input.now,
    input.amount,
    conditional,
    input.init.limit,
    input.init.resetInterval,
    input.init.anchor,
    input.init.planId,
    input.init.planVersion,
    new Date(freshPeriod.start),
    new Date(freshPeriod.end),
  ];

  const resetDue = `($5::timestamptz >= e.period_end)`;
  const baseUsed = `(CASE WHEN ${resetDue} THEN 0 ELSE e.used END)`;
  const remaining = `(e."limit" - ${baseUsed})`;
  const appliedExisting = `(($7::boolean) IS NOT TRUE OR ${remaining} >= $6::bigint)`;
  const finalUsedExisting = `(CASE WHEN ${appliedExisting} THEN ${baseUsed} + $6::bigint ELSE ${baseUsed} END)`;
  const updatedAtExisting = `(CASE WHEN (${appliedExisting} OR ${resetDue}) THEN $5::timestamptz ELSE e.updated_at END)`;
  const existingPeriod = buildPeriodMathSql("e.anchor", "e.reset_interval", "$5::timestamptz");
  const periodStartExisting = `(CASE WHEN ${resetDue} THEN ${existingPeriod.periodStart} ELSE e.period_start END)`;
  const periodEndExisting = `(CASE WHEN ${resetDue} THEN ${existingPeriod.periodEnd} ELSE e.period_end END)`;

  const freshDenied = `(($7::boolean) IS TRUE AND $8::bigint < $6::bigint)`;
  const freshUsed = `(CASE WHEN ${freshDenied} THEN 0 ELSE $6::bigint END)`;
  const freshApplied = `(CASE WHEN ${freshDenied} THEN FALSE ELSE TRUE END)`;

  const text = `
WITH existing AS (
  SELECT * FROM ${FEATURE_BALANCES}
  WHERE customer_id = $2 AND feature_id = $3 AND "group" = $4
  FOR UPDATE
),
computed AS (
  SELECT
    CASE WHEN e.id IS NULL THEN ${freshUsed} ELSE ${finalUsedExisting} END AS used,
    CASE WHEN e.id IS NULL THEN $13::timestamptz ELSE ${periodStartExisting} END AS period_start,
    CASE WHEN e.id IS NULL THEN $14::timestamptz ELSE ${periodEndExisting} END AS period_end,
    CASE WHEN e.id IS NULL THEN $5::timestamptz ELSE ${updatedAtExisting} END AS updated_at,
    CASE WHEN e.id IS NULL THEN ${freshApplied} ELSE ${appliedExisting} END AS applied
  FROM (SELECT 1 AS one) dummy
  LEFT JOIN existing e ON true
)
INSERT INTO ${FEATURE_BALANCES}
  (id, customer_id, feature_id, "group", used, "limit", reset_interval, anchor, period_start, period_end, plan_id, plan_version, updated_at)
SELECT $1, $2, $3, $4, computed.used, $8::bigint, $9::text, $10::timestamptz, computed.period_start, computed.period_end, $11::text, $12::int, computed.updated_at
FROM computed
ON CONFLICT (customer_id, feature_id, "group") DO UPDATE SET
  used = (SELECT used FROM computed),
  period_start = (SELECT period_start FROM computed),
  period_end = (SELECT period_end FROM computed),
  updated_at = (SELECT updated_at FROM computed)
RETURNING id, customer_id, feature_id, "group", used, "limit", reset_interval, anchor, period_start, period_end, plan_id, plan_version, updated_at,
  (SELECT applied FROM computed) AS applied
`.trim();

  return { text, params };
}

/**
 * `webhookEvents.claim` — one insert-or-steal statement:
 * `INSERT ... ON CONFLICT (dedupe_key) DO UPDATE SET claimed_at = EXCLUDED
 * .claimed_at WHERE applied_at IS NULL AND claimed_at <= <now - stale>
 * RETURNING dedupe_key`. When the `WHERE` condition is false (already applied,
 * or claimed too recently by someone else), postgres's `ON CONFLICT DO
 * UPDATE ... WHERE` skips the write AND omits that row from `RETURNING`
 * entirely — so `rows.length > 0` is exactly "the caller won", with zero
 * follow-up query (mirrors `src/db/sqlite/adapter.ts`'s identical shape,
 * translated to `$n` placeholders).
 */
export function buildClaimQuery(
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
  defaultStaleClaimAfterMs: number,
): SqlQuery {
  const staleClaimAfterMs = meta.staleClaimAfterMs ?? defaultStaleClaimAfterMs;
  const staleThreshold = new Date(meta.now.getTime() - staleClaimAfterMs);
  const text = `
INSERT INTO ${WEBHOOK_EVENTS} (dedupe_key, provider, type, received_at, claimed_at, applied_at)
VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, NULL)
ON CONFLICT (dedupe_key) DO UPDATE SET claimed_at = EXCLUDED.claimed_at
WHERE ${WEBHOOK_EVENTS}.applied_at IS NULL AND ${WEBHOOK_EVENTS}.claimed_at <= $6::timestamptz
RETURNING dedupe_key
`.trim();
  return {
    text,
    params: [dedupeKey, meta.provider, meta.type, meta.now, meta.now, staleThreshold],
  };
}
