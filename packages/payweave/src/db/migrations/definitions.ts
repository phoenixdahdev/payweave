/**
 * The embedded, ordered migration list per SQL dialect (docs/v1/database.md
 * §4, PW-703). Pure data: no filesystem reads, no drivers — `dist` never
 * touches runtime files. Ordering is id-lexicographic (zero-padded numeric
 * prefixes), and the list is APPEND-ONLY: a migration that has been applied
 * anywhere is immutable forever; changes ship as the next id.
 */
import { PayweaveMigrationError } from "./errors";
import {
  MYSQL_INIT_STATEMENTS,
  POSTGRES_INIT_STATEMENTS,
  SQLITE_INIT_STATEMENTS,
} from "./ddl";
import type { PwSqlDialect, PwSqlMigration } from "./types";

const migration = (
  id: string,
  name: string,
  statements: readonly string[],
): PwSqlMigration => Object.freeze({ id, name, statements });

/**
 * Ids of every embedded migration, in execution order. Identical across
 * dialects by construction — only the statement TEXT varies per dialect.
 */
export const PW_MIGRATION_IDS = Object.freeze(["0001_init"] as const);

const MIGRATIONS_BY_DIALECT: Record<PwSqlDialect, readonly PwSqlMigration[]> = {
  postgres: Object.freeze([migration("0001_init", "init", POSTGRES_INIT_STATEMENTS)]),
  mysql: Object.freeze([migration("0001_init", "init", MYSQL_INIT_STATEMENTS)]),
  sqlite: Object.freeze([migration("0001_init", "init", SQLITE_INIT_STATEMENTS)]),
};

/**
 * The embedded migration list for `dialect`, in execution order. Pure and
 * deterministic — same input, same (frozen) output. Throws
 * {@link PayweaveMigrationError} for any non-SQL dialect: mongodb has NO SQL
 * migrations (its adapter ensures collections/indexes itself) and
 * prisma/drizzle users own their migrations.
 */
export function migrationsFor(dialect: PwSqlDialect): readonly PwSqlMigration[] {
  switch (dialect) {
    case "postgres":
    case "mysql":
    case "sqlite":
      return MIGRATIONS_BY_DIALECT[dialect];
    default:
      throw new PayweaveMigrationError(
        `Unsupported SQL migration dialect ${JSON.stringify(dialect satisfies never)} — ` +
          `the Payweave migrations engine covers "postgres", "mysql" and "sqlite" only ` +
          `(docs/v1/database.md §4: mongodb/prisma/drizzle have no Payweave-owned SQL migrations).`,
      );
  }
}
