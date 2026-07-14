/**
 * The driver-agnostic SQL migrations engine (docs/v1/database.md §4, PW-703).
 * SQL adapters (PW-704/705/706) expose it as `DatabaseAdapter.migrations`:
 *
 * ```ts
 * migrations: {
 *   status: () => planMigrations(executor, "postgres"),
 *   apply:  () => applyMigrations(executor, "postgres"),
 * }
 * ```
 *
 * Mechanics:
 * - Embedded + ordered: migrations are string constants compiled into the
 *   build (`./definitions`) — no filesystem reads, no drivers, ever.
 * - Checksum ledger: every applied migration is recorded in `pw_migrations`
 *   (`name` = migration id, `applied_at`, `checksum`). The ledger table is
 *   created with `CREATE TABLE IF NOT EXISTS` before every read, so both
 *   `planMigrations` and `applyMigrations` work on a fresh database (a plan
 *   against an empty database therefore performs that one idempotent DDL
 *   write).
 * - Forward-only: no down migrations exist in v1, and none are scaffolded.
 * - Mutated history FAILS LOUDLY: ledger↔embedded verification runs on BOTH
 *   plan and apply — see {@link PayweaveMigrationHistoryError}.
 *
 * CHECKSUM SCHEME (stable by contract — changing it would invalidate every
 * ledger in the wild): `"sha256:" + hex(SHA-256(stmt₀ ‖ NUL ‖ stmt₁ ‖ NUL ‖ …))`
 * over the exact UTF-8 bytes of each statement, each terminated by a NUL
 * separator (so `["ab"]` and `["a","b"]` hash differently). NO normalization
 * of any kind — a whitespace or comment edit IS a content change by design.
 */
import { createHash } from "node:crypto";
import { PayweaveMigrationError, PayweaveMigrationHistoryError } from "./errors";
import { migrationsFor } from "./definitions";
import { ledgerEnsureSql, ledgerInsertParams, ledgerInsertSql, ledgerSelectSql } from "./ledger";
import type { MigrationExecutor, PwSqlDialect, PwSqlMigration } from "./types";

/**
 * Stable content hash of a migration's statements (`sha256:<64 hex>`); the
 * value recorded in — and verified against — the `pw_migrations.checksum`
 * column. See the module header for the exact scheme.
 */
