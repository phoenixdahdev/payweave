/**
 * SQLite/libSQL store implementation for the Drizzle adapter (docs/v1/database.md
 * §2/§3/§5, PW-708). Built against the published `./schema/sqlite.ts` tables —
 * works identically whether the caller's `drizzle-orm` instance wraps
 * `better-sqlite3` or `@libsql/client` (any `BaseSQLiteDatabase`).
 *
 * ── Atomicity (spec-silent engineering decision, mirrors PW-706) ───────────
 * `balances.consume` must recompute the CURRENT billing window from the row's
 * OWN stored `anchor`/`resetInterval` using `src/products/period.ts`'s exact
 * clamp-once calendar arithmetic (the conformance suite's oracle) — no
 * portable single SQL statement can replicate that safely across every
 * `drizzle-orm` sqlite backend (PW-706's `./adapter.ts` header explains this
 * in full for the raw-driver case; the same reasoning applies here, doubled,
 * since this ONE adapter must also work over postgres/mysql `drizzle-orm`
 * instances via the SAME public interface). So `consume` reads the current
 * row, decides via `period.ts` directly, and writes the result back.
 *
 * Correctness under `database.md §5`'s N=50 concurrent-call requirement does
 * NOT come from SQL transactions here — empirically, `drizzle-orm`'s own
 * `.transaction()` is unusable for this purpose: the `better-sqlite3` session
 * rejects an async transaction callback outright ("Transaction function
 * cannot return a promise" — better-sqlite3 requires its transactions to be
 * fully synchronous), and concurrent `.transaction()` calls against a
 * `:memory:` `@libsql/client` can each open a DISTINCT physical connection
 * (verified empirically: a second concurrent transaction saw a blank,
 * table-less database) — exactly the "an in-memory database is PER
 * CONNECTION" hazard PW-706's brief calls out. Instead, {@link SerialQueue}
 * (below) serializes every operation issued through THIS adapter instance
 * onto one logical FIFO queue, so at most one read-decide-write sequence (or
 * user-visible `transaction()` callback) is ever in flight against the
 * caller's `db` — the single-connection assumption PW-706 documents holds
 * for Drizzle-wrapped sqlite too (a pooled sqlite `db` is not a realistic
 * configuration). `transaction()` still issues REAL `BEGIN IMMEDIATE` /
 * `COMMIT` / `ROLLBACK` (via `db.run(sql\`...\`)`) so a thrown callback rolls
 * back every write the user made inside it (conformance's
 * "transaction — visibility + atomicity" scenario) — internal single-writer
 * helpers (`consume`, `pushVersion`, `linkProviderRef`) rely on the queue
 * alone (their one terminal write is already atomic at the SQLite level; if
 * anything before it throws, nothing was written).
 */
import { and, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
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
} from "./schema/sqlite";
import { createVerifier, findMissingTablesForStatus, makeSqliteTableProbe } from "./verify";

/** Any `drizzle-orm` sqlite instance (better-sqlite3, `@libsql/client`, D1, Bun, Expo, …). */
export type SqliteDrizzleDb = BaseSQLiteDatabase<"async" | "sync", unknown>;

// ── Serialization primitives ─────────────────────────────────────────────────

/** A strict FIFO chain: `run` never starts before the previous `run` settles. */
class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    // The chain itself must never reject, or every later-queued op wedges forever.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** What every store method funnels through — see the module header for why. */
interface SqliteRunner {
  /** Serialize (top-level) or run inline (already inside a held slot). */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** The public `DatabaseAdapter.transaction(fn)` surface. */
  transaction<T>(db: SqliteDrizzleDb, fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;
}

class TopLevelRunner implements SqliteRunner {
  readonly #queue = new SerialQueue();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run(fn);
  }

  transaction<T>(db: SqliteDrizzleDb, fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      await db.run(sql`BEGIN IMMEDIATE`);
      try {
        const nested = buildSqliteAdapter(db, new NestedRunner());
        const result = await fn(nested);
        await db.run(sql`COMMIT`);
        return result;
      } catch (error) {
        try {
          await db.run(sql`ROLLBACK`);
        } catch {
          // best-effort — the original `error` is what surfaces to the caller.
        }
        throw error;
      }
    });
  }
}

