/**
 * MySQL store implementation for the Drizzle adapter (docs/v1/database.md
 * §2/§3/§5, PW-708). Built against the published `./schema/mysql.ts` tables.
 *
 * Like the postgres dialect, this is NOT exercised by a live conformance run
 * in this sandbox (no docker — database.md §6's obligation for Drizzle is
 * the Postgres variant; see `./postgres-adapter.ts`'s header and
 * `test/db/drizzle.test.ts`). MySQL has neither `RETURNING` nor a
 * conditional/`WHERE` clause on `ON DUPLICATE KEY UPDATE` (confirmed against
 * the installed `drizzle-orm@0.45.2`'s `mysql-core` insert query-builder
 * types — no `setWhere`/`where` option exists there, unlike pg-core's), so
 * this file follows the PW-705 (mysql raw-driver adapter) brief's two
 * sanctioned techniques verbatim:
 *
 * - No `RETURNING`: every write is followed by a `SELECT` on the same
 *   connection/transaction to fetch the resulting row.
 * - `webhookEvents.claim`: a raw `INSERT ... ON DUPLICATE KEY UPDATE
 *   claimed_at = IF(applied_at IS NULL AND claimed_at <= ?, ?, claimed_at)`
 *   detects ownership from `mysql2`'s affected-rows semantics — WITHOUT the
 *   `CLIENT_FOUND_ROWS` flag (`mysql2`'s default): `affectedRows === 1` means
 *   a fresh INSERT (first sight, we win); `=== 2` means the UPDATE branch
 *   actually changed `claimed_at` (we won a steal); `=== 0` means the row
 *   matched but nothing changed (we lost). This is a single server
 *   round-trip, unlike every other write in this file.
 *
 * `balances.consume` uses `db.transaction()` + `.for("update")` (raw
 * `SELECT ... FOR UPDATE` via the query builder) to recompute the current
 * billing window through `src/products/period.ts` — same reasoning as the
 * postgres/sqlite dialect files: no portable single statement can replicate
 * that calendar arithmetic.
 */
import { and, eq, sql } from "drizzle-orm";
import { MySqlDatabase, type AnyMySqlQueryResultHKT, type PreparedQueryHKTBase } from "drizzle-orm/mysql-core";
import { PayweaveNotFoundError } from "../../core/errors";
import { currentPeriod } from "../../products/period";
import type { DatabaseAdapter, PwConsumeInput, PwConsumeResult } from "../index";
import {
  DEFAULT_STALE_CLAIM_AFTER_MS,
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  type PwCustomerUpsert,
  type PwFeatureBalanceInit,
  type PwPlanVersionInput,
  type PwSubscriptionInput,
  type PwSubscriptionPatch,
} from "../schema";
import { wrapDriverError } from "./errors";
import { generatePwId } from "./id";
import { planContentEquals } from "./plan-content";
import {
  pwCustomers,
  pwFeatureBalances,
  pwPlans,
  pwSubscriptions,
  pwWebhookEvents,
} from "./schema/mysql";
import { createVerifier, findMissingTablesForStatus, makeSqlTableProbe } from "./verify";

/** Any `drizzle-orm` mysql instance (`mysql2`, PlanetScale, TiDB, …). */
export type MysqlDrizzleDb = MySqlDatabase<AnyMySqlQueryResultHKT, PreparedQueryHKTBase>;

const DRIZZLE_KIT_INSTRUCTIONS =
  "payweave/db/drizzle never runs migrations for you (database.md §4). Merge " +
  '"payweave/db/drizzle"\'s published schema (see `./schema/mysql.ts`) into your own Drizzle ' +
  "schema, then run `drizzle-kit push` (dev) or `drizzle-kit generate` + `drizzle-kit migrate` " +
  "(tracked migrations) yourself.";

/** A `mysql2`-shaped write result — `ResultSetHeader` (see the module header). */
interface MysqlWriteResult {
  affectedRows: number;
}

