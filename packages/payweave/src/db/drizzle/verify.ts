/**
 * First-use table verification for the Drizzle adapter (docs/v1/database.md
 * §4, PW-708) — mirrors the Prisma adapter's model exactly (per the PW-708
 * brief: "PW-707's brief/PR — mirror its verification + instructions
 * patterns"): since `migrations.apply()` never runs DDL (drizzle-kit is
 * user-owned), the adapter instead verifies — on FIRST USE, not at factory
 * construction time (§1's sync/side-effect-free contract) — that the
 * expected `pw_*` tables exist, and throws a `PayweaveConfigError` naming the
 * missing tables AND the packaged schema file if not.
 *
 * "Verification caches its result per adapter instance — it must not tax the
 * hot path on every call" (brief): {@link createVerifier} memoizes a SUCCESSFUL
 * check forever, but clears the cache on failure so a later call (e.g. after
 * the user runs `drizzle-kit push` mid-process) re-attempts rather than
 * wedging into a permanent throw.
 */
import { sql } from "drizzle-orm";
import { PayweaveConfigError } from "../../core/errors";
import { PW_TABLES, type PwTableName } from "../schema";

/** Every table the Drizzle adapter needs — the ledger table is SQL-adapter-only (database.md §4). */
const REQUIRED_TABLES: readonly PwTableName[] = [
  PW_TABLES.customers,
  PW_TABLES.plans,
  PW_TABLES.subscriptions,
  PW_TABLES.featureBalances,
  PW_TABLES.webhookEvents,
];

const SCHEMA_FILE_HINT =
  '"payweave/db/drizzle"\'s published schema (src/db/drizzle/schema/{pg,mysql,sqlite}.ts — ' +
  "docs/v1/database.md §4) — merge it into your own Drizzle schema and run `drizzle-kit push` " +
  "or `drizzle-kit generate`/`migrate`.";

function missingTablesError(missing: readonly string[]): PayweaveConfigError {
  return new PayweaveConfigError(
    `payweave/db/drizzle: the following Payweave tables do not exist yet in the connected ` +
      `database: ${missing.join(", ")}. Merge ${SCHEMA_FILE_HINT}`,
  );
}

/** Probe one table for existence with an inert, side-effect-free query. */
export type TableProbe = (table: string) => Promise<boolean>;

async function findMissingTables(probe: TableProbe): Promise<string[]> {
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    if (!(await probe(table))) missing.push(table);
  }
  return missing;
}

/**
 * Build a memoized `ensureVerified()` gate from a dialect-specific existence
 * check. Every store method (except `migrations.status()/apply()`, which
 * report the same information without throwing) calls this before touching
 * the database.
 */
export function createVerifier(probe: TableProbe): () => Promise<void> {
  let cached: Promise<void> | undefined;
  return function ensureVerified(): Promise<void> {
    cached ??= (async () => {
      const missing = await findMissingTables(probe);
      if (missing.length > 0) throw missingTablesError(missing);
    })().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

/** Non-memoized variant for `migrations.status()` — reports rather than throws. */
export async function findMissingTablesForStatus(probe: TableProbe): Promise<string[]> {
  return findMissingTables(probe);
}

// ── Dialect probes ───────────────────────────────────────────────────────────
// A bare `SELECT 1 FROM <table> LIMIT 0` is valid, inert SQL on all three
// dialects and needs no per-dialect introspection query. sqlite-core exposes
// `.run(...)`; pg-core/mysql-core expose `.execute(...)` instead (verified
// against the installed drizzle-orm@0.45.2's `db.d.ts` for each dialect).

/**
 * sqlite-core's raw-query surface. `run()`'s return type is `unknown` (not
 * `Promise<unknown>`) because `BaseSQLiteDatabase`'s `"async" | "sync"`
 * result-kind union makes its declared return type itself a union of `T` and
 * `Promise<T>` — `await` handles both uniformly at runtime either way.
 */
export interface SqliteRunnable {
  run(query: unknown): unknown;
}

/** pg-core/mysql-core's raw-query surface. */
export interface SqlExecutable {
  execute(query: unknown): Promise<unknown>;
}

export function makeSqliteTableProbe(db: SqliteRunnable): TableProbe {
  return async (table) => {
    try {
      await db.run(sql`select 1 from ${sql.identifier(table)} limit 0`);
      return true;
    } catch {
      return false;
    }
  };
}

export function makeSqlTableProbe(db: SqlExecutable): TableProbe {
  return async (table) => {
    try {
      await db.execute(sql`select 1 from ${sql.identifier(table)} limit 0`);
      return true;
    } catch {
      return false;
    }
  };
}