/** Bound to an already-open transaction — reentrant, no nested `BEGIN`. */
class NestedRunner implements SqliteRunner {
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  transaction<T>(db: SqliteDrizzleDb, fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return fn(buildSqliteAdapter(db, this));
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Build a full `DatabaseAdapter` over a Drizzle sqlite `db` (fresh top-level runner if omitted). */
export function buildSqliteAdapter(
  db: SqliteDrizzleDb,
  runner: SqliteRunner = new TopLevelRunner(),
): DatabaseAdapter {
  // First-use table verification (database.md §4 "Same model" as Prisma —
  // see ./verify.ts). Every store method is gated behind it EXCEPT
  // `migrations.status()/apply()`, which must keep working (to report what's
  // missing / hand back instructions) even before the schema exists.
  const ensureVerified = createVerifier(makeSqliteTableProbe(db));
  function guarded<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
  ): (...args: Args) => Promise<T> {
    return (...args: Args) =>
      runner.enqueue(async () => {
        await ensureVerified();
        return fn(...args);
      });
  }

  return {
    dialect: "sqlite",
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
      status: () => sqliteMigrationsStatus(db),
      apply: () => Promise.resolve(sqliteMigrationsApply()),
    },
    transaction: (fn) => runner.transaction(db, fn),
  };
}

// ── migrations (database.md §4 — "Same model" as Prisma: instructions only) ─

const DRIZZLE_KIT_INSTRUCTIONS =
  "payweave/db/drizzle never runs migrations for you (database.md §4). Merge " +
  '"payweave/db/drizzle"\'s published schema (see `./schema/sqlite.ts`) into your own Drizzle ' +
  "schema, then run `drizzle-kit push` (dev) or `drizzle-kit generate` + `drizzle-kit migrate` " +
  "(tracked migrations) yourself.";

function sqliteMigrationsApply(): { applied: string[]; instructions: string } {
  return { applied: [], instructions: DRIZZLE_KIT_INSTRUCTIONS };
}

async function sqliteMigrationsStatus(
  db: SqliteDrizzleDb,
): Promise<{ pending: string[]; applied: string[] }> {
  const missing = await findMissingTablesForStatus(makeSqliteTableProbe(db));
  return missing.length > 0
    ? { pending: ["0001_init"], applied: [] }
    : { pending: [], applied: ["0001_init"] };
}

// ── customers ────────────────────────────────────────────────────────────────

async function customersGetByExternalId(db: SqliteDrizzleDb, externalId: string) {
  const rows = await db.select().from(pwCustomers).where(eq(pwCustomers.externalId, externalId));
  return rows[0] ?? null;
}

async function customersUpsert(db: SqliteDrizzleDb, input: PwCustomerUpsert) {
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
    if (!row) throw new Error("drizzle adapter (sqlite): customers.upsert returned no row");
    return row;
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (sqlite): customers.upsert(${JSON.stringify(input.externalId)}) failed.`,
    );
  }
}

async function customersLinkProviderRef(
  db: SqliteDrizzleDb,
  externalId: string,
  provider: string,
  ref: string,
): Promise<void> {
  const rows = await db.select().from(pwCustomers).where(eq(pwCustomers.externalId, externalId));
  const row = rows[0];
  if (!row) {
    throw new PayweaveNotFoundError(
      `payweave/db/drizzle (sqlite): customers.linkProviderRef: no customer with externalId ` +
        `${JSON.stringify(externalId)}.`,
    );
  }
  const providerIds = { ...row.providerIds, [provider]: ref };
  await db
    .update(pwCustomers)
    .set({ providerIds, updatedAt: new Date() })
    .where(eq(pwCustomers.externalId, externalId));
}

// ── plans ────────────────────────────────────────────────────────────────────

async function plansGetActiveVersion(db: SqliteDrizzleDb, planId: string) {
  const rows = await db
    .select()
    .from(pwPlans)
    .where(eq(pwPlans.planId, planId))
    .orderBy(sql`${pwPlans.version} desc`)
    .limit(1);
  return rows[0] ?? null;
}

async function plansListActive(db: SqliteDrizzleDb) {
  const latest = db
    .select({
      planId: pwPlans.planId,
      version: sql<number>`max(${pwPlans.version})`.as("max_version"),
    })
    .from(pwPlans)
    .groupBy(pwPlans.planId)
    .as("latest");
  const rows = await db
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
    .innerJoin(
      latest,
      and(eq(latest.planId, pwPlans.planId), eq(latest.version, pwPlans.version)),
    );
  return rows;
}

async function plansPushVersion(db: SqliteDrizzleDb, plan: PwPlanVersionInput) {
  const activeRows = await db
    .select()
    .from(pwPlans)
    .where(eq(pwPlans.planId, plan.planId))
    .orderBy(sql`${pwPlans.version} desc`)
    .limit(1);
  const active = activeRows[0] ?? null;
  if (active && planContentEquals(active, plan)) {
    return active;
  }
  const now = new Date();
  const id = generatePwId(now.getTime());
  const nextVersion = (active?.version ?? 0) + 1;
  const rows = await db
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
  if (!row) throw new Error("drizzle adapter (sqlite): plans.pushVersion returned no row");
  return row;
}

// ── subscriptions ────────────────────────────────────────────────────────────

async function subscriptionsGetActive(db: SqliteDrizzleDb, customerId: string, group: string) {
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

async function subscriptionsCreate(db: SqliteDrizzleDb, input: PwSubscriptionInput) {
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
    if (!row) throw new Error("drizzle adapter (sqlite): subscriptions.create returned no row");
    return row;
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (sqlite): subscriptions.create for customer ` +
        `${JSON.stringify(input.customerId)} group ${JSON.stringify(input.group)} violated a ` +
        "uniqueness rule (an active-set subscription already exists for this customer/group, or " +
        "another constraint failed).",
    );
  }
}

