/**
 * Shared types for the embedded SQL migrations engine. The engine is pure
 * TypeScript: it emits SQL text through an
 * injected {@link MigrationExecutor} and never imports a driver
 * or reads files at runtime — migrations are
 * embedded string constants, so `dist` is self-contained.
 */

/** SQL dialects with Payweave-owned migrations. */
export const PW_SQL_DIALECTS = ["postgres", "mysql", "sqlite"] as const;

/**
 * A dialect the SQL migrations engine can emit DDL for. Deliberately narrower
 * than `DatabaseAdapter["dialect"]`: prisma/drizzle users own their migrations
 * and mongodb has NO SQL migrations — its adapter ensures
 * collections + indexes itself.
 */
export type PwSqlDialect = (typeof PW_SQL_DIALECTS)[number];

/**
 * One embedded, ordered migration. `id` is the ledger key recorded in the
 * `pw_migrations.name` column and defines execution order
 * (lexicographic — zero-padded numeric prefix, e.g. `0001_init`); `name` is a
 * short human-readable label. A migration that has ever been applied anywhere
 * is IMMUTABLE — changes ship as a new id (`0002_...`), never as an edit
 * (forward-only; mutated history fails loudly).
 */
export interface PwSqlMigration {
  /** Ledger key + sort key, e.g. `"0001_init"`. */
  readonly id: string;
  /** Human-readable label, e.g. `"init"`. */
  readonly name: string;
  /**
   * SQL statements executed one `MigrationExecutor.query()` call at a time,
   * in array order (never concatenated — multi-statement strings are not
   * portable across drivers).
   */
  readonly statements: readonly string[];
}

/** Rows returned by a {@link MigrationExecutor.query} call. */
export interface MigrationQueryResult {
  /** Result rows; empty for DDL / writes. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/**
 * The minimal execution surface a SQL adapter injects into
 * the engine — the engine's ONLY channel to the database. Implementations are
 * thin driver wrappers; the engine emits dialect-appropriate placeholders
 * (`$1…` for postgres, `?` for mysql/sqlite), so executors pass `sql` +
 * `params` straight through.
 */
export interface MigrationExecutor {
  /**
   * Execute exactly one SQL statement. `params` accompanies the engine's
   * ledger reads/writes; DDL statements are emitted without parameters.
   * Parameter values are `Date` instances for postgres/mysql timestamp
   * columns and epoch-millisecond integers for sqlite.
   */
  query(sql: string, params?: readonly unknown[]): Promise<MigrationQueryResult>;
  /**
   * Optional transactional wrapper. When present, `applyMigrations` runs each
   * migration's statements + its ledger insert through one `transaction`
   * call, so a failed migration rolls back atomically (worthwhile on postgres
   * and sqlite; MySQL DDL implicitly commits, so its executor may omit this).
   * When absent, statements run sequentially in auto-commit mode and a
   * failure surfaces immediately without rollback.
   */
  transaction?<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
}
