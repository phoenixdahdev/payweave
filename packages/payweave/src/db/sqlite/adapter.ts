/**
 * Builds a `DatabaseAdapter` over a {@link Runner} —
 * the sqlite dialect's store implementations. Driver-agnostic: works
 * identically whether `runner` is backed by `better-sqlite3` or
 * `@libsql/client` (see `./runner`'s header for the concurrency model this
 * relies on).
 *
 * ── `balances.consume` atomicity (spec-silent engineering decision) ────────
 * The sqlite approach is to "express reset+decrement as one
 * statement" wherever possible. A literal single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * is what this adapter uses for `webhookEvents.claim` (no calendar math
 * needed there — see below). For `consume`, doing the same would require
 * replicating `src/products/period.ts`'s clamp-once month/year arithmetic
 * (the conformance suite's oracle) as portable raw SQL
 * — and NEITHER driver offers a way to call back into that exact JS function
 * from inside a statement (`better-sqlite3` supports registering scalar
 * functions, but `@libsql/client` does not, and the two drivers must behave
 * identically — reimplementing the calendar math independently in SQL risks
 * silent drift from the oracle — the one unacceptable outcome: "if your SQL
 * disagrees, the SQL is wrong"). `init` is also a per-call CREATION template
 * only — an existing row's OWN stored `anchor`/`resetInterval` must drive its
 * reset, which the caller cannot know in advance, so a blind single write
 * can't express this correctly regardless of the calendar-math question.
 *
 * Instead: `consume` reads the current row, decides using `period.ts`
 * directly (exact parity with the oracle by construction), and writes the
 * result back inside `runner.transaction(...)` — atomic because the whole
 * read-decide-write sequence runs as one unit through the adapter's single
 * serialized connection (`./runner`), relying on serialized writes.
 * `webhookEvents.claim` needs no such read, so it stays a literal single
 * INSERT…ON CONFLICT… RETURNING statement, atomic by the engine's own
 * guarantees regardless of this adapter's serialization.
 */
import { PayweaveNotFoundError } from "../../core/errors";
import { applyMigrations, planMigrations } from "../migrations/index";
import { currentPeriod } from "../../products/period";
import type { DatabaseAdapter, PwConsumeInput, PwConsumeResult } from "../index";
import {
  DEFAULT_STALE_CLAIM_AFTER_MS,
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  PW_TABLES,
  type PwCustomerUpsert,
  type PwFeatureBalanceInit,
  type PwPlanVersion,
  type PwPlanVersionInput,
  type PwSubscription,
  type PwSubscriptionInput,
  type PwSubscriptionPatch,
} from "../schema";
import { wrapDriverError } from "./errors";
import { generatePwId } from "./id";
import { SqliteMigrationExecutor } from "./migrations-executor";
import {
  encodeBool,
  encodeDate,
  encodeJson,
  rowToCustomer,
  rowToFeatureBalance,
  rowToPlanVersion,
  rowToSubscription,
  rowToWebhookEvent,
} from "./rows";
import type { Runner } from "./runner";

const ACTIVE_STATUS_PLACEHOLDERS = PW_ACTIVE_SUBSCRIPTION_STATUSES.map(() => "?").join(", ");

/** Stable (sorted-key) JSON for order-independent structural comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The `pw_plans` fields that define plan "content" — everything except id/version/pushedAt. */
interface PlanContent {
  group: string;
  isDefault: boolean;
  name: string | null;
  priceMinor: number | null;
  priceCurrency: string | null;
  priceInterval: string | null;
  features: unknown;
  providerRefs: unknown;
}

const planContent = (p: PwPlanVersion | PwPlanVersionInput): PlanContent => ({
  group: p.group,
  isDefault: p.isDefault,
  name: p.name,
  priceMinor: p.priceMinor,
  priceCurrency: p.priceCurrency,
  priceInterval: p.priceInterval,
  features: p.features,
  providerRefs: p.providerRefs,
});

