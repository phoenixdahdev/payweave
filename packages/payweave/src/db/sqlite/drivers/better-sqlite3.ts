/**
 * `better-sqlite3` backend for the sqlite adapter (docs/v1/database.md §4,
 * PW-706). This module is the ONLY place that touches a `better-sqlite3`
 * `Database` instance; `../index.ts` dynamically imports the driver package
 * and passes the resulting instance in here, so core/`payweave` never pulls
 * `better-sqlite3` into its module graph (database.md §7).
 *
 * `better-sqlite3` executes synchronously — `exec` wraps it in an `async`
 * function so it satisfies the {@link RawDriver} surface, but never `await`s
 * mid-statement, so a synchronous driver throw always rejects the returned
 * promise rather than escaping an `await`-shaped call site.
 */
import type { RawDriver, RawResult } from "../runner";
import type { BetterSqlite3DatabaseLike } from "../url";

export class BetterSqlite3Raw implements RawDriver {
  readonly #db: BetterSqlite3DatabaseLike;

  constructor(db: BetterSqlite3DatabaseLike) {
    this.#db = db;
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<RawResult> {
    // Synchronous end-to-end (better-sqlite3); the `async` keyword only makes
    // the return value a promise, matching the uniform Runner/RawDriver
    // contract shared with the libSQL backend.
    const statement = this.#db.prepare(sql);
    if (statement.reader) {
      return { rows: statement.all(...params) as ReadonlyArray<Record<string, unknown>> };
    }
    statement.run(...params);
    return { rows: [] };
  }
}

/**
 * Convert a `file:` URL (database.md §1 example: `"file:./payweave.db"`) into
 * the plain filesystem path `better-sqlite3`'s constructor expects — it does
 * NOT parse `file:` URIs itself (verified empirically: passing the URI
 * literally is treated as a filename containing a colon and fails to open).
 * Handles the no-authority form (`file:./x`, `file:/abs/x`, the documented
 * example) and the double/triple-slash authority forms
 * (`file://./x`, `file:///abs/x`) by stripping one authority-marking `//`;
 * query strings / SQLite URI parameters are out of scope for v1 — pass an
 * already-open `Database` instance for anything fancier.
 */
export function sqliteFileUrlToPath(url: string): string {
  const withoutScheme = url.slice("file:".length);
  return withoutScheme.startsWith("//") ? withoutScheme.slice(2) : withoutScheme;
}

/**
 * Open (or reuse) a `better-sqlite3` `Database` for `url` (`:memory:`,
 * `file:...`, or a bare filesystem path — routing already resolved by
 * `../url.ts`). File-backed databases get WAL + a `busy_timeout` (PW-706
 * brief: cross-PROCESS contention on a shared file needs the engine's own
 * wait/retry, since this adapter's `AutoQueueRunner` only serializes writers
 * within THIS process). `:memory:` skips both — a private in-memory database
 * has no other process to contend with, and WAL is meaningless for it.
 */
export function openBetterSqlite3(
  DatabaseCtor: new (filename: string) => BetterSqlite3DatabaseLike,
  url: string,
): BetterSqlite3DatabaseLike {
  const path = url === ":memory:" ? ":memory:" : url.startsWith("file:") ? sqliteFileUrlToPath(url) : url;
  const db = new DatabaseCtor(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
  }
  return db;
}
