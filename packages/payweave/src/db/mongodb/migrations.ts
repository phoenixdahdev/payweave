/**
 * Idempotent collection + index setup for the MongoDB adapter. MongoDB does
 * NOT use `src/db/migrations/*` (the SQL-only engine) — instead
 * `migrations.status()`/`apply()` directly introspect and (re)create the
 * `pw_*` collections' indexes every time they run, so there is no ledger to
 * drift out of sync with reality.
 *
 * `createIndex(...)` both creates the target collection (if it doesn't exist
 * yet — an implicit MongoDB behavior) AND the index in one idempotent call:
 * calling it again with the IDENTICAL spec/name is a documented no-op, so
 * `apply()` is safe to run any number of times — run it twice and there's no
 * error, no duplicate indexes. Every index below is given an EXPLICIT,
 * stable `name` so re-running `apply()` after a partial failure, or a
 * differently-ordered driver call, can never accidentally create a SECOND
 * index with the same keys under an auto-generated name.
 *
 * Only ONE logical "migration" exists for mongo (`MIGRATION_NAME`, mirroring
 * the SQL adapters' `"0001_init"` naming purely for `migrations.status()`'s
 * shared `{ pending, applied }` shape) — it is all-or-nothing: either every
 * required index exists (`applied`) or at least one is missing (`pending`).
 */
import {
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  PW_TABLES,
} from "../schema";

/** The one logical migration mongo tracks — see the module header. */
export const MIGRATION_NAME = "0001_init";

/** Minimal structural shape of a `mongodb` `Collection` this file relies on. */
export interface MongoIndexCollectionLike {
  createIndex(indexSpec: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<string>;
  indexes(): Promise<ReadonlyArray<{ name?: string }>>;
}

/** Minimal structural shape of a `mongodb` `Db` this file relies on. */
export interface MongoIndexDbLike {
  collection(name: string): MongoIndexCollectionLike;
}

interface RequiredIndex {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  options?: Record<string, unknown>;
}

/**
 * Every index the schema requires, beyond the default `_id` index
 * (which already covers `pw_webhook_events.dedupeKey` and, conceptually,
 * every other collection's `pwv_` id — both are stored AS `_id`).
 */
const REQUIRED_INDEXES: readonly RequiredIndex[] = [
  {
    collection: PW_TABLES.customers,
    name: "pw_customers_externalId_unique",
    key: { externalId: 1 },
    options: { unique: true },
  },
  {
    collection: PW_TABLES.plans,
    name: "pw_plans_planId_version_unique",
    key: { planId: 1, version: 1 },
    options: { unique: true },
  },
  {
    collection: PW_TABLES.subscriptions,
    name: "pw_subscriptions_active_unique",
    key: { customerId: 1, group: 1 },
    options: {
      unique: true,
      // The partial-unique active-subscription rule: at most one row per
      // (customerId, group) whose status is in the active set — everything
      // else (canceled/incomplete, and any OTHER status a community fork
      // might add) falls outside the filter and never collides.
      partialFilterExpression: { status: { $in: [...PW_ACTIVE_SUBSCRIPTION_STATUSES] } },
    },
  },
  {
    collection: PW_TABLES.featureBalances,
    name: "pw_feature_balances_unique",
    key: { customerId: 1, featureId: 1, group: 1 },
    options: { unique: true },
  },
];

/** `true` if `error` means "this collection/namespace does not exist yet" (fresh db). */
function isNamespaceNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 26; // NamespaceNotFound
}

async function existingIndexNames(db: MongoIndexDbLike, collectionName: string): Promise<Set<string>> {
  try {
    const infos = await db.collection(collectionName).indexes();
    return new Set(infos.map((i) => i.name).filter((n): n is string => typeof n === "string"));
  } catch (error) {
    if (isNamespaceNotFound(error)) return new Set();
    throw error;
  }
}

async function missingIndexes(db: MongoIndexDbLike): Promise<RequiredIndex[]> {
  const missing: RequiredIndex[] = [];
  const byCollection = new Map<string, Set<string>>();
  for (const required of REQUIRED_INDEXES) {
    let names = byCollection.get(required.collection);
    if (!names) {
      names = await existingIndexNames(db, required.collection);
      byCollection.set(required.collection, names);
    }
    if (!names.has(required.name)) missing.push(required);
  }
  return missing;
}

/** `{ pending, applied }` reflecting whether every required index currently exists. */
export async function mongoMigrationStatus(
  db: MongoIndexDbLike,
): Promise<{ pending: string[]; applied: string[] }> {
  const missing = await missingIndexes(db);
  return missing.length === 0
    ? { pending: [], applied: [MIGRATION_NAME] }
    : { pending: [MIGRATION_NAME], applied: [] };
}

/**
 * Idempotently (re)create every missing required index. Safe to call
 * repeatedly — an already-present index (same name, same spec) is a
 * documented MongoDB no-op.
 */
export async function mongoMigrationApply(
  db: MongoIndexDbLike,
): Promise<{ applied: string[] }> {
  const missing = await missingIndexes(db);
  if (missing.length === 0) return { applied: [] };
  for (const required of missing) {
    await db.collection(required.collection).createIndex(required.key, {
      name: required.name,
      ...required.options,
    });
  }
  return { applied: [MIGRATION_NAME] };
}