/** Whether `input`'s comparable fields match `active`'s — the pushVersion no-op gate. */
function planContentEquals(active: PwPlanVersion, input: PwPlanVersionInput): boolean {
  return stableStringify(planContent(active)) === stableStringify(planContent(input));
}

const SUBSCRIPTION_PATCH_FIELDS: ReadonlyArray<{
  key: keyof PwSubscriptionPatch;
  column: string;
  encode: (value: unknown) => unknown;
}> = [
  { key: "planId", column: "plan_id", encode: (v) => v },
  { key: "planVersion", column: "plan_version", encode: (v) => v },
  { key: "status", column: "status", encode: (v) => v },
  { key: "provider", column: "provider", encode: (v) => v },
  { key: "providerSubscriptionRef", column: "provider_subscription_ref", encode: (v) => v },
  { key: "currentPeriodStart", column: "current_period_start", encode: (v) => encodeDate(v as Date) },
  { key: "currentPeriodEnd", column: "current_period_end", encode: (v) => encodeDate(v as Date) },
  { key: "cancelAtPeriodEnd", column: "cancel_at_period_end", encode: (v) => encodeBool(v as boolean) },
];

/** Build a full `DatabaseAdapter` over `runner` (sqlite dialect). */
export function buildAdapter(runner: Runner): DatabaseAdapter {
  return {
    dialect: "sqlite",
    customers: {
      getByExternalId: (externalId) => customersGetByExternalId(runner, externalId),
      upsert: (input) => customersUpsert(runner, input),
      linkProviderRef: (externalId, provider, ref) =>
        customersLinkProviderRef(runner, externalId, provider, ref),
    },
    plans: {
      getActiveVersion: (planId) => plansGetActiveVersion(runner, planId),
      listActive: () => plansListActive(runner),
      pushVersion: (plan) => plansPushVersion(runner, plan),
    },
    subscriptions: {
      getActive: (customerId, group) => subscriptionsGetActive(runner, customerId, group),
      create: (input) => subscriptionsCreate(runner, input),
      update: (id, patch) => subscriptionsUpdate(runner, id, patch),
    },
    balances: {
      get: (customerId, featureId, group) => balancesGet(runner, customerId, featureId, group),
      consume: (input) => balancesConsume(runner, input),
      resetTo: (customerId, featureId, group, init) =>
        balancesResetTo(runner, customerId, featureId, group, init),
    },
    webhookEvents: {
      claim: (dedupeKey, meta) => webhookEventsClaim(runner, dedupeKey, meta),
      markApplied: (dedupeKey) => webhookEventsMarkApplied(runner, dedupeKey),
    },
    migrations: {
      status: () => planMigrations(new SqliteMigrationExecutor(runner), "sqlite"),
      apply: () => applyMigrations(new SqliteMigrationExecutor(runner), "sqlite"),
    },
    transaction: (fn) => runner.transaction((tx) => fn(buildAdapter(tx))),
  };
}

// ── customers ────────────────────────────────────────────────────────────────

async function customersGetByExternalId(runner: Runner, externalId: string) {
  const { rows } = await runner.execute(
    `SELECT * FROM ${PW_TABLES.customers} WHERE external_id = ?`,
    [externalId],
  );
  const row = rows[0];
  return row ? rowToCustomer(row) : null;
}

