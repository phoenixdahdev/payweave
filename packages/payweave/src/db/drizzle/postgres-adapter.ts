/**
 * PostgreSQL store implementation for the Drizzle adapter. Built against the
 * published `./schema/pg.ts` tables.
 *
 * This is the dialect the shared conformance suite runs against in CI
 * (dockerized `postgres:16` + `drizzle-kit push`)
 * — unavailable in this sandbox (no docker), so it is NOT exercised
 * by a live conformance run here (`test/db/drizzle.test.ts` documents the
 * gate). The code below follows the Postgres/Drizzle approach
 * exactly: `db.transaction()` (a REAL row-locked transaction on a dedicated
 * pooled connection — unlike the sqlite dialect, `drizzle-orm`'s postgres
 * `.transaction()` supports concurrent async callbacks correctly) plus raw
 * `FOR UPDATE` (via the query builder's `.for("update")`, not a raw `sql`
 * fragment — pg-core exposes it natively) for the one read `balances.consume`
 * needs to recompute the current billing window via `src/products/period.ts`
 * (same reasoning as the sqlite adapter: no portable single
 * statement can replicate that calendar arithmetic safely).
 */
import { and, eq, sql } from "drizzle-orm";
import { PgDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
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
} from "./schema/pg";
import { createVerifier, findMissingTablesForStatus, makeSqlTableProbe } from "./verify";

/** Any `drizzle-orm` postgres instance (`node-postgres`, `postgres-js`, `neon`, …). */
export type PostgresDrizzleDb = PgDatabase<PgQueryResultHKT>;

const DRIZZLE_KIT_INSTRUCTIONS =
  "payweave/db/drizzle never runs migrations for you. Merge " +
  '"payweave/db/drizzle"\'s published schema (see `./schema/pg.ts`) into your own Drizzle schema, ' +
  "then run `drizzle-kit push` (dev) or `drizzle-kit generate` + `drizzle-kit migrate` (tracked " +
  "migrations) yourself.";

/** Build a full `DatabaseAdapter` over a Drizzle postgres `db` (or an open `tx`). */
export function buildPostgresAdapter(db: PostgresDrizzleDb): DatabaseAdapter {
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
    dialect: "postgres",
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
    transaction: (fn) => db.transaction((tx) => fn(buildPostgresAdapter(tx))),
  };
}

// ── customers ────────────────────────────────────────────────────────────────

async function customersGetByExternalId(db: PostgresDrizzleDb, externalId: string) {
  const rows = await db.select().from(pwCustomers).where(eq(pwCustomers.externalId, externalId));
  return rows[0] ?? null;
}

