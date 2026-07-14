/**
 * `payweave/db/sqlite` — SQLite / libSQL adapter (docs/v1/database.md §1/§4,
 * PW-706). Wraps EITHER `better-sqlite3` or `@libsql/client` behind one
 * `sqliteAdapter(...)` factory — both are OPTIONAL peerDependencies
 * : this module never imports either package at the top
 * level, only lazily inside `connect()` once a query actually runs, so
 * importing `payweave/db/sqlite` — let alone `payweave` core — never pulls
 * driver code into the graph unless a query is made.
 *
 * `sqliteAdapter(...)` accepts:
 * - `{ url }` — routed by scheme to the right driver (`./url.ts`):
 *   `:memory:` / `file:...` / a bare filesystem path → `better-sqlite3`;
 *   `libsql://` / `wss://` / `https://` / `http://` → `@libsql/client`.
 * - An already-constructed `better-sqlite3` `Database` instance.
 * - An already-constructed `@libsql/client` `Client` instance.
 *
 * Construction is synchronous and side-effect-free: the
 * input is validated (and the URL scheme classified) eagerly, but the driver
 * package is imported and the connection opened lazily, on the first store
 * call. An in-memory database is per-connection (better-sqlite3) or
 * per-client (`@libsql/client`) — this adapter holds exactly ONE connection
 * for the lifetime of the returned `DatabaseAdapter`, memoized on first use,
 * so `:memory:` data survives across calls (PW-706 brief).
 */
import { buildAdapter } from "./adapter";
import { BetterSqlite3Raw, openBetterSqlite3 } from "./drivers/better-sqlite3";
import { LibsqlRaw } from "./drivers/libsql";
import { installHintError } from "./errors";
import { AutoQueueRunner } from "./runner";
import {
  resolveSqliteInput,
  type BetterSqlite3DatabaseLike,
  type LibsqlClientLike,
  type SqliteConnectTarget,
} from "./url";
import type { DatabaseAdapter } from "../index";
import type { RawDriver } from "./runner";

export type { BetterSqlite3DatabaseLike, LibsqlClientLike, SqliteDriverKind } from "./url";

/** `sqliteAdapter(...)`'s single argument — see the module header for the three accepted shapes. */
export type SqliteAdapterInput = { url: string } | BetterSqlite3DatabaseLike | LibsqlClientLike;

async function openBetterSqlite3Driver(url: string): Promise<RawDriver> {
  // No explicit type annotation on `mod`: better-sqlite3 is a CJS `export =`
  // module, so its STATIC module type (`typeof import("better-sqlite3")`) is
  // the constructor itself, while a DYNAMIC `import()` expression is typed by
  // TS as Node's ESM interop namespace (`{ default: Constructor, ...named }`)
  // — annotating `mod` with the former and assigning the latter is a real
  // type mismatch (`tsc` catches it), so this relies on inference from the
  // dynamic import expression itself.
  let mod;
  try {
    mod = await import("better-sqlite3");
  } catch (cause) {
    throw installHintError("better-sqlite3", url, cause);
  }
  const database = openBetterSqlite3(mod.default, url);
  return new BetterSqlite3Raw(database);
}

async function openLibsqlDriver(url: string): Promise<RawDriver> {
  let mod: typeof import("@libsql/client");
  try {
    mod = await import("@libsql/client");
  } catch (cause) {
    throw installHintError("libsql", url, cause);
  }
  const client = mod.createClient({ url });
  return new LibsqlRaw(client as unknown as LibsqlClientLike);
}

function connect(target: SqliteConnectTarget): Promise<RawDriver> {
  switch (target.kind) {
    case "better-sqlite3-instance":
      return Promise.resolve(new BetterSqlite3Raw(target.database));
    case "libsql-instance":
      return Promise.resolve(new LibsqlRaw(target.client));
    case "url":
      return target.driver === "better-sqlite3"
        ? openBetterSqlite3Driver(target.url)
        : openLibsqlDriver(target.url);
  }
}

/**
 * Create a SQLite/libSQL-backed {@link DatabaseAdapter}. See the module
 * header for the accepted input shapes and the eager-validate/lazy-connect
 * contract.
 *
 * @throws {PayweaveConfigError} synchronously for an unrecognized input shape
 *   or an unsupported URL scheme; asynchronously (on first query) if the
 *   required optional peer driver (`better-sqlite3` or `@libsql/client`) is
 *   not installed.
 */
export function sqliteAdapter(input: SqliteAdapterInput): DatabaseAdapter {
  const target = resolveSqliteInput(input);
  let driverPromise: Promise<RawDriver> | undefined;
  const getDriver = (): Promise<RawDriver> => {
    driverPromise ??= connect(target);
    return driverPromise;
  };
  const runner = new AutoQueueRunner(getDriver);
  return buildAdapter(runner);
}