export function migrationChecksum(migration: Pick<PwSqlMigration, "statements">): string {
  const hash = createHash("sha256");
  for (const statement of migration.statements) {
    hash.update(statement, "utf8");
    hash.update("\u0000", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Validate + order a migration set: ids unique, statements non-empty, and
 * execution order id-lexicographic (codepoint order — locale-independent)
 * regardless of input order.
 */
function normalizeMigrationSet(migrations: readonly PwSqlMigration[]): readonly PwSqlMigration[] {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) {
      throw new PayweaveMigrationError(
        `Malformed embedded migration set: duplicate migration id "${m.id}".`,
      );
    }
    seen.add(m.id);
    if (m.statements.length === 0 || m.statements.some((s) => s.trim() === "")) {
      throw new PayweaveMigrationError(
        `Malformed embedded migration set: migration "${m.id}" has an empty statement list or a blank statement.`,
      );
    }
  }
  // Ids are unique (checked above), so the comparator never sees equals.
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Bootstrap the ledger if absent, read it, and verify it against the embedded
 * set. Returns the set of applied migration ids. Throws
 * {@link PayweaveMigrationHistoryError} on any ledger↔embedded inconsistency
 * — the loud-failure gate shared by plan and apply.
 */
async function readVerifiedLedger(
  executor: MigrationExecutor,
  dialect: PwSqlDialect,
  migrations: readonly PwSqlMigration[],
): Promise<ReadonlySet<string>> {
  await executor.query(ledgerEnsureSql(dialect));
  const { rows } = await executor.query(ledgerSelectSql(dialect));

  const byId = new Map(migrations.map((m) => [m.id, m]));
  const applied = new Set<string>();
  for (const row of rows) {
    const name = row["name"];
    const checksum = row["checksum"];
    if (typeof name !== "string" || typeof checksum !== "string") {
      throw new PayweaveMigrationError(
        `The pw_migrations ledger returned a malformed row (expected string "name" and "checksum" columns) — got ${JSON.stringify(row)}.`,
      );
    }
    const embedded = byId.get(name);
    if (embedded === undefined) {
      throw new PayweaveMigrationHistoryError(
        `Payweave migration history mismatch: the pw_migrations ledger contains "${name}", ` +
          `which is not among the migrations embedded in this build. Refusing to plan or apply ` +
          `against an unknown migration history — this usually means the database was migrated ` +
          `by a newer Payweave version, or the ledger was edited by hand (docs/v1/database.md §4).`,
        { migrationId: name, reason: "unknown-migration" },
      );
    }
    const expected = migrationChecksum(embedded);
    if (checksum !== expected) {
      throw new PayweaveMigrationHistoryError(
        `Payweave migration "${name}" was modified after it was applied: ledger checksum ` +
          `${checksum} does not match this build's checksum ${expected}. Applied migrations are ` +
          `immutable — NEVER edit an applied migration; ship the change as a new migration ` +
          `instead (forward-only, docs/v1/database.md §4).`,
        { migrationId: name, reason: "checksum-mismatch" },
      );
    }
    applied.add(name);
  }
  return applied;
}

/**
 * Compute the migration plan without applying anything — the engine behind
 * `DatabaseAdapter.migrations.status()`. Verifies history first and throws
 * {@link PayweaveMigrationHistoryError} on mutation, exactly like apply.
 * Ledger rows for migrations the build doesn't know are NEVER silently
 * ignored; ledger gaps (an unapplied migration ordered before an applied one)
 * are reported as pending and applied in embedded order.
 *
 * @param executor Adapter-supplied executor; see {@link MigrationExecutor}.
 * @param dialect  SQL dialect whose embedded migration set to plan against.
 * @param migrations Override of the embedded set — for tests/tooling only;
 *   adapters MUST omit it (defaults to `migrationsFor(dialect)`).
 */
export async function planMigrations(
  executor: MigrationExecutor,
  dialect: PwSqlDialect,
  migrations: readonly PwSqlMigration[] = migrationsFor(dialect),
): Promise<{ pending: string[]; applied: string[] }> {
  const ordered = normalizeMigrationSet(migrations);
  const appliedSet = await readVerifiedLedger(executor, dialect, ordered);
  return {
    pending: ordered.filter((m) => !appliedSet.has(m.id)).map((m) => m.id),
    applied: ordered.filter((m) => appliedSet.has(m.id)).map((m) => m.id),
  };
}

/**
 * Apply every pending migration, in order, forward-only — the engine behind
 * `DatabaseAdapter.migrations.apply()`. Re-running with nothing pending is a
 * no-op (`{ applied: [] }`).
 *
 * Per migration: each statement runs as its own `executor.query()` call, then
 * one ledger row is inserted (`name`, `applied_at` = now, `checksum`). When
 * the executor provides `transaction`, statements + ledger insert run inside
 * ONE transaction per migration, so a failure rolls that migration back
 * whole; without it, execution stops at the failing statement and the error
 * surfaces (already-completed migrations stay recorded either way). Failures
 * are wrapped in {@link PayweaveMigrationError} naming the migration and
 * statement, with the driver error as `cause`.
 *
 * @param executor Adapter-supplied executor; see {@link MigrationExecutor}.
 * @param dialect  SQL dialect whose embedded migration set to apply.
 * @param migrations Override of the embedded set — for tests/tooling only;
 *   adapters MUST omit it (defaults to `migrationsFor(dialect)`).
 */
export async function applyMigrations(
  executor: MigrationExecutor,
  dialect: PwSqlDialect,
  migrations: readonly PwSqlMigration[] = migrationsFor(dialect),
): Promise<{ applied: string[] }> {
  const ordered = normalizeMigrationSet(migrations);
  const appliedSet = await readVerifiedLedger(executor, dialect, ordered);
  const pending = ordered.filter((m) => !appliedSet.has(m.id));

  const applied: string[] = [];
  for (const migration of pending) {
    const runOne = async (tx: MigrationExecutor): Promise<void> => {
      for (const [index, statement] of migration.statements.entries()) {
        try {
          await tx.query(statement);
        } catch (cause) {
          throw new PayweaveMigrationError(
            `Payweave migration "${migration.id}" failed at statement ${index + 1} of ${migration.statements.length}.`,
            { cause },
          );
        }
      }
      try {
        await tx.query(
          ledgerInsertSql(dialect),
          ledgerInsertParams(dialect, migration.id, migrationChecksum(migration), new Date()),
        );
      } catch (cause) {
        throw new PayweaveMigrationError(
          `Payweave migration "${migration.id}" executed, but recording it in the pw_migrations ledger failed.`,
          { cause },
        );
      }
    };

    if (executor.transaction) {
      await executor.transaction(runOne);
    } else {
      await runOne(executor);
    }
    applied.push(migration.id);
  }
  return { applied };
}
