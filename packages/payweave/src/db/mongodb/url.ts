/**
 * Input resolution for `mongodbAdapter(...)` (docs/v1/database.md §1/§4,
 * PW-709).
 *
 * Accepts EITHER `{ url, dbName }` — an eagerly-validated `mongodb://` /
 * `mongodb+srv://` connection string, driver imported and connected lazily —
 * OR `{ client, dbName }` wrapping an already-constructed `MongoClient` (the
 * caller owns its lifecycle; this adapter never calls `.close()` on a
 * caller-supplied client). `dbName` is REQUIRED in both shapes: a MongoDB
 * connection string MAY name a default database in its path segment, but a
 * bare `MongoClient` handed to us carries no such default we could safely
 * assume, so both branches share the same explicit-`dbName` contract
 * (database.md §1's own example always passes one).
 *
 * `client` is validated STRUCTURALLY (`MongoClientLike` below) rather than
 * via `instanceof` against the real `mongodb` package — mirrors
 * `src/db/sqlite/url.ts`'s `BetterSqlite3DatabaseLike`/`LibsqlClientLike`
 * precedent: this keeps the adapter's PUBLIC type surface resolvable for a
 * consumer who has not (yet) installed the optional `mongodb` peer, and
 * means classifying an input needs no driver import at all (database.md §7:
 * adapters only import their driver lazily, inside their own subpath).
 *
 * Construction is synchronous and side-effect-free (database.md §1): the
 * shape/scheme is validated eagerly here; the driver package is imported and
 * the connection opened lazily, on first store call (`./index.ts`).
 *
 * SECURITY (AGENTS.md §2 rule 5 / database.md §7/§8): the raw connection
 * string is NEVER interpolated into a thrown error's message here — only a
 * generic description of the expected shape. `src/core/redact.ts` also scrubs
 * `mongodb://`/`mongodb+srv://` credentials from logger events and error
 * `toJSON()` as defense in depth, but "never put it in an error message in
 * the first place" is the stronger guarantee and costs nothing to uphold.
 */
import { PayweaveConfigError } from "../../core/errors";

const URL_SCHEMES = ["mongodb://", "mongodb+srv://"];

/**
 * Minimal structural shape of a `mongodb` `MongoClient` this adapter relies
 * on — enough to validate + drive it without importing the real driver.
 */
export interface MongoClientLike {
  connect(): Promise<unknown>;
  close(force?: boolean): Promise<void>;
  db(name?: string): unknown;
  startSession(options?: unknown): unknown;
}

/** Where `mongodbAdapter` should connect, resolved eagerly from its input. */
export type MongoConnectTarget =
  | { readonly kind: "url"; readonly url: string; readonly dbName: string }
  | { readonly kind: "client"; readonly client: MongoClientLike; readonly dbName: string };

function looksLikeMongoClient(value: object): value is MongoClientLike {
  const candidate = value as Partial<MongoClientLike>;
  return (
    typeof candidate.connect === "function" &&
    typeof candidate.close === "function" &&
    typeof candidate.db === "function" &&
    typeof candidate.startSession === "function"
  );
}

/**
 * Eagerly validate a `{ url }` string's scheme — `mongodb://` or
 * `mongodb+srv://` only (database.md §1). Never echoes `url` back in the
 * thrown message (see the module header's SECURITY note).
 */
export function validateMongoUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new PayweaveConfigError(
      "payweave/db/mongodb: mongodbAdapter({ url, dbName }) requires a non-empty string url.",
    );
  }
  if (!URL_SCHEMES.some((scheme) => url.startsWith(scheme))) {
    throw new PayweaveConfigError(
      'payweave/db/mongodb: mongodbAdapter({ url, ... }) requires a "mongodb://" or ' +
        '"mongodb+srv://" connection string.',
    );
  }
}

function validateDbName(dbName: unknown): asserts dbName is string {
  if (typeof dbName !== "string" || dbName.length === 0) {
    throw new PayweaveConfigError(
      "payweave/db/mongodb: mongodbAdapter(...) requires a non-empty `dbName` — a MongoDB " +
        "connection string may name a default database in its path, but this adapter always " +
        "requires `dbName` explicitly, for both { url } and { client } (database.md §1).",
    );
  }
}

/**
 * Resolve `mongodbAdapter`'s single argument into a {@link MongoConnectTarget}.
 * Synchronous and side-effect-free — no driver import, no connection opened.
 */
export function resolveMongoInput(input: unknown): MongoConnectTarget {
  if (input === null || typeof input !== "object") {
    throw new PayweaveConfigError(
      "payweave/db/mongodb: mongodbAdapter(...) expects { url, dbName } (a mongodb://" +
        "/mongodb+srv:// connection string) or { client, dbName } (an existing MongoClient) — " +
        `got ${input === null ? "null" : typeof input}.`,
    );
  }
  const record = input as Record<string, unknown>;

  if ("url" in record) {
    validateMongoUrl(record.url);
    validateDbName(record.dbName);
    return { kind: "url", url: record.url, dbName: record.dbName };
  }

  if ("client" in record) {
    const client = record.client;
    if (client === null || typeof client !== "object" || !looksLikeMongoClient(client)) {
      throw new PayweaveConfigError(
        "payweave/db/mongodb: mongodbAdapter({ client, dbName }) expects `client` to be a " +
          "MongoClient-like instance (has .connect()/.close()/.db()/.startSession()) — got " +
          `${client === null ? "null" : typeof client === "object" ? "an object missing one of those methods" : typeof client}.`,
      );
    }
    validateDbName(record.dbName);
    return { kind: "client", client, dbName: record.dbName };
  }

  throw new PayweaveConfigError(
    "payweave/db/mongodb: mongodbAdapter(...) expects { url, dbName } (a mongodb://" +
      "/mongodb+srv:// connection string) or { client, dbName } (an existing MongoClient) — " +
      "got an object matching neither shape.",
  );
}