async function customersUpsert(db: PostgresDrizzleDb, input: PwCustomerUpsert) {
  const now = new Date();
  const id = generatePwId(now.getTime());
  try {
    const rows = await db
      .insert(pwCustomers)
      .values({
        id,
        externalId: input.externalId,
        providerIds: {},
        email: input.email ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pwCustomers.externalId,
        set: {
          email: sql`coalesce(excluded.email, ${pwCustomers.email})`,
          updatedAt: now,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("drizzle adapter (postgres): customers.upsert returned no row");
    return row;
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (postgres): customers.upsert(${JSON.stringify(input.externalId)}) failed.`,
    );
  }
}

async function customersLinkProviderRef(
  db: PostgresDrizzleDb,
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
        `payweave/db/drizzle (postgres): customers.linkProviderRef: no customer with externalId ` +
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

async function plansGetActiveVersion(db: PostgresDrizzleDb, planId: string) {
  const rows = await db
    .select()
    .from(pwPlans)
    .where(eq(pwPlans.planId, planId))
    .orderBy(sql`${pwPlans.version} desc`)
    .limit(1);
  return rows[0] ?? null;
}

async function plansListActive(db: PostgresDrizzleDb) {
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

async function plansPushVersion(db: PostgresDrizzleDb, plan: PwPlanVersionInput) {
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
    const rows = await tx
      .insert(pwPlans)
      .values({
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
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("drizzle adapter (postgres): plans.pushVersion returned no row");
    return row;
  });
}

// ── subscriptions ────────────────────────────────────────────────────────────

async function subscriptionsGetActive(db: PostgresDrizzleDb, customerId: string, group: string) {
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

async function subscriptionsCreate(db: PostgresDrizzleDb, input: PwSubscriptionInput) {
  const now = new Date();
  const id = generatePwId(now.getTime());
  try {
    const rows = await db
      .insert(pwSubscriptions)
      .values({
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
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("drizzle adapter (postgres): subscriptions.create returned no row");
    return row;
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (postgres): subscriptions.create for customer ` +
        `${JSON.stringify(input.customerId)} group ${JSON.stringify(input.group)} violated a ` +
        "uniqueness rule (an active-set subscription already exists for this customer/group, or " +
        "another constraint failed).",
    );
  }
}

async function subscriptionsUpdate(db: PostgresDrizzleDb, id: string, patch: PwSubscriptionPatch) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) set[key] = value;
  }
  try {
    const rows = await db
      .update(pwSubscriptions)
      .set(set)
      .where(eq(pwSubscriptions.id, id))
      .returning();
    const row = rows[0];
    if (!row) {
      throw new PayweaveNotFoundError(
        `payweave/db/drizzle (postgres): subscriptions.update: no subscription with id ` +
          `${JSON.stringify(id)}.`,
      );
    }
    return row;
  } catch (error) {
    if (error instanceof PayweaveNotFoundError) throw error;
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (postgres): subscriptions.update(${JSON.stringify(id)}) failed.`,
    );
  }
}

// ── balances ─────────────────────────────────────────────────────────────────

async function balancesGet(db: PostgresDrizzleDb, customerId: string, featureId: string, group: string) {
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

async function balancesConsume(
  db: PostgresDrizzleDb,
  input: PwConsumeInput,
): Promise<PwConsumeResult> {
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
      const rows = await tx
        .insert(pwFeatureBalances)
        .values({
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
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error("drizzle adapter (postgres): balances.consume (create) returned no row");
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
    const rows = await tx
      .update(pwFeatureBalances)
      .set({
        used: finalUsed,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        updatedAt: input.now,
      })
      .where(eq(pwFeatureBalances.id, existingRow.id))
      .returning();
    const updatedRow = rows[0];
    if (!updatedRow) {
      throw new Error("drizzle adapter (postgres): balances.consume (update) returned no row");
    }
    return { ...updatedRow, applied };
  });
}

async function balancesResetTo(
  db: PostgresDrizzleDb,
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
    .onConflictDoUpdate({
      target: [pwFeatureBalances.customerId, pwFeatureBalances.featureId, pwFeatureBalances.group],
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
  db: PostgresDrizzleDb,
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
): Promise<boolean> {
  const staleClaimAfterMs = meta.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_AFTER_MS;
  const staleThreshold = new Date(meta.now.getTime() - staleClaimAfterMs);
  const rows = await db
    .insert(pwWebhookEvents)
    .values({
      dedupeKey,
      provider: meta.provider,
      type: meta.type,
      receivedAt: meta.now,
      claimedAt: meta.now,
      appliedAt: null,
    })
    .onConflictDoUpdate({
      target: pwWebhookEvents.dedupeKey,
      set: { claimedAt: meta.now },
      // See the sqlite dialect file's identical comment: `and(...)` with two
      // fixed conditions never actually returns `undefined`.
      setWhere: and(
        sql`${pwWebhookEvents.appliedAt} is null`,
        sql`${pwWebhookEvents.claimedAt} <= ${staleThreshold}`,
      )!,
    })
    .returning({ claimedAt: pwWebhookEvents.claimedAt });
  const row = rows[0];
  return row !== undefined && row.claimedAt !== null && row.claimedAt.getTime() === meta.now.getTime();
}

async function webhookEventsMarkApplied(db: PostgresDrizzleDb, dedupeKey: string): Promise<void> {
  await db
    .update(pwWebhookEvents)
    .set({ appliedAt: new Date() })
    .where(eq(pwWebhookEvents.dedupeKey, dedupeKey));
}
