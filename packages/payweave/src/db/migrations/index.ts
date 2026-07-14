/**
 * Embedded SQL migrations engine for the Payweave database layer. Consumed
 * by the SQL adapters to implement `DatabaseAdapter.migrations.status()/apply()`
 * and by `payweave push` through those adapters.
 */
export { PW_SQL_DIALECTS } from "./types";
export type {
  MigrationExecutor,
  MigrationQueryResult,
  PwSqlDialect,
  PwSqlMigration,
} from "./types";
export {
  PayweaveMigrationError,
  PayweaveMigrationHistoryError,
  type PwMigrationHistoryErrorReason,
} from "./errors";
export { PW_MIGRATION_IDS, migrationsFor } from "./definitions";
export {
  MIGRATION_LEDGER_TABLE,
  ledgerEnsureSql,
  ledgerInsertParams,
  ledgerInsertSql,
  ledgerSelectSql,
} from "./ledger";
export {
  MYSQL_INIT_STATEMENTS,
  POSTGRES_INIT_STATEMENTS,
  SQLITE_INIT_STATEMENTS,
} from "./ddl";
export { applyMigrations, migrationChecksum, planMigrations } from "./engine";