async function customersUpsert(runner: Runner, input: PwCustomerUpsert) {
  const now = new Date();
  const id = generatePwId(now.getTime());
  try {
    const { rows } = await runner.execute(
      `INSERT INTO ${PW_TABLES.customers} (id, external_id, provider_ids, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         email = COALESCE(excluded.email, ${PW_TABLES.customers}.email),
         updated_at = excluded.updated_at
       RETURNING *`,
      [id, input.externalId, encodeJson({}), input.email ?? null, encodeDate(now), encodeDate(now)],
    );
    const row = rows[0];
    if (!row) throw new Error("sqlite adapter: customers.upsert returned no row");
    return rowToCustomer(row);
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/sqlite: customers.upsert(${JSON.stringify(input.externalId)}) failed.`,
    );
  }
}

async function customersLinkProviderRef(
  runner: Runner,
  externalId: string,
  provider: string,
  ref: string,
): Promise<void> {
  await runner.transaction(async (tx) => {
    const { rows } = await tx.execute(
      `SELECT * FROM ${PW_TABLES.customers} WHERE external_id = ?`,
      [externalId],
    );
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/sqlite: customers.linkProviderRef: no customer with externalId ` +
          `${JSON.stringify(externalId)}.`,
      );
    }
    const customer = rowToCustomer(row);
    const providerIds = { ...customer.providerIds, [provider]: ref };
    await tx.execute(
      `UPDATE ${PW_TABLES.customers} SET provider_ids = ?, updated_at = ? WHERE external_id = ?`,
      [encodeJson(providerIds), encodeDate(new Date()), externalId],
    );
  });
}

// ── plans ────────────────────────────────────────────────────────────────────

async function plansGetActiveVersion(runner: Runner, planId: string) {
  const { rows } = await runner.execute(
    `SELECT * FROM ${PW_TABLES.plans} WHERE plan_id = ? ORDER BY version DESC LIMIT 1`,
    [planId],
  );
  const row = rows[0];
  return row ? rowToPlanVersion(row) : null;
}

async function plansListActive(runner: Runner) {
  const { rows } = await runner.execute(
    `SELECT p.* FROM ${PW_TABLES.plans} p
     INNER JOIN (
       SELECT plan_id, MAX(version) AS version FROM ${PW_TABLES.plans} GROUP BY plan_id
     ) latest ON latest.plan_id = p.plan_id AND latest.version = p.version`,
  );
  return rows.map(rowToPlanVersion);
}