function asWriteResult(raw: unknown): MysqlWriteResult {
  const header = Array.isArray(raw) ? raw[0] : raw;
  const affectedRows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return { affectedRows: typeof affectedRows === "number" ? affectedRows : 0 };
}

/** Build a full `DatabaseAdapter` over a Drizzle mysql `db` (or an open `tx`). */
export function buildMysqlAdapter(db: MysqlDrizzleDb): DatabaseAdapter {
  const ensureVerified = createVerifier(makeSqlTableProbe(db));
  function guarded<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
  ): (...args: Args) => Promise<T> {
    return async (...args: Args) => {
      await ensureVerified();
      return fn(...args);
    };
  }

  return {
    dialect: "mysql",
    customers: {
      getByExternalId: guarded((externalId: string) => customersGetByExternalId(db, externalId)),
      upsert: guarded((input: PwCustomerUpsert) => customersUpsert(db, input)),
      linkProviderRef: guarded((externalId: string, provider: string, ref: string) =>
        customersLinkProviderRef(db, externalId, provider, ref),
      ),
    },
    plans: {
      getActiveVersion: guarded((planId: string) => plansGetActiveVersion(db, planId)),
      listActive: guarded(() => plansListActive(db)),
      pushVersion: guarded((plan: PwPlanVersionInput) => plansPushVersion(db, plan)),
    },
    subscriptions: {
      getActive: guarded((customerId: string, group: string) =>
        subscriptionsGetActive(db, customerId, group),
      ),
      create: guarded((input: PwSubscriptionInput) => subscriptionsCreate(db, input)),
      update: guarded((id: string, patch: PwSubscriptionPatch) =>
        subscriptionsUpdate(db, id, patch),
      ),
    },
    balances: {
      get: guarded((customerId: string, featureId: string, group: string) =>
        balancesGet(db, customerId, featureId, group),
      ),
      consume: guarded((input: PwConsumeInput) => balancesConsume(db, input)),
      resetTo: guarded(
        (customerId: string, featureId: string, group: string, init: PwFeatureBalanceInit) =>
          balancesResetTo(db, customerId, featureId, group, init),
      ),
    },
    webhookEvents: {
      claim: guarded(
        (
          dedupeKey: string,
          meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
        ) => webhookEventsClaim(db, dedupeKey, meta),
      ),
      markApplied: guarded((dedupeKey: string) => webhookEventsMarkApplied(db, dedupeKey)),
    },
    migrations: {
      status: async () => {
        const missing = await findMissingTablesForStatus(makeSqlTableProbe(db));
        return missing.length > 0
          ? { pending: ["0001_init"], applied: [] }
          : { pending: [], applied: ["0001_init"] };
      },
      apply: () => Promise.resolve({ applied: [], instructions: DRIZZLE_KIT_INSTRUCTIONS }),
    },
    transaction: (fn) => db.transaction((tx) => fn(buildMysqlAdapter(tx))),
  };
}

// ── customers ────────────────────────────────────────────────────────────────

async function customersGetByExternalId(db: MysqlDrizzleDb, externalId: string) {
  const rows = await db.select().from(pwCustomers).where(eq(pwCustomers.externalId, externalId));
  return rows[0] ?? null;
}

