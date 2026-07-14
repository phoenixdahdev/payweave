/**
 * `pw_migrations` checksum-ledger SQL.
 * One row per applied migration: `name` (PK — the embedded migration's `id`),
 * `applied_at`, `checksum`. The engine bootstraps the ledger with
 * `CREATE TABLE IF NOT EXISTS` before every read, and `0001_init` embeds the
 * SAME statement so the DDL set alone realizes the full schema.
 *
 * Placeholder + parameter conventions (kept here so every SQL adapter's
 * executor stays pass-through): postgres uses `$1…`, mysql/sqlite use `?`; `applied_at`
 * binds a `Date` on postgres/mysql and an epoch-millisecond integer on sqlite
 * (sqlite stores all timestamps as `INTEGER` epoch ms — see `./ddl`).
 */
import { PW_TABLES } from "../schema";
import type { PwSqlDialect } from "./types";

/** Canonical ledger table name (`pw_migrations`). */
export const MIGRATION_LEDGER_TABLE = PW_TABLES.migrations;

/**
 * Idempotent ledger bootstrap. Also embedded verbatim as the first statement
 * of `0001_init`, where re-execution is a no-op.
 */
export function ledgerEnsureSql(dialect: PwSqlDialect): string {
  switch (dialect) {
    case "postgres":
      return `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL,
  checksum TEXT NOT NULL
)`;
    case "mysql":
      return `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  name VARCHAR(255) NOT NULL,
  applied_at DATETIME(3) NOT NULL,
  checksum VARCHAR(255) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
    case "sqlite":
      return `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
)`;
  }
}

/**
 * Full ledger read for history verification. Identical text on every dialect
 * (no parameters); ordered for deterministic output.
 */
export function ledgerSelectSql(dialect: PwSqlDialect): string {
  void dialect; // Same shape everywhere today; keeps the call sites uniform.
  return `SELECT name, checksum FROM ${MIGRATION_LEDGER_TABLE} ORDER BY name`;
}

/** Ledger append for one applied migration; see {@link ledgerInsertParams}. */
export function ledgerInsertSql(dialect: PwSqlDialect): string {
  const placeholders = dialect === "postgres" ? "$1, $2, $3" : "?, ?, ?";
  return `INSERT INTO ${MIGRATION_LEDGER_TABLE} (name, applied_at, checksum) VALUES (${placeholders})`;
}

/**
 * Parameters for {@link ledgerInsertSql}, in column order
 * (`name`, `applied_at`, `checksum`). sqlite binds `applied_at` as epoch ms.
 */
export function ledgerInsertParams(
  dialect: PwSqlDialect,
  migrationId: string,
  checksum: string,
  appliedAt: Date,
): readonly unknown[] {
  return [migrationId, dialect === "sqlite" ? appliedAt.getTime() : appliedAt, checksum];
}
