/**
 * Error helpers for the Drizzle adapter (docs/v1/database.md §4/§7, PW-708):
 * a thin wrapper turning raw driver/drizzle exceptions into
 * {@link PayweaveError} subclasses (AGENTS.md §2: public SDK methods only
 * ever throw `PayweaveError` subclasses).
 *
 * NOTE on the "dynamic import + install-hint" pattern the other first-party
 * adapters use (PW-505/PW-706 style) for their optional peer driver: it does
 * NOT apply cleanly here, and this is a deliberate, documented deviation —
 * see `../index.ts`'s module header for the full reasoning. In short:
 * dialect detection (`../detect.ts`) MUST use `instanceof` against
 * `drizzle-orm`'s own dialect base classes for correctness, which requires
 * those classes to be the SAME loaded instances the caller's own `db` was
 * built from — a lazy `import()` executed later is safe for that (Node
 * caches modules), but making `drizzleAdapter(db)` itself `async` to await
 * one would break the factory contract every other adapter shares (sync,
 * side-effect-free construction — database.md §1), and a synchronous
 * `require()` escape hatch risks loading a SEPARATE module instance than the
 * caller's `import`, silently breaking `instanceof`. `drizzle-orm` is also
 * this subpath's ONE unavoidable optional peer (unlike sqlite's two
 * alternative drivers) — every dialect file here imports it statically, so
 * a missing `drizzle-orm` fails at `import "payweave/db/drizzle"` time with
 * Node's own clear `Cannot find package 'drizzle-orm'` error, not a
 * downstream cryptic one.
 */
import { PayweaveError, PayweaveValidationError } from "../../core/errors";

/** Driver error `.code`/`.cause.code` values that mean "a constraint was violated". */
function constraintCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const nested = cause?.code;
  return typeof nested === "string" ? nested : undefined;
}

/** postgres/mysql/sqlite constraint-violation error codes across the three raw drivers. */
function isConstraintViolation(error: unknown): boolean {
  const code = constraintCode(error);
  if (code === undefined) return false;
  return (
    code.startsWith("SQLITE_CONSTRAINT") || // better-sqlite3 / @libsql/client
    code === "23505" || // postgres unique_violation
    code === "23P01" || // postgres exclusion_violation
    code === "ER_DUP_ENTRY" // mysql2
  );
}

/**
 * Normalize a raw driver/drizzle error into a {@link PayweaveError} subclass.
 * Constraint violations (e.g. the partial-unique active-subscription rule,
 * `pw_customers.external_id`) become {@link PayweaveValidationError} — the
 * caller supplied input that conflicts with existing state; anything else
 * becomes a generic {@link PayweaveError}, preserving the original error as
 * `cause` either way. Drizzle wraps driver errors in its own
 * `DrizzleQueryError` (`.cause` holds the raw driver error), so both the
 * direct and nested `.code` are checked.
 */
export function wrapDriverError(error: unknown, message: string): PayweaveError {
  if (error instanceof PayweaveError) return error;
  if (isConstraintViolation(error)) {
    return new PayweaveValidationError(message, { cause: error });
  }
  return new PayweaveError(message, { cause: error, isRetryable: false });
}