async function customersUpsert(db: MysqlDrizzleDb, input: PwCustomerUpsert) {
  const now = new Date();
  const id = generatePwId(now.getTime());
  // Omitting `email` from `set` when not provided (rather than a raw
  // `VALUES(email)` expression, deprecated since MySQL 8.0.20) leaves the
  // existing value untouched — ON DUPLICATE KEY UPDATE only rewrites the
  // columns it's told to.
  const set: Record<string, unknown> = { updatedAt: now };
  if (input.email !== undefined) set.email = input.email;
  try {
    await db
      .insert(pwCustomers)
      .values({
        id,
        externalId: input.externalId,
        providerIds: {},
        email: input.email ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set });
    const rows = await db.select().from(pwCustomers).where(eq(pwCustomers.externalId, input.externalId));
    const row = rows[0];
    if (!row) throw new Error("drizzle adapter (mysql): customers.upsert returned no row");
    return row;
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (mysql): customers.upsert(${JSON.stringify(input.externalId)}) failed.`,
    );
  }
}

async function customersLinkProviderRef(
  db: MysqlDrizzleDb,
  externalId: string,
  provider: string,
  ref: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(pwCustomers)
      .where(eq(pwCustomers.externalId, externalId))
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/drizzle (mysql): customers.linkProviderRef: no customer with externalId ` +
          `${JSON.stringify(externalId)}.`,
      );
    }
    const providerIds = { ...row.providerIds, [provider]: ref };
    await tx
      .update(pwCustomers)
      .set({ providerIds, updatedAt: new Date() })
      .where(eq(pwCustomers.externalId, externalId));
  });
}

// ── plans ────────────────────────────────────────────────────────────────────

async function plansGetActiveVersion(db: MysqlDrizzleDb, planId: string) {
  const rows = await db
    .select()
    .from(pwPlans)
    .where(eq(pwPlans.planId, planId))
    .orderBy(sql`${pwPlans.version} desc`)
    .limit(1);
  return rows[0] ?? null;
}

async function plansListActive(db: MysqlDrizzleDb) {
  const latest = db
    .select({
      planId: pwPlans.planId,
      version: sql<number>`max(${pwPlans.version})`.as("max_version"),
    })
    .from(pwPlans)
    .groupBy(pwPlans.planId)
    .as("latest");
  return db
    .select({
      id: pwPlans.id,
      planId: pwPlans.planId,
      version: pwPlans.version,
      group: pwPlans.group,
      isDefault: pwPlans.isDefault,
      name: pwPlans.name,
      priceMinor: pwPlans.priceMinor,
      priceCurrency: pwPlans.priceCurrency,
      priceInterval: pwPlans.priceInterval,
      features: pwPlans.features,
      providerRefs: pwPlans.providerRefs,
      pushedAt: pwPlans.pushedAt,
    })
    .from(pwPlans)
    .innerJoin(latest, and(eq(latest.planId, pwPlans.planId), eq(latest.version, pwPlans.version)));
}

async function plansPushVersion(db: MysqlDrizzleDb, plan: PwPlanVersionInput) {
  return db.transaction(async (tx) => {
    const activeRows = await tx
      .select()
      .from(pwPlans)
      .where(eq(pwPlans.planId, plan.planId))
      .orderBy(sql`${pwPlans.version} desc`)
      .limit(1)
      .for("update");
    const active = activeRows[0] ?? null;
    if (active && planContentEquals(active, plan)) {
      return active;
    }
    const now = new Date();
    const id = generatePwId(now.getTime());
    const nextVersion = (active?.version ?? 0) + 1;
    await tx.insert(pwPlans).values({
      id,
      planId: plan.planId,
      version: nextVersion,
      group: plan.group,
      isDefault: plan.isDefault,
      name: plan.name,
      priceMinor: plan.priceMinor,
      priceCurrency: plan.priceCurrency,
      priceInterval: plan.priceInterval,
      features: plan.features,
      providerRefs: plan.providerRefs,
      pushedAt: now,
    });
    const rows = await tx.select().from(pwPlans).where(eq(pwPlans.id, id));
    const row = rows[0];
    if (!row) throw new Error("drizzle adapter (mysql): plans.pushVersion returned no row");
    return row;
  });
}

// ── subscriptions ────────────────────────────────────────────────────────────

async function subscriptionsGetActive(db: MysqlDrizzleDb, customerId: string, group: string) {
  const rows = await db
    .select()
    .from(pwSubscriptions)
    .where(
      and(
        eq(pwSubscriptions.customerId, customerId),
        eq(pwSubscriptions.group, group),
        sql`${pwSubscriptions.status} in ${PW_ACTIVE_SUBSCRIPTION_STATUSES}`,
      ),
    );
  return rows[0] ?? null;
}

