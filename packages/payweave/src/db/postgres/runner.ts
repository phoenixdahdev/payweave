/**
 * Concurrency backbone for the postgres adapter.
 *
 * Unlike the sqlite adapter (one serialized connection) or the drizzle
 * Postgres adapter (a `db.transaction()` + `SELECT ... FOR UPDATE` per
 * `balances.consume` call), the direct `pg` adapter's hot paths
 * (`balances.consume`, `webhookEvents.claim`) are each a SINGLE SQL statement
 * sent over the pool's normal connection-per-query model — no dedicated
 * connection or transaction wrapper is needed for those two calls at all
 * (`./sql.ts`'s query text does its own row-locking internally via a
 * `FOR UPDATE` CTE, entirely inside that one round trip). `Runner.transaction`
 * exists for the handful of calls that genuinely need a read-then-conditional
 * -write spanning more than one statement — `plans.pushVersion` (content-hash
 * no-op gate) and `customers.linkProviderRef` (JSON merge) — mirroring the
 * sqlite/drizzle adapters' pattern for those same two operations, and for the
 * public `DatabaseAdapter.transaction(fn)` contract method itself.
 *
 * `PoolRunner` wraps the caller's pool directly for non-transactional calls
 * (each `query()` borrows whatever connection the pool hands out — safe
 * because pg pools are inherently safe for concurrent unrelated queries).
 * `transaction()` checks out ONE dedicated `PoolClient` via `pool.connect()`,
 * runs `BEGIN`/`COMMIT`/`ROLLBACK` around it, and always `release()`s it back
 * to the pool. `ClientRunner` is bound to that already-open transaction: its
 * `query()` runs directly on the held client, and its OWN `transaction()` is a
 * reentrant passthrough (`fn(this)`, no nested `BEGIN`/`SAVEPOINT`) — the same
 * reentrancy pattern the sqlite adapter's `TransactionRunner` uses, so a
 * caller's `db.transaction(tx => tx.plans.pushVersion(...))` composes
 * correctly without ever attempting a nested transaction.
 */
import type { PgPoolClientLike, PgPoolLike, PgQueryResultLike } from "./url";

/** The uniform surface adapter code is written against. */
export interface Runner {
  query(text: string, params?: readonly unknown[]): Promise<PgQueryResultLike>;
  /**
   * Run `fn` as one atomic unit on a dedicated connection. Outermost callers
   * get a real `BEGIN`/`COMMIT`/`ROLLBACK`; a `Runner` already inside a
   * transaction (a `ClientRunner`) treats this as a reentrant passthrough.
   */
  transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T>;
}

/** The adapter's entry point over a caller-owned or lazily-constructed `pg` Pool. */
export class PoolRunner implements Runner {
  readonly #pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.#pool = pool;
  }

  query(text: string, params: readonly unknown[] = []): Promise<PgQueryResultLike> {
    return this.#pool.query(text, params);
  }

  async transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const txRunner = new ClientRunner(client);
      try {
        const result = await fn(txRunner);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }
}

/** Bound to an already-open transaction on one dedicated `pg` `PoolClient`. */
export class ClientRunner implements Runner {
  readonly #client: PgPoolClientLike;

  constructor(client: PgPoolClientLike) {
    this.#client = client;
  }

  query(text: string, params: readonly unknown[] = []): Promise<PgQueryResultLike> {
    return this.#client.query(text, params);
  }

  // Reentrant: already inside one atomic unit, so nested `transaction()`
  // calls (e.g. a user's `db.transaction(tx => tx.plans.pushVersion(...))`)
  // just run inline rather than attempting a nested BEGIN.
  transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
