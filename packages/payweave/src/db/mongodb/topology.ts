/**
 * Replica-set vs standalone transaction handling. Standalone MongoDB
 * servers do not support multi-document
 * transactions ("Transaction numbers are only allowed on a replica set
 * member or mongos") — rather than pre-probing topology with an extra
 * `hello`/`isMaster` round trip (fragile across deployment shapes: replica
 * set, sharded cluster, Atlas serverless, …), {@link runTransaction} ATTEMPTS
 * a real transaction and falls back to the documented non-atomic path ONLY on
 * the specific error MongoDB raises when transactions are unsupported —
 * letting the server itself be the authority instead of guessing.
 *
 * This is safe because the very FIRST operation issued inside a session's
 * transaction on a standalone server fails immediately with that error,
 * before anything is written (transactions never partially start on
 * standalone) — so re-running the callback a second time, fully, without a
 * session, is equivalent to never having attempted a transaction at all. No
 * double-write risk from the failed attempt.
 *
 * This fallback is safe for Payweave's purposes because
 * the two contract paths with a hard atomicity requirement —
 * `balances.consume` and `webhookEvents.claim` — are EACH already atomic
 * per-document via a single pipeline `findOneAndUpdate` regardless of
 * topology (`./period-pipeline.ts`, `./adapter.ts`); `transaction()` only
 * adds cross-document rollback on top of that, which the stale-claim timeout
 * substitutes for on standalone — never a permanently-unclaimable event.
 *
 * CAVEAT inherited from MongoDB's own `withTransaction` helper (not specific
 * to this adapter): the driver may invoke the callback MULTIPLE TIMES on
 * transient transaction errors (`TransientTransactionError`/
 * `UnknownTransactionCommitResult` labels) — MongoDB's own documented
 * requirement is that the callback's operations be safe to repeat. Every
 * `DatabaseAdapter` store this adapter exposes is either a single atomic
 * pipeline operation (safe to repeat) or itself idempotent by construction
 * (`plans.pushVersion`'s content-hash no-op, `balances.resetTo`'s replace),
 * so this holds without extra bookkeeping.
 */
import type { MongoConnectedClientLike, MongoSessionLike } from "./types";

export type { MongoSessionLike } from "./types";
/** Alias kept for call-site clarity — `runTransaction` only needs `.startSession()`. */
export type MongoClientForTransactions = Pick<MongoConnectedClientLike, "startSession">;

const UNSUPPORTED_MESSAGE_PATTERN =
  /transaction numbers are only allowed on a replica set member or mongos|this mongodb deployment does not support transactions|transactions are not supported|standalone/i;

/**
 * `true` when `error` is the specific MongoDB error raised for attempting a
 * multi-document transaction against a deployment that does not support one
 * (standalone `mongod`). Matches on the documented error code (20 —
 * `IllegalOperation`) combined with "transaction" in the message, OR a set of
 * known message substrings, defensively (the exact wording is a real `mongod`
 * implementation detail this sandbox cannot execute against — see the module
 * header).
 */
export function isTransactionsUnsupportedError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as { message?: unknown; code?: unknown };
  const message = typeof record.message === "string" ? record.message : "";
  if (message.length === 0) return false;
  if (record.code === 20 && /transaction/i.test(message)) return true;
  return /transaction/i.test(message) && UNSUPPORTED_MESSAGE_PATTERN.test(message);
}

/**
 * Run `fn` inside a real multi-document transaction when the deployment
 * supports one; otherwise run it once, plainly, with no session (the
 * documented standalone fallback — see the module header). `fn` receives the
 * active {@link MongoSessionLike} (to thread into every operation so writes
 * commit/roll back together) or `undefined` in the fallback path.
 */
export async function runTransaction<T>(
  client: MongoClientForTransactions,
  fn: (session: MongoSessionLike | undefined) => Promise<T>,
): Promise<T> {
  const session = client.startSession();
  try {
    let result: T;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      // `withTransaction` only resolves after `fn` ran to completion at least
      // once without throwing — `result` is always assigned by then.
      return result!;
    } catch (error) {
      if (isTransactionsUnsupportedError(error)) {
        return await fn(undefined);
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
}
