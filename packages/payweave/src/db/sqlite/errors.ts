/**
 * Error helpers for the sqlite adapter:
 * actionable install-hint errors when an optional peer driver is missing
 * (mirrors the other db-adapter stubs' message style: name the subpath, the missing
 * package, and an install command), and a thin wrapper turning raw driver
 * exceptions into {@link PayweaveError} subclasses (public SDK
 * methods only ever throw `PayweaveError` subclasses).
 */
import { PayweaveConfigError, PayweaveError, PayweaveValidationError } from "../../core/errors";
import type { SqliteDriverKind } from "./url";

const DRIVER_PACKAGE: Record<SqliteDriverKind, string> = {
  "better-sqlite3": "better-sqlite3",
  libsql: "@libsql/client",
};

/**
 * The optional peer driver required to open `url` is not installed. Named
 * per-URL (not a generic "install a sqlite driver" message) so the caller
 * knows exactly which of the two packages this specific URL needs —
 * two optional peer drivers behind one subpath.
 */
export function installHintError(driver: SqliteDriverKind, url: string, cause: unknown): PayweaveConfigError {
  const pkg = DRIVER_PACKAGE[driver];
  return new PayweaveConfigError(
    `payweave/db/sqlite: opening ${JSON.stringify(url)} requires the "${pkg}" package, which is ` +
      `not installed (it is an optional peerDependency of "payweave"). Run \`npm install ${pkg}\` ` +
      "(or your package manager's equivalent) and try again.",
    { cause },
  );
}

/** SQLite/libSQL error `.code` values that mean "a constraint was violated". */
function isConstraintViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

/**
 * Normalize a raw driver error into a {@link PayweaveError} subclass. Constraint
 * violations (e.g. the partial-unique active-subscription rule, `pw_customers
 * .external_id`) become {@link PayweaveValidationError} — the caller supplied
 * input that conflicts with existing state; anything else becomes a generic
 * {@link PayweaveError}, preserving the driver error as `cause` either way.
 */
export function wrapDriverError(error: unknown, message: string): PayweaveError {
  if (error instanceof PayweaveError) return error;
  if (isConstraintViolation(error)) {
    return new PayweaveValidationError(message, { cause: error });
  }
  return new PayweaveError(message, { cause: error, isRetryable: false });
}