async function subscriptionsCreate(db: MysqlDrizzleDb, input: PwSubscriptionInput) {
  const now = new Date();
  const id = generatePwId(now.getTime());
  try {
    await db.insert(pwSubscriptions).values({
      id,
      customerId: input.customerId,
      planId: input.planId,
      planVersion: input.planVersion,
      group: input.group,
      status: input.status,
      provider: input.provider,
      providerSubscriptionRef: input.providerSubscriptionRef,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db.select().from(pwSubscriptions).where(eq(pwSubscriptions.id, id));
    const row = rows[0];
    if (!row) throw new Error("drizzle adapter (mysql): subscriptions.create returned no row");
    return row;
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (mysql): subscriptions.create for customer ` +
        `${JSON.stringify(input.customerId)} group ${JSON.stringify(input.group)} violated a ` +
        "uniqueness rule (an active-set subscription already exists for this customer/group, or " +
        "another constraint failed).",
    );
  }
}

async function subscriptionsUpdate(db: MysqlDrizzleDb, id: string, patch: PwSubscriptionPatch) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) set[key] = value;
  }
  try {
    // mysql-core has no `RETURNING` (module header): the UPDATE's own
    // affected-rows count can't distinguish "no such id" from "id exists but
    // the update was a no-op" (mysql2 reports 0 for both without
    // `CLIENT_FOUND_ROWS`), so a single follow-up SELECT resolves both —
    // fetching the row, then checking whether it exists at all.
    await db.update(pwSubscriptions).set(set).where(eq(pwSubscriptions.id, id));
    const rows = await db.select().from(pwSubscriptions).where(eq(pwSubscriptions.id, id));
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/drizzle (mysql): subscriptions.update: no subscription with id ` +
          `${JSON.stringify(id)}.`,
      );
    }
    return row;
  } catch (error) {
    if (error instanceof PayweaveNotFoundError) throw error;
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (mysql): subscriptions.update(${JSON.stringify(id)}) failed.`,
    );
  }
}

// ── balances ─────────────────────────────────────────────────────────────────

async function balancesGet(db: MysqlDrizzleDb, customerId: string, featureId: string, group: string) {
  const rows = await db
    .select()
    .from(pwFeatureBalances)
    .where(
      and(
        eq(pwFeatureBalances.customerId, customerId),
        eq(pwFeatureBalances.featureId, featureId),
        eq(pwFeatureBalances.group, group),
      ),
    );
  return rows[0] ?? null;
}

async function balancesConsume(db: MysqlDrizzleDb, input: PwConsumeInput): Promise<PwConsumeResult> {
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(pwFeatureBalances)
      .where(
        and(
          eq(pwFeatureBalances.customerId, input.customerId),
          eq(pwFeatureBalances.featureId, input.featureId),
          eq(pwFeatureBalances.group, input.group),
        ),
      )
      .for("update");
    const existingRow = existingRows[0];
    const nowMs = input.now.getTime();

    if (!existingRow) {
      const period = currentPeriod(input.init.anchor.getTime(), input.init.resetInterval, nowMs);
      const remaining = input.init.limit;
      const applied = input.conditional !== true || remaining >= input.amount;
      const used = applied ? input.amount : 0;
      const id = generatePwId(nowMs);
      await tx.insert(pwFeatureBalances).values({
        id,
        customerId: input.customerId,
        featureId: input.featureId,
        group: input.group,
        used,
        limit: input.init.limit,
        resetInterval: input.init.resetInterval,
        anchor: input.init.anchor,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        planId: input.init.planId,
        planVersion: input.init.planVersion,
        updatedAt: input.now,
      });
      const rows = await tx.select().from(pwFeatureBalances).where(eq(pwFeatureBalances.id, id));
      const row = rows[0];
      if (!row) {
        throw new Error("drizzle adapter (mysql): balances.consume (create) returned no row");
      }
      return { ...row, applied };
    }

    const resetDue = nowMs >= existingRow.periodEnd.getTime();
    const baseUsed = resetDue ? 0 : existingRow.used;
    const period = resetDue
      ? currentPeriod(existingRow.anchor.getTime(), existingRow.resetInterval, nowMs)
      : { start: existingRow.periodStart.getTime(), end: existingRow.periodEnd.getTime() };
    const remaining = existingRow.limit - baseUsed;
    const applied = input.conditional !== true || remaining >= input.amount;

    if (!applied && !resetDue) {
      return { ...existingRow, applied: false };
    }

    const finalUsed = applied ? baseUsed + input.amount : baseUsed;
    await tx
      .update(pwFeatureBalances)
      .set({
        used: finalUsed,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        updatedAt: input.now,
      })
      .where(eq(pwFeatureBalances.id, existingRow.id));
    const rows = await tx
      .select()
      .from(pwFeatureBalances)
      .where(eq(pwFeatureBalances.id, existingRow.id));
    const updatedRow = rows[0];
    if (!updatedRow) {
      throw new Error("drizzle adapter (mysql): balances.consume (update) returned no row");
    }
    return { ...updatedRow, applied };
  });
}

async function balancesResetTo(
  db: MysqlDrizzleDb,
  customerId: string,
  featureId: string,
  group: string,
  init: PwFeatureBalanceInit,
): Promise<void> {
  const now = new Date();
  const period = currentPeriod(init.anchor.getTime(), init.resetInterval, now.getTime());
  const id = generatePwId(now.getTime());
  await db
    .insert(pwFeatureBalances)
    .values({
      id,
      customerId,
      featureId,
      group,
      used: 0,
      limit: init.limit,
      resetInterval: init.resetInterval,
      anchor: init.anchor,
      periodStart: new Date(period.start),
      periodEnd: new Date(period.end),
      planId: init.planId,
      planVersion: init.planVersion,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        used: 0,
        limit: init.limit,
        resetInterval: init.resetInterval,
        anchor: init.anchor,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        planId: init.planId,
        planVersion: init.planVersion,
        updatedAt: now,
      },
    });
}

// ── webhookEvents ────────────────────────────────────────────────────────────

async function webhookEventsClaim(
  db: MysqlDrizzleDb,
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
): Promise<boolean> {
  const staleClaimAfterMs = meta.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_AFTER_MS;
  const staleThreshold = new Date(meta.now.getTime() - staleClaimAfterMs);
  // Raw SQL: mysql-core's `.onDuplicateKeyUpdate` has no conditional/`WHERE`
  // form (see module header) — the `IF(...)` expression is the standard
  // MySQL substitute (PW-705's sanctioned technique).
  const raw = await db.execute(
    sql`insert into ${pwWebhookEvents} (dedupe_key, provider, type, received_at, claimed_at, applied_at)
        values (${dedupeKey}, ${meta.provider}, ${meta.type}, ${meta.now}, ${meta.now}, null)
        on duplicate key update claimed_at = if(applied_at is null and claimed_at <= ${staleThreshold}, ${meta.now}, claimed_at)`,
  );
  const result = asWriteResult(raw);
  // See module header: 1 = fresh insert (we win), 2 = the UPDATE branch
  // actually changed claimed_at (we won a steal), 0 = matched but unchanged.
  return result.affectedRows === 1 || result.affectedRows === 2;
}

async function webhookEventsMarkApplied(db: MysqlDrizzleDb, dedupeKey: string): Promise<void> {
  await db
    .update(pwWebhookEvents)
    .set({ appliedAt: new Date() })
    .where(eq(pwWebhookEvents.dedupeKey, dedupeKey));
}
