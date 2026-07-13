/**
 * Concurrency backbone for the sqlite adapter (docs/v1/database.md §5, PW-706).
 *
 * WHY THIS EXISTS (spec-silent engineering decision — see the module-level
 * comment on `consume` in `./adapter` for the full reasoning): `balances.consume`
 * must recompute the CURRENT billing window from the row's OWN stored `anchor`/
 * `resetInterval` (`init` is a creation template only — ignored once a row
 * exists, database.md §3), using the EXACT same clamp-once calendar arithmetic
 * as `src/products/period.ts` (the conformance suite's oracle). Replicating
 * that arithmetic as portable raw SQL (safe across both better-sqlite3 and
 * `@libsql/client`, neither of which exposes a way to call back into JS from
 * inside a statement for a remote/http libSQL connection) risks silent drift
 * from the oracle. Instead this adapter reads the current row, computes the
 * decision in JS via `period.ts` directly, and writes the result back — made
 * SAFE under concurrency by fully serializing every operation through the
 * adapter's single connection (below), exactly matching database.md §5's
 * framing for sqlite: "rely on serialized writes." The PW-706 brief itself
 * says as much: "An in-memory SQLite database is PER CONNECTION — the adapter
 * must hold exactly one connection... serialization makes it correct, but
 * only through one connection."
 *
 * `AutoQueueRunner` is that one connection's gatekeeper: every top-level call
 * (`execute` or `transaction`) is queued onto a single FIFO chain, so at most
 * one SQL "unit of work" — whether a bare statement or a whole
 * BEGIN…COMMIT/ROLLBACK block — is ever in flight. `transaction()` hands its
 * callback a `TransactionRunner` bound to the SAME physical connection: its
 * `execute()` runs directly (the queue slot is already held) and its own
 * `transaction()` is a reentrant passthrough (`fn(this)`, no nested BEGIN) —
 * this is what lets `balances.consume`/`plans.pushVersion` internally open
 * their own read-then-write transaction AND compose correctly when called
 * from inside the public `DatabaseAdapter.transaction(fn)` (which itself goes
 * through `AutoQueueRunner.transaction`), without ever double-BEGINning the
 * one connection SQLite disallows nesting on.
 *
 * Object identity (which `Runner` a call holds), not a shared mutable depth
 * counter, is what makes this reentrancy-safe: an UNRELATED concurrent call
 * always goes through `AutoQueueRunner` and therefore always queues behind
 * whatever transaction is currently running — it can never "see" someone
 * else's open transaction and mistakenly skip the queue.
 */

/** One row batch from a single SQL statement execution. */
export interface RawResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** The driver-specific execution primitive each backend implements. */
export interface RawDriver {
  exec(sql: string, params: readonly unknown[]): Promise<RawResult>;
}

/** The uniform surface adapter code is written against. */
export interface Runner {
  execute(sql: string, params?: readonly unknown[]): Promise<RawResult>;
  /**
   * Run `fn` as one atomic unit. Outermost callers get a real
   * BEGIN IMMEDIATE…COMMIT/ROLLBACK; a `Runner` already inside a transaction
   * (a `TransactionRunner`) treats this as a reentrant passthrough.
   */
  transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T>;
}

/**
 * The adapter's single connection gatekeeper. `getDriver` is invoked lazily
 * (memoized by the caller, e.g. `sqliteAdapter`'s connect-on-first-use) so
 * constructing this class never opens a connection itself.
 */
export class AutoQueueRunner implements Runner {
  #queue: Promise<void> = Promise.resolve();
  readonly #getDriver: () => Promise<RawDriver>;

  constructor(getDriver: () => Promise<RawDriver>) {
    this.#getDriver = getDriver;
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn);
    // The queue chain itself must never reject, or every later-enqueued
    // operation would wedge behind one failure forever.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  execute(sql: string, params: readonly unknown[] = []): Promise<RawResult> {
    return this.#enqueue(async () => {
      const driver = await this.#getDriver();
      return driver.exec(sql, params);
    });
  }

  transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      const driver = await this.#getDriver();
      await driver.exec("BEGIN IMMEDIATE", []);
      const txRunner = new TransactionRunner(driver);
      try {
        const result = await fn(txRunner);
        await driver.exec("COMMIT", []);
        return result;
      } catch (error) {
        await driver.exec("ROLLBACK", []).catch(() => undefined);
        throw error;
      }
    });
  }
}

/** Bound to an already-open transaction on the adapter's one connection. */
export class TransactionRunner implements Runner {
  readonly #driver: RawDriver;

  constructor(driver: RawDriver) {
    this.#driver = driver;
  }

  execute(sql: string, params: readonly unknown[] = []): Promise<RawResult> {
    return this.#driver.exec(sql, params);
  }

  // Reentrant: already inside one atomic unit, so nested `transaction()`
  // calls (e.g. a user's `db.transaction(tx => tx.balances.consume(...))`)
  // just run inline rather than attempting a nested BEGIN.
  transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
