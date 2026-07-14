/**
 * `payweave/db/postgres` — PostgreSQL adapter. Wraps `pg` (`node-postgres`)
 * behind the shared {@link DatabaseAdapter} contract.
 *
 * `postgresAdapter(...)` accepts EITHER:
 * - `{ connectionString }` — a `postgres://`/`postgresql://` URL, validated
 *   EAGERLY (synchronously, at call time); the `pg.Pool` itself is
 *   constructed LAZILY, on the first store method call, via a dynamic
 *   `import("pg")` — so importing this subpath (or `payweave` core) never
 *   pulls `pg` into the module graph unless a query actually runs
 * - An existing `pg` `Pool` instance (accepted structurally — no `pg` import
 *   needed to recognize it) — used directly, and never closed by this
 *   adapter (the caller owns its lifecycle, matching how the sqlite/drizzle
 *   adapters treat a caller-supplied driver instance).
 *
 * Construction is synchronous and side-effect-free: the
 * input is validated (and, for a connection string, its scheme classified)
 * eagerly, but no socket opens and no query runs until the first store call.
 *
 * `balances.consume` and `webhookEvents.claim` are each ONE SQL statement
 * relying on pg's own row locking (`./sql.ts`) — this is the adapter's
 * headline requirement: NOT a
 * read-then-write from the application, unlike the sqlite/drizzle adapters'
 * transaction-based approach to the same operations (see `./sql.ts`'s and
 * `./period-sql.ts`'s doc comments for why postgres can do this atomically in
 * one round trip and the others don't).
 */
import { installHintError } from "./errors";
import { PoolRunner, type Runner } from "./runner";
import { resolvePostgresInput, type PgPoolLike, type PostgresConnectTarget } from "./url";
import { buildAdapter } from "./adapter";
import type { DatabaseAdapter } from "../index";

export type { PgPoolClientLike, PgPoolLike, PgQueryResultLike } from "./url";

/** `postgresAdapter(...)`'s single argument — see the module header. */
export type PostgresAdapterInput = { connectionString: string } | PgPoolLike;

async function openPool(connectionString: string): Promise<PgPoolLike> {
  // No explicit type annotation on `mod`: relying on inference from the
  // dynamic import expression itself (mirrors `src/db/sqlite/index.ts`'s
  // identical `better-sqlite3` comment) — `pg`'s default export is the `Pool`
  // constructor's home under Node ESM interop.
  let mod;
  try {
    mod = await import("pg");
  } catch (cause) {
    throw installHintError(cause);
  }
  const Pool = (mod.default ?? mod).Pool;
  return new Pool({ connectionString }) as PgPoolLike;
}

function connect(target: PostgresConnectTarget): Promise<PgPoolLike> {
  return target.kind === "pool-instance" ? Promise.resolve(target.pool) : openPool(target.connectionString);
}

/**
 * Create a PostgreSQL-backed {@link DatabaseAdapter}. See the module header
 * for the accepted input shapes and the eager-validate/lazy-connect contract.
 *
 * @throws {PayweaveConfigError} synchronously for a non-`postgres://`/
 *   `postgresql://` connection string, or an unrecognized input shape;
 *   asynchronously (on first query) if the required optional peer driver
 *   (`pg`) is not installed.
 */
export function postgresAdapter(input: PostgresAdapterInput): DatabaseAdapter {
  const target = resolvePostgresInput(input);
  let poolPromise: Promise<PgPoolLike> | undefined;
  const getPool = (): Promise<PgPoolLike> => {
    poolPromise ??= connect(target);
    return poolPromise;
  };

  // A thin `Runner` that resolves the lazily-constructed pool on every call —
  // `PoolRunner` itself is built once the pool is available. Store methods
  // never see the pool-vs-not-yet-connected distinction.
  const runner: Runner = {
    query: async (text, params = []) => {
      const pool = await getPool();
      return pool.query(text, params);
    },
    transaction: async (fn) => {
      const pool = await getPool();
      return new PoolRunner(pool).transaction(fn);
    },
  };

  return buildAdapter(runner);
}
