/**
 * Builds a `DatabaseAdapter` (docs/v1/database.md §3) over a {@link Runner} —
 * the postgres dialect's store implementations. `balances.consume` and
 * `webhookEvents.claim` are ONE statement each (`./sql.ts` — database.md §5's
 * "this ticket's headline"); every other store method is a straightforward
 * parameterized query, mirroring the sqlite/drizzle adapters' shapes with
 * `$n` placeholders and native `pg` types (no manual date/bool/json
 * encode/decode — see `./rows.ts`'s header for what `pg` already does for us).
 */
import { PayweaveNotFoundError } from "../../core/errors";
import { currentPeriod } from "../../products/period";
import { applyMigrations, planMigrations } from "../migrations/index";
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
import { PostgresMigrationExecutor } from "./migrations-executor";
import {
  rowToCustomer,
  rowToFeatureBalance,
  rowToPlanVersion,
  rowToSubscription,
  rowToWebhookEvent,
} from "./rows";
import type { Runner } from "./runner";
import { buildClaimQuery, buildConsumeQuery } from "./sql";

const ACTIVE_STATUS_PLACEHOLDERS = PW_ACTIVE_SUBSCRIPTION_STATUSES.map((_, i) => `$${i + 3}`).join(", ");

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
}> = [
  { key: "planId", column: "plan_id" },
  { key: "planVersion", column: "plan_version" },
  { key: "status", column: "status" },
  { key: "provider", column: "provider" },
  { key: "providerSubscriptionRef", column: "provider_subscription_ref" },
  { key: "currentPeriodStart", column: "current_period_start" },
  { key: "currentPeriodEnd", column: "current_period_end" },
  { key: "cancelAtPeriodEnd", column: "cancel_at_period_end" },
];

/** Build a full `DatabaseAdapter` over `runner` (postgres dialect). */
export function buildAdapter(runner: Runner): DatabaseAdapter {
  return {
    dialect: "postgres",
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
      status: () => planMigrations(new PostgresMigrationExecutor(runner), "postgres"),
      apply: () => applyMigrations(new PostgresMigrationExecutor(runner), "postgres"),
    },
    transaction: (fn) => runner.transaction((tx) => fn(buildAdapter(tx))),
  };
}

// ── customers ────────────────────────────────────────────────────────────────

async function customersGetByExternalId(runner: Runner, externalId: string) {
  const { rows } = await runner.query(
    `SELECT * FROM ${PW_TABLES.customers} WHERE external_id = $1`,
    [externalId],
  );
  const row = rows[0];
  return row ? rowToCustomer(row) : null;
}

async function customersUpsert(runner: Runner, input: PwCustomerUpsert) {
  const now = new Date();
  const id = generatePwId(now.getTime());
  try {
    const { rows } = await runner.query(
      `INSERT INTO ${PW_TABLES.customers} (id, external_id, provider_ids, email, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (external_id) DO UPDATE SET
         email = COALESCE(excluded.email, ${PW_TABLES.customers}.email),
         updated_at = excluded.updated_at
       RETURNING *`,
      [id, input.externalId, JSON.stringify({}), input.email ?? null, now, now],
    );
    const row = rows[0];
    if (!row) throw new Error("postgres adapter: customers.upsert returned no row");
    return rowToCustomer(row);
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/postgres: customers.upsert(${JSON.stringify(input.externalId)}) failed.`,
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
    const { rows } = await tx.query(
      `SELECT * FROM ${PW_TABLES.customers} WHERE external_id = $1 FOR UPDATE`,
      [externalId],
    );
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/postgres: customers.linkProviderRef: no customer with externalId ` +
          `${JSON.stringify(externalId)}.`,
      );
    }
    const customer = rowToCustomer(row);
    const providerIds = { ...customer.providerIds, [provider]: ref };
    await tx.query(
      `UPDATE ${PW_TABLES.customers} SET provider_ids = $1::jsonb, updated_at = $2 WHERE external_id = $3`,
      [JSON.stringify(providerIds), new Date(), externalId],
    );
  });
}

// ── plans ────────────────────────────────────────────────────────────────────

async function plansGetActiveVersion(runner: Runner, planId: string) {
  const { rows } = await runner.query(
    `SELECT * FROM ${PW_TABLES.plans} WHERE plan_id = $1 ORDER BY version DESC LIMIT 1`,
    [planId],
  );
  const row = rows[0];
  return row ? rowToPlanVersion(row) : null;
}

async function plansListActive(runner: Runner) {
  const { rows } = await runner.query(
    `SELECT p.* FROM ${PW_TABLES.plans} p
     INNER JOIN (
       SELECT plan_id, MAX(version) AS version FROM ${PW_TABLES.plans} GROUP BY plan_id
     ) latest ON latest.plan_id = p.plan_id AND latest.version = p.version`,
  );
  return rows.map(rowToPlanVersion);
}

async function plansPushVersion(runner: Runner, plan: PwPlanVersionInput): Promise<PwPlanVersion> {
  return runner.transaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM ${PW_TABLES.plans} WHERE plan_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
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
    const { rows: inserted } = await tx.query(
      `INSERT INTO ${PW_TABLES.plans}
         (id, plan_id, version, "group", is_default, name, price_minor, price_currency, price_interval, features, provider_refs, pushed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
       RETURNING *`,
      [
        id,
        plan.planId,
        nextVersion,
        plan.group,
        plan.isDefault,
        plan.name,
        plan.priceMinor,
        plan.priceCurrency,
        plan.priceInterval,
        JSON.stringify(plan.features),
        JSON.stringify(plan.providerRefs),
        now,
      ],
    );
    const row = inserted[0];
    if (!row) throw new Error("postgres adapter: plans.pushVersion returned no row");
    return rowToPlanVersion(row);
  });
}

