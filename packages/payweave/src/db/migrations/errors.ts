/**
 * Error classes thrown by the SQL migrations engine (docs/v1/database.md §4,
 * PW-703). Both extend {@link PayweaveError} so adapter `migrations.status()`
 * / `migrations.apply()` methods satisfy the golden rule that public SDK
 * methods only ever throw `PayweaveError` subclasses.
 */
import { PayweaveError, type PayweaveErrorOptions } from "../../core/errors";

/**
 * Base class for every failure the SQL migrations engine raises itself:
 * execution failures (with the driver error as `cause`), malformed embedded
 * migration sets, malformed ledger rows, unsupported dialects. Never
 * retryable — migrations are operator actions, not hot-path calls.
 */
export class PayweaveMigrationError extends PayweaveError {
  constructor(message: string, options: PayweaveErrorOptions = {}) {
    super(message, { isRetryable: false, ...options });
    this.name = "PayweaveMigrationError";
  }
}

/** Why a {@link PayweaveMigrationHistoryError} was raised. */
export type PwMigrationHistoryErrorReason = "checksum-mismatch" | "unknown-migration";

/**
 * Mutated-history detection (database.md §4 — "never re-run mutated
 * history"). Raised by BOTH `planMigrations` and `applyMigrations` when the
 * `pw_migrations` ledger disagrees with the migrations embedded in this
 * build:
 *
 * - `"checksum-mismatch"` — an applied migration's recorded checksum no
 *   longer matches the embedded content: someone edited an applied migration.
 * - `"unknown-migration"` — the ledger names a migration this build does not
 *   embed: the database was migrated by a different/newer build, or the
 *   ledger was edited by hand.
 *
 * The engine refuses to plan or apply ANYTHING once history is inconsistent;
 * there is no override flag by design.
 */
export class PayweaveMigrationHistoryError extends PayweaveMigrationError {
  /** The ledger `name` (= embedded migration `id`) that failed verification. */
  readonly migrationId: string;
  readonly reason: PwMigrationHistoryErrorReason;

  constructor(
    message: string,
    details: { migrationId: string; reason: PwMigrationHistoryErrorReason },
    options: PayweaveErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PayweaveMigrationHistoryError";
    this.migrationId = details.migrationId;
    this.reason = details.reason;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), migrationId: this.migrationId, reason: this.reason };
  }
}
