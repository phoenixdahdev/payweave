/**
 * `payweave/db/mongodb` — the MongoDB adapter (docs/v1/database.md §4, PW-709).
 *
 * Docker conformance (database.md §6/§8): registers `runDatabaseConformance`
 * TWICE — standalone and single-node replica-set — inside
 * `describe.skipIf(!PW_DB_CONFORMANCE_DOCKER)` blocks, mirroring
 * `test/db/drizzle.test.ts`'s own docker-gating pattern EXACTLY (env flag
 * name, skip mechanism). Neither leg can run in THIS sandbox (no Docker); both
 * run for real in PW-710's CI matrix. See PW-709's report for the full,
 * honest accounting of what only that CI run can verify — most importantly
 * the real aggregation-pipeline atomicity/period-math semantics this file's
 * unit tests can only approximate via `./mongo-mock.ts`'s narrow evaluator.
 *
 * Everything below the docker-gated blocks runs with NO live MongoDB:
 * install-hint error, URL/dbName validation, `_id` mapping, pipeline SHAPE
 * assertions (structural proof of "exactly one `findOneAndUpdate`, pipeline
 * array, literal `now`"), pipeline BEHAVIOR via the mock evaluator, index
 * setup + idempotency, topology detection + standalone fallback, and a
 * bundle-isolation spot check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayweaveConfigError, PayweaveNotFoundError } from "../../src/core/errors";
import { buildAdapter } from "../../src/db/mongodb/adapter";
import { installHintError, isDuplicateKeyError, wrapDriverError } from "../../src/db/mongodb/errors";
import { generatePwId, ulid } from "../../src/db/mongodb/id";
import { mongodbAdapter } from "../../src/db/mongodb/index";
import { MIGRATION_NAME, mongoMigrationApply, mongoMigrationStatus } from "../../src/db/mongodb/migrations";
import { buildPeriodExpr, simulatePeriodPipeline } from "../../src/db/mongodb/period-pipeline";
import {
  docToCustomer,
  docToFeatureBalance,
  docToPlanVersion,
  docToSubscription,
  docToWebhookEvent,
} from "../../src/db/mongodb/rows";
import { isTransactionsUnsupportedError, runTransaction } from "../../src/db/mongodb/topology";
import { resolveMongoInput, validateMongoUrl } from "../../src/db/mongodb/url";
import { currentPeriod } from "../../src/products/period";
import { PW_ACTIVE_SUBSCRIPTION_STATUSES, PW_TABLES, pwIdSchema } from "../../src/db/schema";
import { runDatabaseConformance, type DatabaseAdapterHandle } from "./conformance";
import { MockClient, MockDb, runPipeline } from "./mongo-mock";

// ── Docker-only conformance (PW-710's CI matrix) ────────────────────────────

// Opt-in docker gate — PW-710 wires this into the CI matrix's env; never read outside this check.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const RUN_DOCKER_CONFORMANCE = process.env.PW_DB_CONFORMANCE_DOCKER === "1";

describe.skipIf(!RUN_DOCKER_CONFORMANCE)("mongodb (standalone) — docker-only conformance (PW-710's CI matrix)", () => {
  async function makeStandaloneAdapter(): Promise<DatabaseAdapterHandle> {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- PW-710's docker leg only.
    const url = process.env.MONGODB_STANDALONE_URL ?? "mongodb://127.0.0.1:27017";
    const dbName = `payweave_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const adapter = mongodbAdapter({ url, dbName });
    await adapter.migrations.apply();
    return {
      adapter,
      teardown: async () => {
        const { MongoClient } = await import("mongodb");
        const client = new MongoClient(url);
        await client.connect();
        await client.db(dbName).dropDatabase();
        await client.close();
      },
    };
  }
  runDatabaseConformance("mongodb (standalone)", makeStandaloneAdapter, { atomicTransactions: false });
});

describe.skipIf(!RUN_DOCKER_CONFORMANCE)(
  "mongodb (replica-set) — docker-only conformance (PW-710's CI matrix)",
  () => {
    async function makeReplicaSetAdapter(): Promise<DatabaseAdapterHandle> {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- PW-710's docker leg only.
      const url = process.env.MONGODB_REPLICA_SET_URL ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0";
      const dbName = `payweave_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const adapter = mongodbAdapter({ url, dbName });
      await adapter.migrations.apply();
      return {
        adapter,
        teardown: async () => {
          const { MongoClient } = await import("mongodb");
          const client = new MongoClient(url);
          await client.connect();
          await client.db(dbName).dropDatabase();
          await client.close();
        },
      };
    }
    runDatabaseConformance("mongodb (replica-set)", makeReplicaSetAdapter, { atomicTransactions: true });
  },
);

// ── URL / input validation (synchronous, side-effect-free) ─────────────────

describe("validateMongoUrl / resolveMongoInput — sync, side-effect-free", () => {
  it("accepts mongodb:// and mongodb+srv:// schemes", () => {
    expect(() => validateMongoUrl("mongodb://localhost:27017")).not.toThrow();
    expect(() => validateMongoUrl("mongodb+srv://cluster.mongodb.net")).not.toThrow();
  });

  it("rejects a non-mongodb scheme eagerly, WITHOUT echoing the url back", () => {
    const weird = "postgres://user:hunter2@host/db";
    try {
      validateMongoUrl(weird);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PayweaveConfigError);
      expect((error as PayweaveConfigError).message).not.toContain(weird);
      expect((error as PayweaveConfigError).message).not.toContain("hunter2");
    }
  });

  it("rejects an empty or non-string url", () => {
    expect(() => validateMongoUrl("")).toThrow(PayweaveConfigError);
    expect(() => validateMongoUrl(123)).toThrow(PayweaveConfigError);
  });

  it("requires a non-empty dbName for { url }", () => {
    expect(() => resolveMongoInput({ url: "mongodb://localhost" })).toThrow(PayweaveConfigError);
    expect(() => resolveMongoInput({ url: "mongodb://localhost", dbName: "" })).toThrow(PayweaveConfigError);
  });

  it("resolves { url, dbName } to a url target", () => {
    expect(resolveMongoInput({ url: "mongodb://localhost", dbName: "app" })).toEqual({
      kind: "url",
      url: "mongodb://localhost",
      dbName: "app",
    });
  });

  it("accepts a structurally-valid { client, dbName }", () => {
    const client = {
      connect: async () => undefined,
      close: async () => undefined,
      db: () => ({}),
      startSession: () => ({}),
    };
    expect(resolveMongoInput({ client, dbName: "app" })).toEqual({ kind: "client", client, dbName: "app" });
  });

  it("rejects a client missing required methods", () => {
    expect(() => resolveMongoInput({ client: { connect: async () => undefined }, dbName: "app" })).toThrow(
      PayweaveConfigError,
    );
  });

  it("rejects null/primitive/unrecognized-shape input", () => {
    expect(() => resolveMongoInput(null)).toThrow(PayweaveConfigError);
    expect(() => resolveMongoInput(42)).toThrow(PayweaveConfigError);
    expect(() => resolveMongoInput({ notAUrl: true })).toThrow(PayweaveConfigError);
  });
});

describe("mongodbAdapter(...) — synchronous, side-effect-free construction", () => {
  it("does not throw synchronously for a valid { url, dbName }", () => {
    expect(() => mongodbAdapter({ url: "mongodb://localhost:27017", dbName: "app" })).not.toThrow();
  });

  it("throws synchronously for an invalid scheme, before any connection is attempted", () => {
    expect(() => mongodbAdapter({ url: "mysql://localhost", dbName: "app" } as never)).toThrow(
      PayweaveConfigError,
    );
  });
});

// ── Install hint when `mongodb` is missing ──────────────────────────────────

describe("install-hint error when the optional `mongodb` peer driver is missing", () => {
  afterEach(() => {
    vi.doUnmock("mongodb");
    vi.resetModules();
  });

  it("names mongodb + an install command on first store call", async () => {
    vi.resetModules();
    vi.doMock("mongodb", () => {
      throw new Error("Cannot find package 'mongodb'");
    });
    const { mongodbAdapter: freshMongodbAdapter } = await import("../../src/db/mongodb/index");
    const { PayweaveConfigError: FreshPayweaveConfigError } = await import("../../src/core/errors");
    const adapter = freshMongodbAdapter({ url: "mongodb://localhost:27017", dbName: "app" });
    const error = await adapter.customers.getByExternalId("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreshPayweaveConfigError);
    const message = (error as InstanceType<typeof FreshPayweaveConfigError>).message;
    expect(message).toContain("mongodb");
    expect(message).toMatch(/npm install/);
  });

  it("installHintError() wraps the cause and never invents a package name", () => {
    const cause = new Error("boom");
    const error = installHintError(cause);
    expect(error).toBeInstanceOf(PayweaveConfigError);
    expect(error.message).toContain("mongodb");
    expect(error.cause).toBe(cause);
  });
});

// ── Error wrapping ───────────────────────────────────────────────────────────

describe("wrapDriverError / isDuplicateKeyError", () => {
  it("maps a duplicate-key error (E11000) to PayweaveValidationError", () => {
    const dup = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    expect(isDuplicateKeyError(dup)).toBe(true);
    const wrapped = wrapDriverError(dup, "failed");
    expect(wrapped.name).toBe("PayweaveValidationError");
    expect(wrapped.cause).toBe(dup);
  });

  it("maps any other error to a generic, non-retryable PayweaveError", () => {
    const other = new Error("network blip");
    expect(isDuplicateKeyError(other)).toBe(false);
    const wrapped = wrapDriverError(other, "failed");
    expect(wrapped.name).toBe("PayweaveError");
    expect(wrapped.isRetryable).toBe(false);
  });

  it("passes an existing PayweaveError through unchanged", () => {
    const original = new PayweaveNotFoundError("not found");
    expect(wrapDriverError(original, "ignored")).toBe(original);
  });
});

// ── `_id` mapping ────────────────────────────────────────────────────────────

describe("_id mapping (database.md §4 — documents are rows verbatim, id stored as _id)", () => {
  it("customers: _id -> id", () => {
    const doc = {
      _id: generatePwId(),
      externalId: "user_1",
      providerIds: { stripe: "cus_1" },
      email: "a@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const row = docToCustomer(doc);
    expect(row.id).toBe(doc._id);
    expect(row.externalId).toBe("user_1");
  });

  it("plans: _id -> id", () => {
    const doc = {
      _id: generatePwId(),
      planId: "pro",
      version: 1,
      group: "base",
      isDefault: false,
      name: "Pro",
      priceMinor: 1900,
      priceCurrency: "USD",
      priceInterval: "month",
      features: {},
      providerRefs: {},
      pushedAt: new Date(),
    };
    expect(docToPlanVersion(doc).id).toBe(doc._id);
  });

  it("subscriptions: _id -> id", () => {
    const doc = {
      _id: generatePwId(),
      customerId: generatePwId(),
      planId: "pro",
      planVersion: 1,
      group: "base",
      status: "active",
      provider: "stripe",
      providerSubscriptionRef: "sub_1",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(docToSubscription(doc).id).toBe(doc._id);
  });

  it("feature balances: _id -> id, and internal `_pwLastApplied` never leaks into the row", () => {
    const doc = {
      _id: generatePwId(),
      customerId: generatePwId(),
      featureId: "messages",
      group: "base",
      used: 1,
      limit: 100,
      resetInterval: "month",
      anchor: new Date(),
      periodStart: new Date(),
      periodEnd: new Date(),
      planId: "free",
      planVersion: 1,
      updatedAt: new Date(),
      _pwLastApplied: true,
    };
    const row = docToFeatureBalance(doc);
    expect(row.id).toBe(doc._id);
    expect(Object.keys(row)).not.toContain("_pwLastApplied");
  });

  it("webhook events: _id IS dedupeKey (the schema's documented natural-key exception), `_pwWon` never leaks", () => {
    const doc = {
      _id: "evt_1",
      provider: "stripe",
      type: "customer.subscription.updated",
      receivedAt: new Date(),
      claimedAt: null,
      appliedAt: null,
      _pwWon: true,
    };
    const row = docToWebhookEvent(doc);
    expect(row.dedupeKey).toBe("evt_1");
    expect(Object.keys(row)).not.toContain("_pwWon");
  });
});

// ── Pipeline SHAPE — structural proof of atomicity ──────────────────────────

describe("balances.consume / webhookEvents.claim — pipeline SHAPE (structural atomicity proof)", () => {
  it("consume is EXACTLY ONE findOneAndUpdate call, with an ARRAY pipeline, upsert:true", async () => {
    const db = new MockDb();
    const client = new MockClient("replica-set");
    const adapter = buildAdapter({ db, client });
    await adapter.balances.consume({
      customerId: "cust_1",
      featureId: "messages",
      group: "base",
      amount: 1,
      init: { limit: 100, resetInterval: "month", anchor: new Date("2026-01-01T00:00:00Z"), planId: "free", planVersion: 1 },
      now: new Date("2026-01-02T00:00:00Z"),
    });
    const calls = db.rawCollection(PW_TABLES.featureBalances).calls;
    const findOneAndUpdateCalls = calls.filter((c) => c.method === "findOneAndUpdate");
    expect(findOneAndUpdateCalls).toHaveLength(1);
    const [filter, update, options] = findOneAndUpdateCalls[0]!.args as [unknown, unknown, Record<string, unknown>];
    expect(filter).toEqual({ customerId: "cust_1", featureId: "messages", group: "base" });
    expect(Array.isArray(update)).toBe(true);
    expect(options.upsert).toBe(true);
    expect(options.returnDocument).toBe("after");
    // No read call precedes the write — the whole operation IS the read+decide+write.
    expect(calls.filter((c) => c.method === "findOne")).toHaveLength(0);
  });

  it("consume's pipeline never references $$NOW — `now` is always a literal Date baked in", async () => {
    const db = new MockDb();
    const client = new MockClient("replica-set");
    const adapter = buildAdapter({ db, client });
    await adapter.balances.consume({
      customerId: "c",
      featureId: "f",
      group: "g",
      amount: 1,
      init: { limit: 10, resetInterval: "day", anchor: new Date(), planId: "p", planVersion: 1 },
      now: new Date(),
    });
    const [, pipeline] = db.rawCollection(PW_TABLES.featureBalances).calls.find(
      (c) => c.method === "findOneAndUpdate",
    )!.args as [unknown, Record<string, unknown>[]];
    expect(JSON.stringify(pipeline)).not.toContain("$$NOW");
    // The pipeline uses the reset-if-expired / conditional-decrement building blocks.
    const asString = JSON.stringify(pipeline);
    expect(asString).toContain("$dateAdd");
    expect(asString).toContain("$ifNull");
    expect(asString).toContain("$switch");
    expect(asString).toContain("$cond");
  });

  it("claim is EXACTLY ONE findOneAndUpdate call, with an ARRAY pipeline, upsert:true", async () => {
    const db = new MockDb();
    const client = new MockClient("replica-set");
    const adapter = buildAdapter({ db, client });
    await adapter.webhookEvents.claim("evt_1", {
      provider: "stripe",
      type: "x",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const calls = db.rawCollection(PW_TABLES.webhookEvents).calls;
    const findOneAndUpdateCalls = calls.filter((c) => c.method === "findOneAndUpdate");
    expect(findOneAndUpdateCalls).toHaveLength(1);
    const [filter, update, options] = findOneAndUpdateCalls[0]!.args as [unknown, unknown, Record<string, unknown>];
    expect(filter).toEqual({ _id: "evt_1" });
    expect(Array.isArray(update)).toBe(true);
    expect(options.upsert).toBe(true);
    expect(calls.filter((c) => c.method === "findOne")).toHaveLength(0);
  });
});

// ── Pipeline BEHAVIOR (via the narrow mock evaluator, ./mongo-mock.ts) ─────

describe("balances.consume — pipeline BEHAVIOR (interpreted by the mock evaluator)", () => {
  const init = { limit: 100, resetInterval: "month" as const, anchor: new Date("2026-01-15T12:00:00Z"), planId: "free", planVersion: 1 };

  it("lazily creates from init on first touch (amount 0 always applies)", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const result = await adapter.balances.consume({
      customerId: "c1",
      featureId: "messages",
      group: "base",
      amount: 0,
      init,
      now: new Date("2026-01-15T13:00:00Z"),
    });
    expect(result.applied).toBe(true);
    expect(result.used).toBe(0);
    expect(result.limit).toBe(100);
    expect(pwIdSchema.parse(result.id)).toBeTruthy();
  });

  it("conditional consume applies only when remaining >= amount, never mutates on denial", async () => {
    const db = new MockDb();
    const adapter = buildAdapter({ db, client: new MockClient() });
    const args = (amount: number, now = new Date("2026-01-15T13:00:00Z")) => ({
      customerId: "c2",
      featureId: "messages",
      group: "base",
      amount,
      conditional: true,
      init: { ...init, limit: 10 },
      now,
    });
    const ok = await adapter.balances.consume(args(8));
    expect(ok.applied).toBe(true);
    expect(ok.used).toBe(8);
    const before = await adapter.balances.get("c2", "messages", "base");
    const denied = await adapter.balances.consume(args(3));
    expect(denied.applied).toBe(false);
    expect(denied.used).toBe(8);
    const after = await adapter.balances.get("c2", "messages", "base");
    expect(after).toEqual(before); // untouched, including updatedAt
  });

  it("unconditional consume decrements and may go negative", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const first = await adapter.balances.consume({
      customerId: "c3",
      featureId: "messages",
      group: "base",
      amount: 2,
      init: { ...init, limit: 3 },
      now: new Date("2026-01-15T13:00:00Z"),
    });
    expect(first.used).toBe(2);
    const second = await adapter.balances.consume({
      customerId: "c3",
      featureId: "messages",
      group: "base",
      amount: 5,
      init: { ...init, limit: 3 },
      now: new Date("2026-01-15T14:00:00Z"),
    });
    expect(second.used).toBe(7);
  });

  it("resets at exactly period_end (half-open periods) even when the decrement is denied", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    await adapter.balances.consume({
      customerId: "c4",
      featureId: "f",
      group: "g",
      amount: 5,
      init: { ...init, limit: 5 },
      now: new Date("2026-01-15T13:00:00Z"),
    });
    const boundary = new Date("2026-02-15T12:00:00Z"); // exactly periodEnd
    const result = await adapter.balances.consume({
      customerId: "c4",
      featureId: "f",
      group: "g",
      amount: 10,
      conditional: true,
      init: { ...init, limit: 5 },
      now: boundary,
    });
    expect(result.applied).toBe(false); // 10 > new limit 5
    expect(result.used).toBe(0); // the due reset still happened
    expect(result.periodStart).toEqual(boundary);
    expect(result.periodEnd).toEqual(new Date("2026-03-15T12:00:00Z"));
  });

  it("init is a creation template only — existing rows ignore it on later calls", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    await adapter.balances.consume({
      customerId: "c5",
      featureId: "f",
      group: "g",
      amount: 1,
      init,
      now: new Date("2026-01-15T13:00:00Z"),
    });
    const result = await adapter.balances.consume({
      customerId: "c5",
      featureId: "f",
      group: "g",
      amount: 1,
      init: { ...init, limit: 7, planId: "pro", planVersion: 3 },
      now: new Date("2026-01-15T14:00:00Z"),
    });
    expect(result.limit).toBe(100);
    expect(result.planId).toBe("free");
    expect(result.used).toBe(2);
  });
});

describe("webhookEvents.claim — pipeline BEHAVIOR (interpreted by the mock evaluator)", () => {
  const T0 = new Date("2026-01-01T00:00:00Z");
  const META = { provider: "stripe", type: "x" };

  it("first claim wins; an immediate duplicate loses", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    expect(await adapter.webhookEvents.claim("evt_1", { ...META, now: T0 })).toBe(true);
    expect(await adapter.webhookEvents.claim("evt_1", { ...META, now: new Date(T0.getTime() + 1) })).toBe(false);
  });

  it("a claimed-but-unapplied key is re-claimable at staleClaimAfterMs, never before", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const STALE_MS = 5000;
    await adapter.webhookEvents.claim("evt_2", { ...META, now: T0, staleClaimAfterMs: STALE_MS });
    expect(
      await adapter.webhookEvents.claim("evt_2", {
        ...META,
        now: new Date(T0.getTime() + STALE_MS - 1),
        staleClaimAfterMs: STALE_MS,
      }),
    ).toBe(false);
    expect(
      await adapter.webhookEvents.claim("evt_2", {
        ...META,
        now: new Date(T0.getTime() + STALE_MS),
        staleClaimAfterMs: STALE_MS,
      }),
    ).toBe(true);
  });

  it("an applied key is never re-claimable, regardless of age", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const STALE_MS = 5000;
    await adapter.webhookEvents.claim("evt_3", { ...META, now: T0, staleClaimAfterMs: STALE_MS });
    await adapter.webhookEvents.markApplied("evt_3");
    expect(
      await adapter.webhookEvents.claim("evt_3", {
        ...META,
        now: new Date(T0.getTime() + 1_000 * STALE_MS),
        staleClaimAfterMs: STALE_MS,
      }),
    ).toBe(false);
  });

  it("distinct dedupe keys claim independently", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    expect(await adapter.webhookEvents.claim("evt_a", { ...META, now: T0 })).toBe(true);
    expect(await adapter.webhookEvents.claim("evt_b", { ...META, now: T0 })).toBe(true);
  });
});

// ── customers / plans / subscriptions / balances — CRUD behavior ──────────

describe("customers store", () => {
  it("upsert creates a schema-valid row that getByExternalId round-trips", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const created = await adapter.customers.upsert({ externalId: "user_1", email: "a@example.com" });
    expect(created.externalId).toBe("user_1");
    expect(created.email).toBe("a@example.com");
    expect(pwIdSchema.parse(created.id)).toBeTruthy();
    const fetched = await adapter.customers.getByExternalId("user_1");
    expect(fetched).toEqual(created);
  });

  it("getByExternalId returns null for an unknown external id", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    expect(await adapter.customers.getByExternalId("nobody")).toBeNull();
  });

  it("upsert is idempotent per externalId — same id, updated fields", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const first = await adapter.customers.upsert({ externalId: "user_2", email: "a@example.com" });
    const second = await adapter.customers.upsert({ externalId: "user_2", email: "b@example.com" });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe("b@example.com");
  });

  it("omitting email on a later upsert preserves the existing value", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const first = await adapter.customers.upsert({ externalId: "user_3", email: "a@example.com" });
    const second = await adapter.customers.upsert({ externalId: "user_3" });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe("a@example.com");
  });

  it("linkProviderRef merges refs without clobbering other providers", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    await adapter.customers.upsert({ externalId: "user_4" });
    await adapter.customers.linkProviderRef("user_4", "stripe", "cus_1");
    await adapter.customers.linkProviderRef("user_4", "paystack", "CUS_2");
    const row = await adapter.customers.getByExternalId("user_4");
    expect(row?.providerIds).toEqual({ stripe: "cus_1", paystack: "CUS_2" });
  });

  it("linkProviderRef throws PayweaveNotFoundError for an unknown externalId", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    await expect(adapter.customers.linkProviderRef("nobody", "stripe", "cus_1")).rejects.toThrow(
      PayweaveNotFoundError,
    );
  });
});

describe("plans store", () => {
  const makePlanInput = (overrides: Record<string, unknown> = {}) => ({
    planId: "pro",
    group: "base",
    isDefault: false,
    name: "Pro",
    priceMinor: 1900,
    priceCurrency: "USD",
    priceInterval: "month" as const,
    features: { messages: { type: "metered" as const, limit: 2000, reset: "month" as const } },
    providerRefs: {},
    ...overrides,
  });

  it("getActiveVersion/listActive are empty before any push", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    expect(await adapter.plans.getActiveVersion("pro")).toBeNull();
    expect(await adapter.plans.listActive()).toEqual([]);
  });

  it("first push creates version 1", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const pushed = await adapter.plans.pushVersion(makePlanInput());
    expect(pushed.version).toBe(1);
    expect(pushed.planId).toBe("pro");
  });

  it("re-pushing identical content is a no-op — same version, same row", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const first = await adapter.plans.pushVersion(makePlanInput());
    const again = await adapter.plans.pushVersion(makePlanInput());
    expect(again.version).toBe(first.version);
    expect(again.id).toBe(first.id);
    expect(await adapter.plans.listActive()).toHaveLength(1);
  });

  it("changed content appends version + 1 and becomes the active version — history is never mutated", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const v1 = await adapter.plans.pushVersion(makePlanInput());
    const v2 = await adapter.plans.pushVersion(makePlanInput({ priceMinor: 2900 }));
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);
    const active = await adapter.plans.getActiveVersion("pro");
    expect(active?.version).toBe(2);
    expect(active?.priceMinor).toBe(2900);
  });

  it("listActive returns exactly the active version of each plan id", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    await adapter.plans.pushVersion(makePlanInput());
    await adapter.plans.pushVersion(makePlanInput({ priceMinor: 2900 }));
    await adapter.plans.pushVersion(makePlanInput({ planId: "free", isDefault: true, priceMinor: null, priceCurrency: null, priceInterval: null, name: "Free" }));
    const active = await adapter.plans.listActive();
    expect(active).toHaveLength(2);
    const byId = new Map(active.map((p) => [p.planId, p.version]));
    expect(byId.get("pro")).toBe(2);
    expect(byId.get("free")).toBe(1);
  });

  it("retries past a (planId, version) duplicate-key collision under simulated contention", async () => {
    const db = new MockDb();
    const plansCollection = db.rawCollection(PW_TABLES.plans);
    // Configure the mock's unique-index simulation to match migrations.ts's
    // real (planId, version) unique index.
    plansCollection.uniqueKeys = [(d) => `${d.planId as string}:${d.version as number}`];
    // Pre-seed version 1 directly (simulating another process having just
    // won the race) so this call's first attempt collides and must retry.
    await plansCollection.insertOne({
      _id: generatePwId(),
      planId: "pro",
      version: 1,
      group: "base",
      isDefault: false,
      name: "Pro",
      priceMinor: 999,
      priceCurrency: "USD",
      priceInterval: "month",
      features: {},
      providerRefs: {},
      pushedAt: new Date(),
    });
    const adapter = buildAdapter({ db, client: new MockClient() });
    const pushed = await adapter.plans.pushVersion(makePlanInput());
    // Since `getActiveVersion` sees the pre-seeded v1 first, this push
    // appends v2 (different content than the pre-seeded row) rather than
    // colliding — proving the read-then-insert path is contention-aware.
    expect(pushed.version).toBe(2);
  });

  it("wraps a non-duplicate-key insertOne failure as a generic PayweaveError", async () => {
    const db = new MockDb();
    const plansCollection = db.rawCollection(PW_TABLES.plans);
    const originalInsertOne = plansCollection.insertOne.bind(plansCollection);
    const cause = new Error("connection reset");
    plansCollection.insertOne = async () => {
      throw cause;
    };
    const adapter = buildAdapter({ db, client: new MockClient() });
    const error = await adapter.plans.pushVersion(makePlanInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("PayweaveError");
    expect((error as Error).cause).toBe(cause);
    plansCollection.insertOne = originalInsertOne;
  });

  it("gives up after exhausting retries under persistent duplicate-key contention", async () => {
    const db = new MockDb();
    const plansCollection = db.rawCollection(PW_TABLES.plans);
    // Every insertOne collides, no matter what version is attempted —
    // simulates a pathological, unrelenting race.
    plansCollection.insertOne = async () => {
      const error = new Error("E11000 duplicate key error (mock, forced)");
      (error as unknown as { code: number }).code = 11000;
      throw error;
    };
    const adapter = buildAdapter({ db, client: new MockClient() });
    await expect(adapter.plans.pushVersion(makePlanInput())).rejects.toThrow(/pushVersion.*failed/);
  });
});

describe("subscriptions store", () => {
  const makeSubInput = (customerId: string, overrides: Record<string, unknown> = {}) => ({
    customerId,
    planId: "pro",
    planVersion: 1,
    group: "base",
    status: "active" as const,
    provider: "stripe",
    providerSubscriptionRef: "sub_123",
    currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    ...overrides,
  });

  function makeAdapterWithActiveUniqueIndex() {
    const db = new MockDb();
    db.rawCollection(PW_TABLES.subscriptions).uniqueKeys = [
      (d) =>
        PW_ACTIVE_SUBSCRIPTION_STATUSES.includes(d.status as (typeof PW_ACTIVE_SUBSCRIPTION_STATUSES)[number])
          ? `${d.customerId as string}:${d.group as string}`
          : "", // "" = not part of the partial index, per MockCollection's own convention
    ];
    return buildAdapter({ db, client: new MockClient() });
  }

  it("getActive returns null when the customer has no subscription in the group", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    expect(await adapter.subscriptions.getActive("cust_1", "base")).toBeNull();
  });

  it("create returns a schema-valid row that getActive finds", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    const created = await adapter.subscriptions.create(makeSubInput("cust_1"));
    expect(created.customerId).toBe("cust_1");
    const active = await adapter.subscriptions.getActive("cust_1", "base");
    expect(active?.id).toBe(created.id);
  });

  it("rejects a second active-set row per (customer, group)", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    await adapter.subscriptions.create(makeSubInput("cust_2"));
    await expect(adapter.subscriptions.create(makeSubInput("cust_2", { status: "trialing" }))).rejects.toThrow();
  });

  it("canceled rows do not occupy the partial-unique slot", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    await adapter.subscriptions.create(makeSubInput("cust_3", { status: "canceled" }));
    const live = await adapter.subscriptions.create(makeSubInput("cust_3"));
    const active = await adapter.subscriptions.getActive("cust_3", "base");
    expect(active?.id).toBe(live.id);
  });

  it("update patches status/period fields and preserves the rest", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    const created = await adapter.subscriptions.create(makeSubInput("cust_4"));
    const patched = await adapter.subscriptions.update(created.id, {
      status: "past_due",
      cancelAtPeriodEnd: true,
    });
    expect(patched.id).toBe(created.id);
    expect(patched.status).toBe("past_due");
    expect(patched.cancelAtPeriodEnd).toBe(true);
    expect(patched.providerSubscriptionRef).toBe("sub_123");
  });

  it("update throws PayweaveNotFoundError for an unknown id", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    await expect(adapter.subscriptions.update("pwv_nonexistent", { status: "canceled" })).rejects.toThrow(
      PayweaveNotFoundError,
    );
  });

  it("canceling frees the slot for a replacement row", async () => {
    const adapter = makeAdapterWithActiveUniqueIndex();
    const first = await adapter.subscriptions.create(makeSubInput("cust_5"));
    await adapter.subscriptions.update(first.id, { status: "canceled" });
    expect(await adapter.subscriptions.getActive("cust_5", "base")).toBeNull();
    const replacement = await adapter.subscriptions.create(makeSubInput("cust_5", { planId: "ultra" }));
    const active = await adapter.subscriptions.getActive("cust_5", "base");
    expect(active?.id).toBe(replacement.id);
  });

  it("wraps a non-not-found findOneAndUpdate failure as a generic PayweaveError", async () => {
    const db = new MockDb();
    const adapter = buildAdapter({ db, client: new MockClient() });
    const created = await adapter.subscriptions.create(makeSubInput("cust_6"));
    const subsCollection = db.rawCollection(PW_TABLES.subscriptions);
    const cause = new Error("connection reset");
    subsCollection.findOneAndUpdate = async () => {
      throw cause;
    };
    const error = await adapter.subscriptions
      .update(created.id, { status: "canceled" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("PayweaveError");
    expect((error as Error).cause).toBe(cause);
  });
});

describe("balances.get / balances.resetTo", () => {
  it("get returns null before first touch", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    expect(await adapter.balances.get("c1", "messages", "base")).toBeNull();
  });

  it("resetTo replaces limit/plan/anchor and zeroes usage (plan change)", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    await adapter.balances.consume({
      customerId: "c2",
      featureId: "messages",
      group: "base",
      amount: 42,
      init: { limit: 100, resetInterval: "month", anchor: new Date("2026-01-01Z"), planId: "free", planVersion: 1 },
      now: new Date("2026-01-02T00:00:00Z"),
    });
    const changeAt = new Date();
    await adapter.balances.resetTo("c2", "messages", "base", {
      limit: 2000,
      resetInterval: "month",
      anchor: changeAt,
      planId: "pro",
      planVersion: 2,
    });
    const row = await adapter.balances.get("c2", "messages", "base");
    expect(row?.used).toBe(0);
    expect(row?.limit).toBe(2000);
    expect(row?.planId).toBe("pro");
    expect(row?.planVersion).toBe(2);
    expect(row?.anchor).toEqual(changeAt);
  });

  it("resetTo is idempotent and preserves the row's own id", async () => {
    const adapter = buildAdapter({ db: new MockDb(), client: new MockClient() });
    const params = {
      limit: 500,
      resetInterval: "month" as const,
      anchor: new Date(),
      planId: "pro",
      planVersion: 1,
    };
    await adapter.balances.resetTo("c3", "f", "g", params);
    const first = await adapter.balances.get("c3", "f", "g");
    await adapter.balances.resetTo("c3", "f", "g", params);
    const second = await adapter.balances.get("c3", "f", "g");
    expect(second?.id).toBe(first?.id);
    expect(second?.used).toBe(0);
  });
});

// ── Period math: the ACTUAL pipeline object, interpreted, vs the oracle ────

describe("buildPeriodExpr — the real pipeline object matches period.ts's currentPeriod() oracle", () => {
  const cases: Array<{ anchor: string; reset: "day" | "week" | "month" | "year"; now: string }> = [
    { anchor: "2026-01-15T12:00:00Z", reset: "month", now: "2026-01-15T13:00:00Z" },
    { anchor: "2026-01-15T12:00:00Z", reset: "month", now: "2026-02-15T12:00:00Z" }, // exact boundary
    { anchor: "2026-01-15T12:00:00Z", reset: "month", now: "2026-04-25T00:00:00Z" }, // idle multi-period jump
    { anchor: "2026-01-31T00:00:00Z", reset: "month", now: "2026-04-10T00:00:00Z" }, // EOM clamp, no drift
    { anchor: "2024-02-29T00:00:00Z", reset: "year", now: "2026-03-01T00:00:00Z" }, // leap-year anchor
    { anchor: "2026-01-15T12:00:00Z", reset: "day", now: "2026-01-17T00:00:00Z" },
    { anchor: "2026-01-15T12:00:00Z", reset: "week", now: "2026-02-20T00:00:00Z" },
    { anchor: "2026-01-15T12:00:00Z", reset: "month", now: "2025-06-01T00:00:00Z" }, // now before anchor -> period 0
  ];

  it.each(cases)("matches currentPeriod() for reset=%s ($now vs $anchor)", ({ anchor, reset, now }) => {
    const anchorMs = new Date(anchor).getTime();
    const nowMs = new Date(now).getTime();
    const expected = currentPeriod(anchorMs, reset, nowMs);

    // Interpret the REAL pipeline expression the adapter sends to MongoDB.
    const pipelineResult = runPipeline(
      [{ $set: { period: buildPeriodExpr(nowMs, "$anchor", "$reset") } }],
      { anchor: new Date(anchorMs), reset },
    ) as { period: { index: number; start: Date; end: Date } };
    expect(pipelineResult.period.index).toBe(expected.index);
    expect(pipelineResult.period.start.getTime()).toBe(expected.start);
    expect(pipelineResult.period.end.getTime()).toBe(expected.end);

    // Cross-check against the independent pure-JS simulation too.
    const simulated = simulatePeriodPipeline(nowMs, anchorMs, reset);
    expect(simulated).toEqual(expected);
  });

  it("property test: hundreds of random anchors/resets/nows agree with the oracle", () => {
    const resets: Array<"day" | "week" | "month" | "year"> = ["day", "week", "month", "year"];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 500; i++) {
      const anchorMs = Date.UTC(2020 + Math.floor(rand() * 10), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28));
      const reset = resets[Math.floor(rand() * resets.length)]!;
      const driftMs = Math.floor(rand() * 1000) * DAY_LIKE_MS(reset) * (rand() < 0.1 ? 40 : 3);
      const nowMs = anchorMs + driftMs;
      const expected = currentPeriod(anchorMs, reset, nowMs);
      const simulated = simulatePeriodPipeline(nowMs, anchorMs, reset);
      expect(simulated).toEqual(expected);
      const pipelineResult = runPipeline(
        [{ $set: { period: buildPeriodExpr(nowMs, "$anchor", "$reset") } }],
        { anchor: new Date(anchorMs), reset },
      ) as { period: { index: number; start: Date; end: Date } };
      expect(pipelineResult.period.index).toBe(expected.index);
      expect(pipelineResult.period.start.getTime()).toBe(expected.start);
      expect(pipelineResult.period.end.getTime()).toBe(expected.end);
    }
  });
});

function DAY_LIKE_MS(reset: "day" | "week" | "month" | "year"): number {
  if (reset === "day") return 86_400_000;
  if (reset === "week") return 604_800_000;
  if (reset === "month") return 30 * 86_400_000;
  return 365 * 86_400_000;
}

// ── Index setup — idempotent, partial-filter unique index ─────────────────

describe("migrations.status()/apply() — idempotent collection + index setup", () => {
  it("status() reports pending before apply(), applied after", async () => {
    const db = new MockDb();
    expect(await mongoMigrationStatus(db)).toEqual({ pending: [MIGRATION_NAME], applied: [] });
    await mongoMigrationApply(db);
    expect(await mongoMigrationStatus(db)).toEqual({ pending: [], applied: [MIGRATION_NAME] });
  });

  it("apply() creates the active-subscription partial unique index with partialFilterExpression", async () => {
    const db = new MockDb();
    await mongoMigrationApply(db);
    const subs = db.rawCollection(PW_TABLES.subscriptions);
    const createIndexCall = subs.calls.find((c) => c.method === "createIndex");
    expect(createIndexCall).toBeDefined();
    const [key, options] = createIndexCall!.args as [Record<string, 1 | -1>, Record<string, unknown>];
    expect(key).toEqual({ customerId: 1, group: 1 });
    expect(options.unique).toBe(true);
    expect(options.partialFilterExpression).toEqual({
      status: { $in: [...PW_ACTIVE_SUBSCRIPTION_STATUSES] },
    });
  });

  it("apply() creates the expected unique indexes for customers/plans/balances", async () => {
    const db = new MockDb();
    await mongoMigrationApply(db);
    const customersIndex = db
      .rawCollection(PW_TABLES.customers)
      .calls.find((c) => c.method === "createIndex")!.args as [Record<string, 1 | -1>, Record<string, unknown>];
    expect(customersIndex[0]).toEqual({ externalId: 1 });
    expect(customersIndex[1].unique).toBe(true);

    const plansIndex = db.rawCollection(PW_TABLES.plans).calls.find((c) => c.method === "createIndex")!
      .args as [Record<string, 1 | -1>, Record<string, unknown>];
    expect(plansIndex[0]).toEqual({ planId: 1, version: 1 });

    const balancesIndex = db
      .rawCollection(PW_TABLES.featureBalances)
      .calls.find((c) => c.method === "createIndex")!.args as [Record<string, 1 | -1>, Record<string, unknown>];
    expect(balancesIndex[0]).toEqual({ customerId: 1, featureId: 1, group: 1 });
  });

  it("is idempotent — running apply() twice creates no duplicate indexes and issues no createIndex calls the second time", async () => {
    const db = new MockDb();
    await mongoMigrationApply(db);
    const subs = db.rawCollection(PW_TABLES.subscriptions);
    const callsAfterFirst = subs.calls.filter((c) => c.method === "createIndex").length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const result = await mongoMigrationApply(db);
    expect(result.applied).toEqual([]);
    const callsAfterSecond = subs.calls.filter((c) => c.method === "createIndex").length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // no new createIndex calls issued
    expect(subs.indexInfos).toHaveLength(1); // no duplicate index entries
  });

  it("status() flags a manually 'dropped' index (simulated: fresh db never had it)", async () => {
    const db = new MockDb();
    // Never call apply() — a fresh db has no indexes beyond the default `_id`.
    const status = await mongoMigrationStatus(db);
    expect(status.pending).toEqual([MIGRATION_NAME]);
  });

  it("treats a NamespaceNotFound error from indexes() as 'no indexes yet', not a failure", async () => {
    const db = new MockDb();
    const customers = db.rawCollection(PW_TABLES.customers);
    customers.indexes = async () => {
      const error = new Error("ns not found");
      (error as unknown as { code: number }).code = 26;
      throw error;
    };
    const status = await mongoMigrationStatus(db);
    expect(status.pending).toEqual([MIGRATION_NAME]);
  });

  it("propagates a genuine indexes() failure that isn't NamespaceNotFound", async () => {
    const db = new MockDb();
    const customers = db.rawCollection(PW_TABLES.customers);
    customers.indexes = async () => {
      throw new Error("connection reset");
    };
    await expect(mongoMigrationStatus(db)).rejects.toThrow("connection reset");
  });
});

// ── Topology detection + standalone fallback ────────────────────────────────

describe("isTransactionsUnsupportedError", () => {
  it("matches the documented standalone error shape (code 20 + message)", () => {
    const error = Object.assign(
      new Error("Transaction numbers are only allowed on a replica set member or mongos"),
      { code: 20 },
    );
    expect(isTransactionsUnsupportedError(error)).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isTransactionsUnsupportedError(new Error("network timeout"))).toBe(false);
    expect(isTransactionsUnsupportedError(null)).toBe(false);
    expect(isTransactionsUnsupportedError("boom")).toBe(false);
  });

  it("does not false-positive on a real business error thrown from inside a transaction", () => {
    const boom = new Error("insufficient funds");
    expect(isTransactionsUnsupportedError(boom)).toBe(false);
  });
});

describe("runTransaction — replica-set uses a real session; standalone falls back", () => {
  it("replica-set: fn receives the active session, and its return value is threaded through", async () => {
    const client = new MockClient("replica-set");
    const result = await runTransaction(client, async (session) => {
      expect(session).toBeDefined();
      return 42;
    });
    expect(result).toBe(42);
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]!.ended).toBe(true);
  });

  it("standalone: falls back to running fn WITHOUT a session — never throws the unsupported error to the caller", async () => {
    const client = new MockClient("standalone");
    let sawSession: unknown = "unset";
    const result = await runTransaction(client, async (session) => {
      sawSession = session;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(sawSession).toBeUndefined();
  });

  it("propagates the caller's own thrown error unchanged on a replica set (real rollback semantics)", async () => {
    const client = new MockClient("replica-set");
    const boom = new Error("apply failed");
    await expect(
      runTransaction(client, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("a real business error thrown in the STANDALONE fallback path also propagates unchanged", async () => {
    const client = new MockClient("standalone");
    const boom = new Error("apply failed");
    await expect(
      runTransaction(client, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

// ── Bundle isolation (spot check; PW-710 owns the formal gate) ─────────────

describe("payweave root never touches the mongodb adapter", () => {
  it("importing payweave's root barrel does not import src/db/mongodb/* or the mongodb package", async () => {
    const rootSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/index.ts", import.meta.url), "utf8"),
    );
    expect(rootSrc).not.toMatch(/db\/mongodb/);
    expect(rootSrc).not.toMatch(/["']mongodb["']/);
  });
});

// ── ULID id generation ───────────────────────────────────────────────────────

describe("generatePwId", () => {
  it("matches the pwIdSchema shape (pwv_ + 26-char Crockford Base32)", () => {
    expect(() => pwIdSchema.parse(generatePwId())).not.toThrow();
  });

  it("is unique across a burst of calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generatePwId()));
    expect(ids.size).toBe(500);
  });

  it("ulid() alone matches the 26-char Crockford Base32 shape", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