// ── subscriptions ────────────────────────────────────────────────────────────

async function subscriptionsGetActive(runner: Runner, customerId: string, group: string) {
  const { rows } = await runner.query(
    `SELECT * FROM ${PW_TABLES.subscriptions}
     WHERE customer_id = $1 AND "group" = $2 AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})`,
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
    const { rows } = await runner.query(
      `INSERT INTO ${PW_TABLES.subscriptions}
        (id, customer_id, plan_id, plan_version, "group", status, provider, provider_subscription_ref,
         current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.currentPeriodStart,
        input.currentPeriodEnd,
        input.cancelAtPeriodEnd,
        now,
        now,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("postgres adapter: subscriptions.create returned no row");
    return rowToSubscription(row);
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/postgres: subscriptions.create for customer ${JSON.stringify(input.customerId)} ` +
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
    params.push(patchRecord[field.key]);
    sets.push(`${field.column} = $${params.length}`);
  }
  params.push(new Date());
  sets.push(`updated_at = $${params.length}`);
  params.push(id);
  const idParamIndex = params.length;

  try {
    const { rows } = await runner.query(
      `UPDATE ${PW_TABLES.subscriptions} SET ${sets.join(", ")} WHERE id = $${idParamIndex} RETURNING *`,
      params,
    );
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/postgres: subscriptions.update: no subscription with id ${JSON.stringify(id)}.`,
      );
    }
    return rowToSubscription(row);
  } catch (error) {
    if (error instanceof PayweaveNotFoundError) throw error;
    throw wrapDriverError(error, `payweave/db/postgres: subscriptions.update(${JSON.stringify(id)}) failed.`);
  }
}

// ── balances ─────────────────────────────────────────────────────────────────

async function balancesGet(runner: Runner, customerId: string, featureId: string, group: string) {
  const { rows } = await runner.query(
    `SELECT * FROM ${PW_TABLES.featureBalances} WHERE customer_id = $1 AND feature_id = $2 AND "group" = $3`,
    [customerId, featureId, group],
  );
  const row = rows[0];
  return row ? rowToFeatureBalance(row) : null;
}

/**
 * THE hot path — see `./sql.ts`'s `buildConsumeQuery` doc comment for the
 * full atomicity design. This wrapper's only job is to build the query, send
 * it as ONE call, and map the returned row + `applied` flag.
 */
async function balancesConsume(runner: Runner, input: PwConsumeInput): Promise<PwConsumeResult> {
  const id = generatePwId(input.now.getTime());
  const { text, params } = buildConsumeQuery(input, id);
  try {
    const { rows } = await runner.query(text, params);
    const row = rows[0];
    if (!row) throw new Error("postgres adapter: balances.consume returned no row");
    const applied = row.applied;
    if (typeof applied !== "boolean") {
      throw new Error(
        `postgres adapter: balances.consume's RETURNING "applied" column was ${typeof applied}, expected boolean`,
      );
    }
    return { ...rowToFeatureBalance(row), applied };
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/postgres: balances.consume for customer ${JSON.stringify(input.customerId)} ` +
        `feature ${JSON.stringify(input.featureId)} group ${JSON.stringify(input.group)} failed.`,
    );
  }
}

async function balancesResetTo(
  runner: Runner,
  customerId: string,
  featureId: string,
  group: string,
  init: PwFeatureBalanceInit,
): Promise<void> {
  // No injectable clock for `resetTo` (database.md §3 — unlike `consume`, it
  // takes no `now`), so the period it derives is computed directly via the
  // real `period.ts` oracle in JS — this is an unconditional overwrite, not a
  // concurrency-sensitive decision, so there is no atomicity reason to
  // recompute it in SQL the way `consume`'s reset-due branch must.
  const now = new Date();
  const period = currentPeriod(init.anchor.getTime(), init.resetInterval, now.getTime());
  const id = generatePwId(now.getTime());
  await runner.query(
    `INSERT INTO ${PW_TABLES.featureBalances}
       (id, customer_id, feature_id, "group", used, "limit", reset_interval, anchor, period_start, period_end, plan_id, plan_version, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (customer_id, feature_id, "group") DO UPDATE SET
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
      init.anchor,
      new Date(period.start),
      new Date(period.end),
      init.planId,
      init.planVersion,
      now,
    ],
  );
}

// ── webhookEvents ────────────────────────────────────────────────────────────

async function webhookEventsClaim(
  runner: Runner,
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
): Promise<boolean> {
  const { text, params } = buildClaimQuery(dedupeKey, meta, DEFAULT_STALE_CLAIM_AFTER_MS);
  const { rows } = await runner.query(text, params);
  return rows.length > 0;
}

async function webhookEventsMarkApplied(runner: Runner, dedupeKey: string): Promise<void> {
  await runner.query(
    `UPDATE ${PW_TABLES.webhookEvents} SET applied_at = $1 WHERE dedupe_key = $2`,
    [new Date(), dedupeKey],
  );
}

// Re-exported so tests can round-trip a raw row without duplicating the
// mapping logic (e.g. asserting `rowToWebhookEvent` matches `claim`'s writes).
export { rowToWebhookEvent };