async function plansPushVersion(runner: Runner, plan: PwPlanVersionInput): Promise<PwPlanVersion> {
  return runner.transaction(async (tx) => {
    const { rows } = await tx.execute(
      `SELECT * FROM ${PW_TABLES.plans} WHERE plan_id = ? ORDER BY version DESC LIMIT 1`,
      [plan.planId],
    );
    const activeRow = rows[0];
    const active = activeRow ? rowToPlanVersion(activeRow) : null;
    if (active && planContentEquals(active, plan)) {
      return active;
    }
    const now = new Date();
    const id = generatePwId(now.getTime());
    const nextVersion = (active?.version ?? 0) + 1;
    const { rows: inserted } = await tx.execute(
      `INSERT INTO ${PW_TABLES.plans}
         (id, plan_id, version, "group", is_default, name, price_minor, price_currency, price_interval, features, provider_refs, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [
        id,
        plan.planId,
        nextVersion,
        plan.group,
        encodeBool(plan.isDefault),
        plan.name,
        plan.priceMinor,
        plan.priceCurrency,
        plan.priceInterval,
        encodeJson(plan.features),
        encodeJson(plan.providerRefs),
        encodeDate(now),
      ],
    );
    const row = inserted[0];
    if (!row) throw new Error("sqlite adapter: plans.pushVersion returned no row");
    return rowToPlanVersion(row);
  });
}

// ── subscriptions ────────────────────────────────────────────────────────────

async function subscriptionsGetActive(runner: Runner, customerId: string, group: string) {
  const { rows } = await runner.execute(
    `SELECT * FROM ${PW_TABLES.subscriptions}
     WHERE customer_id = ? AND "group" = ? AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})`,
    [customerId, group, ...PW_ACTIVE_SUBSCRIPTION_STATUSES],
  );
  const row = rows[0];
  return row ? rowToSubscription(row) : null;
}

async function subscriptionsCreate(
  runner: Runner,
  input: PwSubscriptionInput,
): Promise<PwSubscription> {
  const now = new Date();
  const id = generatePwId(now.getTime());
  try {
    const { rows } = await runner.execute(
      `INSERT INTO ${PW_TABLES.subscriptions}
        (id, customer_id, plan_id, plan_version, "group", status, provider, provider_subscription_ref,
         current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [
        id,
        input.customerId,
        input.planId,
        input.planVersion,
        input.group,
        input.status,
        input.provider,
        input.providerSubscriptionRef,
        encodeDate(input.currentPeriodStart),
        encodeDate(input.currentPeriodEnd),
        encodeBool(input.cancelAtPeriodEnd),
        encodeDate(now),
        encodeDate(now),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("sqlite adapter: subscriptions.create returned no row");
    return rowToSubscription(row);
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/sqlite: subscriptions.create for customer ${JSON.stringify(input.customerId)} ` +
        `group ${JSON.stringify(input.group)} violated a uniqueness rule (an active-set ` +
        "subscription already exists for this customer/group, or another constraint failed).",
    );
  }
}

async function subscriptionsUpdate(
  runner: Runner,
  id: string,
  patch: PwSubscriptionPatch,
): Promise<PwSubscription> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const patchRecord = patch as Record<string, unknown>;
  for (const field of SUBSCRIPTION_PATCH_FIELDS) {
    if (!(field.key in patch) || patchRecord[field.key] === undefined) continue;
    sets.push(`${field.column} = ?`);
    params.push(field.encode(patchRecord[field.key]));
  }
  sets.push("updated_at = ?");
  params.push(encodeDate(new Date()));
  params.push(id);

  try {
    const { rows } = await runner.execute(
      `UPDATE ${PW_TABLES.subscriptions} SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
      params,
    );
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/sqlite: subscriptions.update: no subscription with id ${JSON.stringify(id)}.`,
      );
    }
    return rowToSubscription(row);
  } catch (error) {
    if (error instanceof PayweaveNotFoundError) throw error;
    throw wrapDriverError(error, `payweave/db/sqlite: subscriptions.update(${JSON.stringify(id)}) failed.`);
  }
}

// ── balances ─────────────────────────────────────────────────────────────────

async function balancesGet(runner: Runner, customerId: string, featureId: string, group: string) {
  const { rows } = await runner.execute(
    `SELECT * FROM ${PW_TABLES.featureBalances} WHERE customer_id = ? AND feature_id = ? AND "group" = ?`,
    [customerId, featureId, group],
  );
  const row = rows[0];
  return row ? rowToFeatureBalance(row) : null;
}

async function balancesConsume(runner: Runner, input: PwConsumeInput): Promise<PwConsumeResult> {
  return runner.transaction(async (tx) => {
    const { rows } = await tx.execute(
      `SELECT * FROM ${PW_TABLES.featureBalances} WHERE customer_id = ? AND feature_id = ? AND "group" = ?`,
      [input.customerId, input.featureId, input.group],
    );
    const existingRow = rows[0];
    const nowMs = input.now.getTime();

    if (!existingRow) {
      const period = currentPeriod(input.init.anchor.getTime(), input.init.resetInterval, nowMs);
      const remaining = input.init.limit; // baseUsed is 0 on creation
      const applied = input.conditional !== true || remaining >= input.amount;
      const used = applied ? input.amount : 0;
      const id = generatePwId(nowMs);
      const { rows: inserted } = await tx.execute(
        `INSERT INTO ${PW_TABLES.featureBalances}
           (id, customer_id, feature_id, "group", used, "limit", reset_interval, anchor, period_start, period_end, plan_id, plan_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [
          id,
          input.customerId,
          input.featureId,
          input.group,
          used,
          input.init.limit,
          input.init.resetInterval,
          encodeDate(input.init.anchor),
          period.start,
          period.end,
          input.init.planId,
          input.init.planVersion,
          encodeDate(input.now),
        ],
      );
      const row = inserted[0];
      if (!row) throw new Error("sqlite adapter: balances.consume (create) returned no row");
      return { ...rowToFeatureBalance(row), applied };
    }

    const existing = rowToFeatureBalance(existingRow);
    const resetDue = nowMs >= existing.periodEnd.getTime();
    const baseUsed = resetDue ? 0 : existing.used;
    const period = resetDue
      ? currentPeriod(existing.anchor.getTime(), existing.resetInterval, nowMs)
      : { start: existing.periodStart.getTime(), end: existing.periodEnd.getTime() };
    const remaining = existing.limit - baseUsed;
    const applied = input.conditional !== true || remaining >= input.amount;

    if (!applied && !resetDue) {
      // Denied and no reset was due: the row must be left
      // COMPLETELY untouched — including `updatedAt` — so issue no write at all.
      return { ...existing, applied: false };
    }

    const finalUsed = applied ? baseUsed + input.amount : baseUsed;
    const { rows: updatedRows } = await tx.execute(
      `UPDATE ${PW_TABLES.featureBalances}
       SET used = ?, period_start = ?, period_end = ?, updated_at = ?
       WHERE id = ?
       RETURNING *`,
      [finalUsed, period.start, period.end, encodeDate(input.now), existing.id],
    );
    const updatedRow = updatedRows[0];
    if (!updatedRow) throw new Error("sqlite adapter: balances.consume (update) returned no row");
    return { ...rowToFeatureBalance(updatedRow), applied };
  });
}

