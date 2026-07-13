/**
 * Error helpers for the MongoDB adapter (docs/v1/database.md §7, PW-709):
 * an actionable install-hint error when the optional `mongodb` peer driver
 * is missing (mirrors `src/db/sqlite/errors.ts`'s message style: name the
 * subpath, the missing package, and an install command), and a thin wrapper
 * turning raw driver exceptions into {@link PayweaveError} subclasses
 * (AGENTS.md §2: public SDK methods only ever throw `PayweaveError`
 * subclasses).
 */
import { PayweaveConfigError, PayweaveError, PayweaveValidationError } from "../../core/errors";

/**
 * The optional peer driver `mongodb` is not installed (or failed to import
 * for some other reason — the underlying error survives as `cause`).
 */
export function installHintError(cause: unknown): PayweaveConfigError {
  return new PayweaveConfigError(
    'payweave/db/mongodb: connecting requires the "mongodb" package, which is not installed ' +
      '(it is an optional peerDependency of "payweave"). Run `npm install mongodb` (or your ' +
      "package manager's equivalent) and try again.",
    { cause },
  );
}

/** MongoDB's duplicate-key error code (E11000 — a unique/partial-unique index rejected the write). */
const DUPLICATE_KEY_CODE = 11000;

/**
 * `true` when `error` is a MongoDB duplicate-key error (E11000). Exported
 * (not just used internally by {@link wrapDriverError}) so callers that need
 * to DECIDE whether to retry (e.g. `plans.pushVersion`'s append-only race,
 * `./adapter.ts`) can distinguish "retry-worthy contention" from "give up and
 * wrap" without duplicating this check.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === DUPLICATE_KEY_CODE;
}

/**
 * Normalize a raw driver error into a {@link PayweaveError} subclass.
 * Duplicate-key errors (e.g. the partial-unique active-subscription index,
 * `pw_customers.externalId`, `pw_plans` (`planId`, `version`),
 * `pw_feature_balances` (`customerId`, `featureId`, `group`)) become
 * {@link PayweaveValidationError} — the caller supplied input that conflicts
 * with existing state; anything else becomes a generic {@link PayweaveError},
 * preserving the driver error as `cause` either way.
 */
export function wrapDriverError(error: unknown, message: string): PayweaveError {
  if (error instanceof PayweaveError) return error;
  if (isDuplicateKeyError(error)) {
    return new PayweaveValidationError(message, { cause: error });
  }
  return new PayweaveError(message, { cause: error, isRetryable: false });
}
