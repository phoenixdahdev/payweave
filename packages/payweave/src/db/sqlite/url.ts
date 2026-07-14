/**
 * Input routing for `sqliteAdapter(...)`.
 *
 * `sqliteAdapter` accepts EITHER `{ url }` (routed to the right driver by
 * scheme — two optional peer drivers behind one subpath) OR
 * an already-constructed driver instance — a `better-sqlite3` `Database` or an
 * `@libsql/client` `Client` — matching how the postgres/mysql adapters accept
 * a caller-owned `Pool`. Detection is structural (no driver import needed to
 * classify — core pulls no driver code).
 *
 * URL scheme routing:
 * - `:memory:`, `file:...`, or a bare filesystem path (no `scheme://`) →
 *   `better-sqlite3`.
 * - `libsql://`, `wss://`, `https://`, `http://` → `@libsql/client` (Turso /
 *   remote libSQL; `http(s)://` also covers a local `sqld` server).
 * - Any other `scheme://...` is rejected EAGERLY (synchronously, at
 *   `sqliteAdapter()` call time — adapters validate input
 *   eagerly and connect lazily).
 *
 * All validation here is pure and synchronous — no driver import, no I/O.
 */
import { PayweaveConfigError } from "../../core/errors";

/** Which optional peer driver a resolved SQLite target requires. */
export type SqliteDriverKind = "better-sqlite3" | "libsql";

/** The minimal shape of a `better-sqlite3` `Statement` this adapter relies on. */
export interface BetterSqlite3StatementLike {
  readonly reader: boolean;
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The minimal shape of a `better-sqlite3` `Database` this adapter relies on. */
export interface BetterSqlite3DatabaseLike {
  prepare(sql: string): BetterSqlite3StatementLike;
  pragma(source: string): unknown;
}

/** The minimal shape of an `@libsql/client` `Client` this adapter relies on. */
export interface LibsqlClientLike {
  execute(
    stmt: { sql: string; args: readonly unknown[] } | string,
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  batch?: unknown;
}

/** Where `sqliteAdapter` should connect, resolved eagerly from its input. */
export type SqliteConnectTarget =
  | { readonly kind: "url"; readonly driver: SqliteDriverKind; readonly url: string }
  | { readonly kind: "better-sqlite3-instance"; readonly database: BetterSqlite3DatabaseLike }
  | { readonly kind: "libsql-instance"; readonly client: LibsqlClientLike };

const LIBSQL_URL_SCHEMES = ["libsql://", "wss://", "https://", "http://"];

/**
 * Classify a `{ url }` string into the driver that must open it. Throws
 * {@link PayweaveConfigError} for any recognizable-but-unsupported
 * `scheme://` (e.g. `postgres://`) — the "garbage scheme rejected eagerly"
 * acceptance criterion.
 */
export function classifySqliteUrl(url: string): SqliteDriverKind {
  if (typeof url !== "string" || url.length === 0) {
    throw new PayweaveConfigError(
      "payweave/db/sqlite: sqliteAdapter({ url }) requires a non-empty string url — " +
        `got ${JSON.stringify(url)}.`,
    );
  }
  if (url === ":memory:" || url.startsWith("file:")) {
    return "better-sqlite3";
  }
  if (LIBSQL_URL_SCHEMES.some((scheme) => url.startsWith(scheme))) {
    return "libsql";
  }
  // Any other recognizable URI scheme (postgres://, mysql://, ftp://, ...) is
  // NOT a sqlite/libSQL URL — reject it eagerly rather than mis-routing it to
  // better-sqlite3 as a "bare path" that happens to contain a colon.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    throw new PayweaveConfigError(
      `payweave/db/sqlite: unsupported URL scheme in ${JSON.stringify(url)} — expected ` +
        '":memory:", "file:...", a bare filesystem path, or a libSQL/Turso URL ' +
        '("libsql://", "wss://", "https://", "http://").',
    );
  }
  // No recognized scheme and no "scheme://" pattern at all — treat as a bare
  // filesystem path (e.g. "./payweave.db", "/var/data/payweave.db").
  return "better-sqlite3";
}

function looksLikeBetterSqlite3(value: object): value is BetterSqlite3DatabaseLike {
  const candidate = value as Partial<BetterSqlite3DatabaseLike>;
  return typeof candidate.prepare === "function" && typeof candidate.pragma === "function";
}

function looksLikeLibsqlClient(value: object): value is LibsqlClientLike {
  const candidate = value as Partial<LibsqlClientLike> & { batch?: unknown };
  return typeof candidate.execute === "function" && typeof candidate.batch === "function";
}

/**
 * Resolve `sqliteAdapter`'s single argument into a {@link SqliteConnectTarget}.
 * Synchronous and side-effect-free — no driver import, no
 * connection opened.
 */
export function resolveSqliteInput(input: unknown): SqliteConnectTarget {
  if (input === null || typeof input !== "object") {
    throw new PayweaveConfigError(
      "payweave/db/sqlite: sqliteAdapter(...) expects { url } (a file:/:memory:/bare-path/" +
        "libSQL URL), a better-sqlite3 Database instance, or an @libsql/client Client instance — " +
        `got ${input === null ? "null" : typeof input}.`,
    );
  }
  if ("url" in input) {
    const url = (input as { url: unknown }).url;
    if (typeof url !== "string") {
      throw new PayweaveConfigError(
        `payweave/db/sqlite: sqliteAdapter({ url }) requires url to be a string — got ${typeof url}.`,
      );
    }
    return { kind: "url", driver: classifySqliteUrl(url), url };
  }
  if (looksLikeBetterSqlite3(input)) {
    return { kind: "better-sqlite3-instance", database: input };
  }
  if (looksLikeLibsqlClient(input)) {
    return { kind: "libsql-instance", client: input };
  }
  throw new PayweaveConfigError(
    "payweave/db/sqlite: sqliteAdapter(...) expects { url } (a file:/:memory:/bare-path/libSQL " +
      "URL), a better-sqlite3 Database instance (has .prepare()/.pragma()), or an @libsql/client " +
      "Client instance (has .execute()/.batch()) — got an object matching none of these shapes.",
  );
}
