/**
 * Input resolution for `postgresAdapter(...)` (docs/v1/database.md §1/§4,
 * PW-704).
 *
 * `postgresAdapter` accepts EITHER `{ connectionString }` (validated EAGERLY —
 * database.md §1: "postgresAdapter rejects a non-`postgres://`/`postgresql://`
 * connection string") — the `pg.Pool` itself is constructed LAZILY, on first
 * query, so a bad connection string never opens a socket just to fail — OR an
 * already-constructed `pg` `Pool` (or `Client`) instance, detected
 * structurally (no driver import needed to classify — core pulls no driver
 * code, database.md §7), matching how the sqlite/drizzle adapters accept a
 * caller-owned instance.
 *
 * All validation here is pure and synchronous — no driver import, no I/O.
 */
import { PayweaveConfigError } from "../../core/errors";

const VALID_SCHEMES = ["postgres://", "postgresql://"];

/** The minimal `pg` query result shape this adapter relies on. */
export interface PgQueryResultLike {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** The minimal shape of a `pg` `PoolClient` (a single, dedicated connection). */
export interface PgPoolClientLike {
  query(text: string, params?: readonly unknown[]): Promise<PgQueryResultLike>;
  release(err?: unknown): void;
}

/**
 * The minimal shape of a `pg` `Pool` this adapter relies on. Structural (not
 * `import("pg").Pool`) so classifying a caller-supplied instance never
 * requires importing the driver (database.md §7).
 */
export interface PgPoolLike {
  query(text: string, params?: readonly unknown[]): Promise<PgQueryResultLike>;
  connect(): Promise<PgPoolClientLike>;
}

/** Where `postgresAdapter` should connect, resolved eagerly from its input. */
export type PostgresConnectTarget =
  | { readonly kind: "connectionString"; readonly connectionString: string }
  | { readonly kind: "pool-instance"; readonly pool: PgPoolLike };

/**
 * Validate a `{ connectionString }` value eagerly (database.md §1). Throws
 * {@link PayweaveConfigError} for anything other than a `postgres://` or
 * `postgresql://` URL — a garbage/foreign scheme (e.g. `mysql://`) is
 * rejected synchronously, before any connection is attempted.
 */
export function assertPostgresConnectionString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PayweaveConfigError(
      "payweave/db/postgres: postgresAdapter({ connectionString }) requires a non-empty string — " +
        `got ${JSON.stringify(value)}.`,
    );
  }
  if (!VALID_SCHEMES.some((scheme) => value.startsWith(scheme))) {
    throw new PayweaveConfigError(
      `payweave/db/postgres: connectionString must start with "postgres://" or "postgresql://" — ` +
        "got an unsupported scheme. Never log or include the full string in an error message (it " +
        "may carry credentials); check the beginning of your DATABASE_URL.",
    );
  }
  return value;
}

function looksLikePgPool(value: object): value is PgPoolLike {
  const candidate = value as Partial<PgPoolLike>;
  return typeof candidate.query === "function" && typeof candidate.connect === "function";
}

/**
 * Resolve `postgresAdapter`'s single argument into a
 * {@link PostgresConnectTarget}. Synchronous and side-effect-free
 * (database.md §1) — no driver import, no connection opened, no query run.
 */
export function resolvePostgresInput(input: unknown): PostgresConnectTarget {
  if (input === null || typeof input !== "object") {
    throw new PayweaveConfigError(
      "payweave/db/postgres: postgresAdapter(...) expects { connectionString } (a postgres://" +
        "/postgresql:// URL) or an existing `pg` Pool instance — got " +
        `${input === null ? "null" : typeof input}.`,
    );
  }
  if ("connectionString" in input) {
    const connectionString = assertPostgresConnectionString(
      (input as { connectionString: unknown }).connectionString,
    );
    return { kind: "connectionString", connectionString };
  }
  if (looksLikePgPool(input)) {
    return { kind: "pool-instance", pool: input };
  }
  throw new PayweaveConfigError(
    "payweave/db/postgres: postgresAdapter(...) expects { connectionString } (a postgres://" +
      "/postgresql:// URL) or an existing `pg` Pool instance (has .query()/.connect()) — got an " +
      "object matching neither shape.",
  );
}
