/**
 * `payweave/db/mongodb` — MongoDB adapter (docs/v1/database.md §1/§4, PW-709).
 * FIRST-PARTY v1: MongoDB is not a bolted-on community adapter, it ships with
 * Payweave (epic-07-database.md's PW-709 owner-priority note).
 *
 * `mongodbAdapter(...)` accepts EITHER:
 * - `{ url, dbName }` — a `mongodb://`/`mongodb+srv://` connection string,
 *   validated eagerly (`./url.ts`); `mongodb` is imported and the connection
 *   opened LAZILY, on the first store call.
 * - `{ client, dbName }` — an already-constructed `MongoClient` you own; this
 *   adapter never calls `.close()` on it.
 *
 * `mongodb` is an OPTIONAL peerDependency (database.md §7) — this module
 * NEVER imports it at the top level, only dynamically inside `connect()`
 * (mirrors `src/db/sqlite/index.ts`'s `openBetterSqlite3Driver`/
 * `openLibsqlDriver` pattern), and `mongodbAdapter`'s public parameter/return
 * types are STRUCTURAL (`./url.ts`'s `MongoClientLike`, `./types.ts`'s
 * `MongoDbLike`/`MongoCollectionLike`) rather than the real driver's classes
 * — so importing `payweave/db/mongodb` (or `payweave` core, which never
 * references this subpath at all) never requires `mongodb` to be installed
 * OR its types to be resolvable, exactly mirroring the sqlite adapter's
 * `BetterSqlite3DatabaseLike`/`LibsqlClientLike` precedent (database.md §7).
 * The ONE place this module bridges to the real driver is `connect()` below,
 * via an explicit, localized cast — never structural inference across the
 * whole codebase.
 *
 * Construction is synchronous and side-effect-free (database.md §1): input
 * is validated eagerly; the driver import + connection happen lazily and are
 * memoized (a `:memory:`-style "hold exactly one connection" invariant isn't
 * needed here — MongoDB is never in-process — but memoizing avoids opening a
 * new connection per call, mirroring sqlite's own memoized `driverPromise`).
 */
import { buildAdapter, type MongoAdapterDeps } from "./adapter";
import { installHintError } from "./errors";
import { resolveMongoInput, type MongoClientLike } from "./url";
import type { MongoConnectedClientLike } from "./types";
import type { DatabaseAdapter } from "../index";

export type { MongoClientLike } from "./url";

/** `mongodbAdapter(...)`'s single argument — see the module header. */
export type MongodbAdapterInput =
  | { url: string; dbName: string }
  | { client: MongoClientLike; dbName: string };

type ConnectedMongo = MongoAdapterDeps;

async function connect(target: ReturnType<typeof resolveMongoInput>): Promise<ConnectedMongo> {
  if (target.kind === "client") {
    // `MongoClient.connect()` is documented as safe to call even on an
    // already-connected client (idempotent) — this adapter never assumes the
    // caller connected it first. The cast below is the ONE place a
    // caller-supplied (structurally-validated only) client is bridged into
    // the internal `MongoConnectedClientLike` shape `./adapter.ts`/
    // `./topology.ts` rely on — see the module header.
    const client = target.client as unknown as MongoConnectedClientLike;
    await target.client.connect();
    return { client, db: client.db(target.dbName) };
  }

  let mod: typeof import("mongodb");
  try {
    mod = await import("mongodb");
  } catch (cause) {
    throw installHintError(cause);
  }
  const rawClient = new mod.MongoClient(target.url);
  await rawClient.connect();
  const client = rawClient as unknown as MongoConnectedClientLike;
  return { client, db: client.db(target.dbName) };
}

/**
 * Wrap {@link buildAdapter} behind lazy, memoized connect-on-first-use
 * (database.md §1). Every `DatabaseAdapter` method awaits the SAME
 * connection/adapter-build promise, so `mongodb`'s driver connects exactly
 * once regardless of how many store methods are called.
 */
function buildLazyAdapter(getConnection: () => Promise<ConnectedMongo>): DatabaseAdapter {
  let builtPromise: Promise<DatabaseAdapter> | undefined;
  const getReal = (): Promise<DatabaseAdapter> => {
    builtPromise ??= getConnection().then(
      ({ client, db }): DatabaseAdapter => buildAdapter({ client, db } satisfies MongoAdapterDeps),
    );
    return builtPromise;
  };

  return {
    dialect: "mongodb",
    customers: {
      getByExternalId: async (externalId) => (await getReal()).customers.getByExternalId(externalId),
      upsert: async (input) => (await getReal()).customers.upsert(input),
      linkProviderRef: async (externalId, provider, ref) =>
        (await getReal()).customers.linkProviderRef(externalId, provider, ref),
    },
    plans: {
      getActiveVersion: async (planId) => (await getReal()).plans.getActiveVersion(planId),
      listActive: async () => (await getReal()).plans.listActive(),
      pushVersion: async (plan) => (await getReal()).plans.pushVersion(plan),
    },
    subscriptions: {
      getActive: async (customerId, group) => (await getReal()).subscriptions.getActive(customerId, group),
      create: async (input) => (await getReal()).subscriptions.create(input),
      update: async (id, patch) => (await getReal()).subscriptions.update(id, patch),
    },
    balances: {
      get: async (customerId, featureId, group) =>
        (await getReal()).balances.get(customerId, featureId, group),
      consume: async (input) => (await getReal()).balances.consume(input),
      resetTo: async (customerId, featureId, group, init) =>
        (await getReal()).balances.resetTo(customerId, featureId, group, init),
    },
    webhookEvents: {
      claim: async (dedupeKey, meta) => (await getReal()).webhookEvents.claim(dedupeKey, meta),
      markApplied: async (dedupeKey) => (await getReal()).webhookEvents.markApplied(dedupeKey),
    },
    migrations: {
      status: async () => (await getReal()).migrations.status(),
      apply: async () => (await getReal()).migrations.apply(),
    },
    transaction: async (fn) => (await getReal()).transaction(fn),
  };
}

/**
 * Create a MongoDB-backed {@link DatabaseAdapter}. See the module header for
 * the accepted input shapes and the eager-validate/lazy-connect contract.
 *
 * @throws {PayweaveConfigError} synchronously for an unrecognized input shape
 *   or connection-string scheme; asynchronously (on first query) if the
 *   `mongodb` package is not installed.
 */
export function mongodbAdapter(input: MongodbAdapterInput): DatabaseAdapter {
  const target = resolveMongoInput(input);
  let connectPromise: Promise<ConnectedMongo> | undefined;
  const getConnection = (): Promise<ConnectedMongo> => {
    connectPromise ??= connect(target);
    return connectPromise;
  };
  return buildLazyAdapter(getConnection);
}