async function balancesResetTo(
  runner: Runner,
  customerId: string,
  featureId: string,
  group: string,
  init: PwFeatureBalanceInit,
): Promise<void> {
  const now = new Date();
  const period = currentPeriod(init.anchor.getTime(), init.resetInterval, now.getTime());
  const id = generatePwId(now.getTime());
  await runner.execute(
    `INSERT INTO ${PW_TABLES.featureBalances}
       (id, customer_id, feature_id, "group", used, "limit", reset_interval, anchor, period_start, period_end, plan_id, plan_version, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id, feature_id, "group") DO UPDATE SET
       used = 0,
       "limit" = excluded."limit",
       reset_interval = excluded.reset_interval,
       anchor = excluded.anchor,
       period_start = excluded.period_start,
       period_end = excluded.period_end,
       plan_id = excluded.plan_id,
       plan_version = excluded.plan_version,
       updated_at = excluded.updated_at`,
    [
      id,
      customerId,
      featureId,
      group,
      init.limit,
      init.resetInterval,
      encodeDate(init.anchor),
      period.start,
      period.end,
      init.planId,
      init.planVersion,
      encodeDate(now),
    ],
  );
}

// ── webhookEvents ────────────────────────────────────────────────────────────

async function webhookEventsClaim(
  runner: Runner,
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
): Promise<boolean> {
  const staleClaimAfterMs = meta.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_AFTER_MS;
  const nowMs = meta.now.getTime();
  const staleThreshold = nowMs - staleClaimAfterMs;
  const { rows } = await runner.execute(
    `INSERT INTO ${PW_TABLES.webhookEvents} (dedupe_key, provider, type, received_at, claimed_at, applied_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(dedupe_key) DO UPDATE SET claimed_at = excluded.claimed_at
     WHERE ${PW_TABLES.webhookEvents}.applied_at IS NULL
       AND ${PW_TABLES.webhookEvents}.claimed_at <= ?
     RETURNING dedupe_key`,
    [dedupeKey, meta.provider, meta.type, nowMs, nowMs, staleThreshold],
  );
  return rows.length > 0;
}

async function webhookEventsMarkApplied(runner: Runner, dedupeKey: string): Promise<void> {
  await runner.execute(
    `UPDATE ${PW_TABLES.webhookEvents} SET applied_at = ? WHERE dedupe_key = ?`,
    [Date.now(), dedupeKey],
  );
}

// Re-exported so tests can round-trip a raw row without duplicating the
// mapping logic (e.g. asserting `rowToWebhookEvent` matches `claim`'s writes).
export { rowToWebhookEvent };
