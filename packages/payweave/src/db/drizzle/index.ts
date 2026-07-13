/**
 * `payweave/db/drizzle` — Drizzle ORM adapter (docs/v1/database.md §1/§4,
 * PW-708). Wraps YOUR OWN existing `drizzle-orm` instance (whatever
 * postgres/mysql/sqlite driver it wraps) behind the shared
 * {@link DatabaseAdapter} contract.
 *
 * "Same model" as the Prisma adapter (database.md §4, the PW-708 brief):
 * Payweave publishes the schema (`./schema/{pg,mysql,sqlite}.ts` — merge one
 * into your own Drizzle schema) and you own migrations via `drizzle-kit`
 * (`push` for local/dev, `generate` + `migrate` for tracked history).
 * `migrations.apply()` NEVER shells out or runs DDL — it returns an
 * instructions result (database.md §3's `apply()` union); `migrations.status()`
 * reports which tables are missing by probing the connected database.
 *
 * ── Dialect detection (build-time resolution, database.md §4) ──────────────
 * `drizzleAdapter(db, options?)` auto-detects which of postgres/mysql/sqlite
 * `db` is backed by via `instanceof` against `drizzle-orm`'s dialect base
 * classes (`./detect.ts` — verified stable against the installed
 * `drizzle-orm@0.45.2`). `options.dialect` is an explicit override for the
 * rare case where that detection fails (e.g. a proxied/wrapped instance whose
 * prototype chain breaks `instanceof`).
 *
 * ── Conformance obligations (database.md §6) ────────────────────────────────
 * CI's obligation is the Postgres variant (dockerized `postgres:16` +
 * `drizzle-kit push`, PW-710's matrix) — unavailable in this sandbox (no
 * docker). `test/db/drizzle.test.ts` instead runs the FULL conformance suite
 * in-process against `drizzle-orm/libsql` over an in-memory `@libsql/client`
 * (a real, runnable sqlite dialect — no docker needed either way, mirroring
 * PW-706's own in-memory conformance runs) as a stand-in proof that the
 * adapter logic (dialect dispatch, atomicity, verification, instructions-only
 * migrations) is correct; the postgres/mysql code paths are implemented to
 * the same contract but ride PW-710's docker matrix for their conformance
 * proof, per this ticket's environment constraints.
 */
import { PayweaveConfigError } from "../../core/errors";
import type { DatabaseAdapter } from "../index";
import { detectDrizzleDialect, type DrizzleDialect } from "./detect";
import { buildMysqlAdapter } from "./mysql-adapter";
import { buildPostgresAdapter } from "./postgres-adapter";
import { buildSqliteAdapter, type SqliteDrizzleDb } from "./sqlite-adapter";

export { mysqlSchema } from "./schema/mysql";
export { pgSchema } from "./schema/pg";
export { sqliteSchema } from "./schema/sqlite";
export type { DrizzleDialect } from "./detect";

/** `drizzleAdapter(db, options?)`'s second argument. */
export interface DrizzleAdapterOptions {
  /**
   * Force the dialect instead of auto-detecting it from `db` (database.md §4
   * build-time resolution — see the module header). Rarely needed:
   * `instanceof` detection against `drizzle-orm`'s dialect base classes is
   * stable across postgres/mysql/sqlite for every driver `drizzle-orm` ships.
   */
  dialect?: DrizzleDialect;
}

/**
 * Structural shape every `drizzle-orm` `db` instance satisfies, regardless of
 * dialect — enough to validate the argument eagerly (database.md §1) without
 * importing `drizzle-orm` merely to check it.
 */
function looksLikeDrizzleDb(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.select === "function" &&
    typeof candidate.insert === "function" &&
    typeof candidate.update === "function" &&
    typeof candidate.transaction === "function"
  );
}

/**
 * Create a {@link DatabaseAdapter} over your existing Drizzle `db` instance.
 * Construction is synchronous and side-effect-free (database.md §1): `db`'s
 * shape is validated eagerly; the dialect is detected (or takes
 * `options.dialect`) synchronously too, since `drizzle-orm`'s dialect base
 * classes are already in memory the moment the caller constructed `db`
 * itself. No query runs, no table-existence check happens, until the first
 * store method call (`./verify.ts`).
 *
 * @throws {PayweaveConfigError} synchronously if `db` is not recognizable as
 *   a Drizzle instance, or if its dialect cannot be detected and no
 *   `options.dialect` override was given.
 */
export function drizzleAdapter(db: unknown, options: DrizzleAdapterOptions = {}): DatabaseAdapter {
  if (!looksLikeDrizzleDb(db)) {
    throw new PayweaveConfigError(
      "payweave/db/drizzle: drizzleAdapter(db) expects your own `drizzle-orm` database instance " +
        "(the object returned by e.g. `drizzle(pool)`/`drizzle(client)`) — got " +
        `${typeof db === "object" && db !== null ? "an object missing select/insert/update/transaction" : typeof db}.`,
    );
  }
  const dialect = detectDrizzleDialect(db, options.dialect);
  switch (dialect) {
    case "sqlite":
      return buildSqliteAdapter(db as SqliteDrizzleDb);
    case "postgres":
      return buildPostgresAdapter(db as Parameters<typeof buildPostgresAdapter>[0]);
    case "mysql":
      return buildMysqlAdapter(db as Parameters<typeof buildMysqlAdapter>[0]);
  }
}
