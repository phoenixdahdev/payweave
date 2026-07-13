/**
 * Dialect detection for `drizzleAdapter(db)` (docs/v1/database.md §1/§4, PW-708).
 *
 * ── Build-time resolution (recorded in database.md §4) ──────────────────────
 * The PW-708 brief flags dialect detection as a ⚠️-style check: "attempt
 * detection from the instance; if drizzle-orm exposes no stable public
 * discriminator... accept an explicit second argument." Verified against the
 * installed `drizzle-orm@0.45.2`: it DOES expose a stable, public
 * discriminator — `drizzle(...)` for postgres/mysql/sqlite each return an
 * instance of a dialect base class the package exports from a driver-INDEPENDENT
 * entry point (`drizzle-orm/pg-core`'s `PgDatabase`, `drizzle-orm/mysql-core`'s
 * `MySqlDatabase`, `drizzle-orm/sqlite-core`'s `BaseSQLiteDatabase`) —
 * confirmed empirically: `drizzle(new Database(":memory:")) instanceof
 * BaseSQLiteDatabase` is `true` regardless of which of the sqlite-family
 * drivers (better-sqlite3, `@libsql/client`, D1, Bun, Expo…) actually backs
 * it, and importing these three `-core` entry points requires only
 * `drizzle-orm` itself — never `pg`/`mysql2`/`better-sqlite3` — so `instanceof`
 * detection carries no extra driver dependency. `instanceof` is therefore used
 * as the primary mechanism, with `options.dialect` as a documented escape
 * hatch (e.g. for a proxied/wrapped `db` whose prototype chain does not
 * preserve the `instanceof` relationship).
 */
import { MySqlDatabase } from "drizzle-orm/mysql-core";
import { PgDatabase } from "drizzle-orm/pg-core";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { PayweaveConfigError } from "../../core/errors";

/** The SQL dialects a `drizzle-orm` instance can wrap that this adapter supports. */
export type DrizzleDialect = "postgres" | "mysql" | "sqlite";

/**
 * Resolve the SQL dialect behind a Drizzle `db` instance. `override` (from
 * `drizzleAdapter(db, { dialect })`) always wins over detection.
 *
 * @throws {PayweaveConfigError} when `db` is not a recognizable Drizzle
 *   instance of any of the three supported dialect base classes and no
 *   `override` was given.
 */
export function detectDrizzleDialect(db: unknown, override?: DrizzleDialect): DrizzleDialect {
  if (override !== undefined) return override;
  if (db instanceof PgDatabase) return "postgres";
  if (db instanceof MySqlDatabase) return "mysql";
  if (db instanceof BaseSQLiteDatabase) return "sqlite";
  throw new PayweaveConfigError(
    "payweave/db/drizzle: could not detect the SQL dialect of the given Drizzle instance (expected " +
      "an instance backed by drizzle-orm/pg-core, drizzle-orm/mysql-core, or drizzle-orm/sqlite-core). " +
      'Pass it explicitly: drizzleAdapter(db, { dialect: "postgres" | "mysql" | "sqlite" }).',
  );
}
