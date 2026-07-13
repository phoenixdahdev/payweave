/**
 * Error helpers for the postgres adapter (docs/v1/database.md §7, PW-704):
 * an actionable install-hint error when the optional peer driver (`pg`) is
 * missing (mirrors the sqlite/drizzle adapters' message style: name the
 * subpath, the missing package, and an install command), and a thin wrapper
 * turning raw `pg` errors into {@link PayweaveError} subclasses (AGENTS.md §2:
 * public SDK methods only ever throw `PayweaveError` subclasses).
 */
import { PayweaveConfigError, PayweaveError, PayweaveValidationError } from "../../core/errors";

/**
 * The optional peer driver (`pg`) required by `payweave/db/postgres` is not
 * installed.
 */
export function installHintError(cause: unknown): PayweaveConfigError {
  return new PayweaveConfigError(
    'payweave/db/postgres: this adapter requires the "pg" package, which is not installed (it is ' +
      'an optional peerDependency of "payweave"). Run `npm install pg` (or your package manager\'s ' +
      "equivalent) and try again.",
    { cause },
  );
}

/** Postgres error `.code` values (SQLSTATE) that mean "a constraint was violated". */
const CONSTRAINT_VIOLATION_CODES = new Set([
  "23505", // unique_violation — incl. the partial-unique active-subscription index
  "23P01", // exclusion_violation
  "23503", // foreign_key_violation
  "23514", // check_violation
]);

function pgErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function isConstraintViolation(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code !== undefined && CONSTRAINT_VIOLATION_CODES.has(code);
}

/**
 * Normalize a raw `pg` driver error into a {@link PayweaveError} subclass.
 * Constraint violations (e.g. the partial-unique active-subscription rule,
 * `pw_customers.external_id`) become {@link PayweaveValidationError} — the
 * caller supplied input that conflicts with existing state; anything else
 * becomes a generic {@link PayweaveError}, preserving the driver error as
 * `cause` either way.
 */
export function wrapDriverError(error: unknown, message: string): PayweaveError {
  if (error instanceof PayweaveError) return error;
  if (isConstraintViolation(error)) {
    return new PayweaveValidationError(message, { cause: error });
  }
  return new PayweaveError(message, { cause: error, isRetryable: false });
}