async function subscriptionsUpdate(db: SqliteDrizzleDb, id: string, patch: PwSubscriptionPatch) {
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
        `payweave/db/drizzle (sqlite): subscriptions.update: no subscription with id ` +
          `${JSON.stringify(id)}.`,
      );
    }
    return row;
  } catch (error) {
    if (error instanceof PayweaveNotFoundError) throw error;
    throw wrapDriverError(
      error,
      `payweave/db/drizzle (sqlite): subscriptions.update(${JSON.stringify(id)}) failed.`,
    );
  }
}

// ── balances ─────────────────────────────────────────────────────────────────

async function balancesGet(db: SqliteDrizzleDb, customerId: string, featureId: string, group: string) {
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

async function balancesConsume(db: SqliteDrizzleDb, input: PwConsumeInput): Promise<PwConsumeResult> {
  const existingRows = await db
    .select()
    .from(pwFeatureBalances)
    .where(
      and(
        eq(pwFeatureBalances.customerId, input.customerId),
        eq(pwFeatureBalances.featureId, input.featureId),
        eq(pwFeatureBalances.group, input.group),
      ),
    );
  const existingRow = existingRows[0];
  const nowMs = input.now.getTime();

  if (!existingRow) {
    const period = currentPeriod(input.init.anchor.getTime(), input.init.resetInterval, nowMs);
    const remaining = input.init.limit; // baseUsed is 0 on creation
    const applied = input.conditional !== true || remaining >= input.amount;
    const used = applied ? input.amount : 0;
    const id = generatePwId(nowMs);
    const rows = await db
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
    if (!row) throw new Error("drizzle adapter (sqlite): balances.consume (create) returned no row");
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
    // Denied and no reset was due: database.md §3 requires the row be left
    // COMPLETELY untouched — including `updatedAt` — so issue no write at all.
    return { ...existingRow, applied: false };
  }

  const finalUsed = applied ? baseUsed + input.amount : baseUsed;
  const rows = await db
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
  if (!updatedRow) throw new Error("drizzle adapter (sqlite): balances.consume (update) returned no row");
  return { ...updatedRow, applied };
}

async function balancesResetTo(
  db: SqliteDrizzleDb,
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
  db: SqliteDrizzleDb,
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
      // `and(...)` only returns `undefined` when given zero conditions —
      // these two are always present, so the non-null assertion is safe
      // (satisfies `exactOptionalPropertyTypes`, which forbids `| undefined`
      // on `setWhere` even though `and()`'s own return type allows it).
      setWhere: and(
        sql`${pwWebhookEvents.appliedAt} is null`,
        sql`${pwWebhookEvents.claimedAt} <= ${staleThreshold}`,
      )!,
    })
    .returning({ claimedAt: pwWebhookEvents.claimedAt });
  const row = rows[0];
  return row !== undefined && row.claimedAt !== null && row.claimedAt.getTime() === meta.now.getTime();
}

async function webhookEventsMarkApplied(db: SqliteDrizzleDb, dedupeKey: string): Promise<void> {
  await db
    .update(pwWebhookEvents)
    .set({ appliedAt: new Date() })
    .where(eq(pwWebhookEvents.dedupeKey, dedupeKey));
}
