/**
 * `payweave/db/sqlite` — the SQLite/libSQL adapter (docs/v1/database.md,
 * PW-706). This is the FIRST adapter to turn PW-702's conformance suite
 * green: `runDatabaseConformance` runs the whole `database.md §6` case list
 * against a fresh in-memory `better-sqlite3` database AND a fresh in-memory
 * `@libsql/client` database (both drivers are runnable fully in-process —
 * verified: no network/docker needed for either — so the PW-706 brief's
 * "run against BOTH drivers to catch behavioral drift" is exercised for
 * real, not just via URL-parsing unit tests).
 *
 * Beyond conformance: URL/instance routing, install-hint errors when a
 * driver is missing, migration round-trip + mutated-ledger detection, the
 * single-connection `:memory:` invariant, and the two spec-silent decisions
 * documented in `src/db/sqlite/adapter.ts` (denial vs. a due reset;
 * `customers.upsert` preserving an omitted email).
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayweaveConfigError } from "../../src/core/errors";
import { PayweaveMigrationHistoryError } from "../../src/db/migrations/index";
import { PW_TABLES, pwIdSchema } from "../../src/db/schema";
import { buildAdapter } from "../../src/db/sqlite/adapter";
import { BetterSqlite3Raw, sqliteFileUrlToPath } from "../../src/db/sqlite/drivers/better-sqlite3";
import { sqliteAdapter } from "../../src/db/sqlite/index";
import { generatePwId } from "../../src/db/sqlite/id";
import { AutoQueueRunner } from "../../src/db/sqlite/runner";
import { classifySqliteUrl, resolveSqliteInput } from "../../src/db/sqlite/url";
import { runDatabaseConformance, type DatabaseAdapterHandle } from "./conformance";

// ── Conformance — the whole point of this ticket ────────────────────────────

async function makeBetterSqlite3Adapter(): Promise<DatabaseAdapterHandle> {
  const adapter = sqliteAdapter({ url: ":memory:" });
  await adapter.migrations.apply();
  return { adapter };
}

async function makeLibsqlAdapter(): Promise<DatabaseAdapterHandle> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: ":memory:" });
  const adapter = sqliteAdapter(client);
  await adapter.migrations.apply();
  return { adapter, teardown: () => client.close() };
}

runDatabaseConformance("sqlite (better-sqlite3, :memory:)", makeBetterSqlite3Adapter);
runDatabaseConformance("sqlite (libsql, :memory:)", makeLibsqlAdapter);

// ── URL / instance routing ───────────────────────────────────────────────────

describe("classifySqliteUrl", () => {
  it.each([
    [":memory:", "better-sqlite3"],
    ["file:./payweave.db", "better-sqlite3"],
    ["file:///abs/payweave.db", "better-sqlite3"],
    ["./relative/payweave.db", "better-sqlite3"],
    ["/abs/payweave.db", "better-sqlite3"],
    ["payweave.db", "better-sqlite3"],
    ["libsql://example.turso.io", "libsql"],
    ["wss://example.turso.io", "libsql"],
    ["https://example.turso.io", "libsql"],
    ["http://localhost:8080", "libsql"],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(classifySqliteUrl(url)).toBe(expected);
  });

  it("rejects a recognizable-but-unsupported scheme eagerly", () => {
    expect(() => classifySqliteUrl("postgres://user:pass@host/db")).toThrow(PayweaveConfigError);
    expect(() => classifySqliteUrl("mysql://user:pass@host/db")).toThrow(PayweaveConfigError);
  });

  it("rejects an empty url", () => {
    expect(() => classifySqliteUrl("")).toThrow(PayweaveConfigError);
  });
});

describe("resolveSqliteInput / sqliteAdapter(...) input validation (synchronous, side-effect-free)", () => {
  it("routes { url } through classifySqliteUrl", () => {
    expect(resolveSqliteInput({ url: ":memory:" })).toEqual({
      kind: "url",
      driver: "better-sqlite3",
      url: ":memory:",
    });
    expect(resolveSqliteInput({ url: "libsql://x" })).toEqual({
      kind: "url",
      driver: "libsql",
      url: "libsql://x",
    });
  });

  it("accepts a raw better-sqlite3-like instance (structural: .prepare + .pragma)", () => {
    const fakeDb = {
      prepare: () => ({ reader: false, run: () => undefined, all: () => [] }),
      pragma: () => undefined,
    };
    expect(resolveSqliteInput(fakeDb)).toEqual({ kind: "better-sqlite3-instance", database: fakeDb });
  });

  it("accepts a raw libsql-like instance (structural: .execute + .batch)", () => {
    const fakeClient = { execute: async () => ({ rows: [] }), batch: async () => [] };
    expect(resolveSqliteInput(fakeClient)).toEqual({ kind: "libsql-instance", client: fakeClient });
  });

  it("throws PayweaveConfigError for a non-string url", () => {
    expect(() => sqliteAdapter({ url: 123 as unknown as string })).toThrow(PayweaveConfigError);
  });

  it("throws PayweaveConfigError for null/primitive/unrecognized-shape input", () => {
    expect(() => sqliteAdapter(null as unknown as { url: string })).toThrow(PayweaveConfigError);
    expect(() => sqliteAdapter(42 as unknown as { url: string })).toThrow(PayweaveConfigError);
    expect(() => sqliteAdapter({ notAUrl: true } as unknown as { url: string })).toThrow(
      PayweaveConfigError,
    );
  });

  it("throws PayweaveConfigError synchronously for a garbage URL scheme — construction never connects", () => {
    expect(() => sqliteAdapter({ url: "ftp://nope" })).toThrow(PayweaveConfigError);
  });
});

describe("sqliteFileUrlToPath", () => {
  it.each([
    ["file:./payweave.db", "./payweave.db"],
    ["file:/abs/payweave.db", "/abs/payweave.db"],
    ["file://./payweave.db", "./payweave.db"],
    ["file:///abs/payweave.db", "/abs/payweave.db"],
  ])("%s -> %s", (input, expected) => {
    expect(sqliteFileUrlToPath(input)).toBe(expected);
  });
});

// ── Install hints when a driver is absent ───────────────────────────────────

describe("install-hint errors when the required optional peer driver is missing", () => {
  afterEach(() => {
    vi.doUnmock("better-sqlite3");
    vi.doUnmock("@libsql/client");
    vi.resetModules();
  });

  it("names better-sqlite3 + an install command for a :memory: url", async () => {
    vi.resetModules();
    vi.doMock("better-sqlite3", () => {
      throw new Error("Cannot find package 'better-sqlite3'");
    });
    // Re-import from the SAME reset module registry as `sqliteAdapter` — a
    // `PayweaveConfigError` class pulled from the pre-reset registry is a
    // DIFFERENT class object than the one the fresh adapter throws, so
    // `instanceof` must compare against a class from this same registry.
    const { sqliteAdapter: freshSqliteAdapter } = await import("../../src/db/sqlite/index");
    const { PayweaveConfigError: FreshPayweaveConfigError } = await import("../../src/core/errors");
    const adapter = freshSqliteAdapter({ url: ":memory:" });
    const error = await adapter.customers.getByExternalId("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreshPayweaveConfigError);
    const message = (error as InstanceType<typeof FreshPayweaveConfigError>).message;
    expect(message).toContain("better-sqlite3");
    expect(message).toMatch(/npm install/);
    expect(message).toContain(":memory:");
  });

  it("names @libsql/client + an install command for a libsql:// url", async () => {
    vi.resetModules();
    vi.doMock("@libsql/client", () => {
      throw new Error("Cannot find package '@libsql/client'");
    });
    const { sqliteAdapter: freshSqliteAdapter } = await import("../../src/db/sqlite/index");
    const { PayweaveConfigError: FreshPayweaveConfigError } = await import("../../src/core/errors");
    const adapter = freshSqliteAdapter({ url: "libsql://example.turso.io" });
    const error = await adapter.customers.getByExternalId("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreshPayweaveConfigError);
    const message = (error as InstanceType<typeof FreshPayweaveConfigError>).message;
    expect(message).toContain("@libsql/client");
    expect(message).toMatch(/npm install/);
  });

  it("names @libsql/client for an https:// url too (routing, not just scheme text)", async () => {
    vi.resetModules();
    vi.doMock("@libsql/client", () => {
      throw new Error("Cannot find package '@libsql/client'");
    });
    const { sqliteAdapter: freshSqliteAdapter } = await import("../../src/db/sqlite/index");
    const adapter = freshSqliteAdapter({ url: "https://example.turso.io" });
    await expect(adapter.customers.getByExternalId("x")).rejects.toThrow(/@libsql\/client/);
  });

  it("passing an existing driver instance never triggers a dynamic import (no install hint possible)", async () => {
    vi.resetModules();
    vi.doMock("better-sqlite3", () => {
      throw new Error("should never be imported when an instance is passed directly");
    });
    const { sqliteAdapter: freshSqliteAdapter } = await import("../../src/db/sqlite/index");
    const db = new Database(":memory:");
    const adapter = freshSqliteAdapter(db as unknown as Parameters<typeof freshSqliteAdapter>[0]);
    await adapter.migrations.apply();
    await expect(adapter.customers.getByExternalId("x")).resolves.toBeNull();
    db.close();
  });
});

// ── Migrations: round-trip + mutated-ledger detection ───────────────────────

describe("migrations — status()/apply() round trip", () => {
  it("fresh apply -> status reports everything applied -> a second apply is a no-op", async () => {
    const adapter = sqliteAdapter({ url: ":memory:" });
    const first = await adapter.migrations.apply();
    expect(first.applied).toEqual(["0001_init"]);
    expect(first.instructions).toBeUndefined();

    const status = await adapter.migrations.status();
    expect(status.applied).toEqual(["0001_init"]);
    expect(status.pending).toEqual([]);

    const second = await adapter.migrations.apply();
    expect(second.applied).toEqual([]);
  });

  it("status() before any apply reports 0001_init pending", async () => {
    const adapter = sqliteAdapter({ url: ":memory:" });
    const status = await adapter.migrations.status();
    expect(status.pending).toEqual(["0001_init"]);
    expect(status.applied).toEqual([]);
  });
});

describe("migrations — mutated ledger fails loudly (database.md §4)", () => {
  it("a tampered checksum surfaces through status() AND apply()", async () => {
    // White-box: reach past the public factory to share the SAME connection
    // between the adapter and a raw statement that tampers with the ledger
    // (also doubles as another single-connection-persistence proof).
    const db = new Database(":memory:");
    try {
      const runner = new AutoQueueRunner(() => Promise.resolve(new BetterSqlite3Raw(db)));
      const adapter = buildAdapter(runner);
      await adapter.migrations.apply();

      db.prepare(`UPDATE ${PW_TABLES.migrations} SET checksum = ? WHERE name = ?`).run(
        "sha256:tampered",
        "0001_init",
      );

      await expect(adapter.migrations.status()).rejects.toThrow(PayweaveMigrationHistoryError);
      await expect(adapter.migrations.apply()).rejects.toThrow(PayweaveMigrationHistoryError);
    } finally {
      db.close();
    }
  });

  it("an unknown ledger row surfaces through status()", async () => {
    const db = new Database(":memory:");
    try {
      const runner = new AutoQueueRunner(() => Promise.resolve(new BetterSqlite3Raw(db)));
      const adapter = buildAdapter(runner);
      await adapter.migrations.apply();

      db.prepare(
        `INSERT INTO ${PW_TABLES.migrations} (name, applied_at, checksum) VALUES (?, ?, ?)`,
      ).run("9999_from_the_future", Date.now(), "sha256:whatever");

      await expect(adapter.migrations.status()).rejects.toThrow(PayweaveMigrationHistoryError);
    } finally {
      db.close();
    }
  });
});

// ── Single-connection :memory: invariant ────────────────────────────────────

describe("single connection for :memory: (per-connection persistence, PW-706 brief)", () => {
  it("two sequential ops on one better-sqlite3-backed adapter see the same data", async () => {
    const adapter = sqliteAdapter({ url: ":memory:" });
    await adapter.migrations.apply();
    const customer = await adapter.customers.upsert({ externalId: "user_1" });
    const fetched = await adapter.customers.getByExternalId("user_1");
    expect(fetched?.id).toBe(customer.id);
  });

  it("two sequential ops on one libsql-backed (:memory:) adapter see the same data", async () => {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: ":memory:" });
    try {
      const adapter = sqliteAdapter(client);
      await adapter.migrations.apply();
      const customer = await adapter.customers.upsert({ externalId: "user_1" });
      const fetched = await adapter.customers.getByExternalId("user_1");
      expect(fetched?.id).toBe(customer.id);
    } finally {
      client.close();
    }
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
});

// ── Spec-silent decisions (documented in src/db/sqlite/adapter.ts) ─────────

describe("balances.consume — spec-silent: a due reset applies even when the decrement is denied", () => {
  it("resets used/period bounds on a boundary-crossing conditional denial", async () => {
    const adapter = sqliteAdapter({ url: ":memory:" });
    await adapter.migrations.apply();
    const customer = await adapter.customers.upsert({ externalId: "user_reset_denied" });
    const anchor = new Date("2026-01-15T12:00:00.000Z");
    const init = {
      limit: 5,
      resetInterval: "month" as const,
      anchor,
      planId: "free",
      planVersion: 1,
    };
    await adapter.balances.consume({
      customerId: customer.id,
      featureId: "f",
      group: "base",
      amount: 5,
      init,
      now: new Date("2026-01-15T13:00:00.000Z"),
    });

    const boundary = new Date("2026-02-15T12:00:00.000Z");
    const result = await adapter.balances.consume({
      customerId: customer.id,
      featureId: "f",
      group: "base",
      amount: 10,
      conditional: true,
      init,
      now: boundary,
    });
    expect(result.applied).toBe(false);
    expect(result.used).toBe(0); // the due reset still happened
    expect(result.periodStart).toEqual(boundary);
    expect(result.periodEnd).toEqual(new Date("2026-03-15T12:00:00.000Z"));
  });
});

describe("customers.upsert — spec-silent: omitting email preserves the existing value", () => {
  it("a second upsert without email does not clear a previously-set email", async () => {
    const adapter = sqliteAdapter({ url: ":memory:" });
    await adapter.migrations.apply();
    const first = await adapter.customers.upsert({ externalId: "user_email", email: "a@example.com" });
    const second = await adapter.customers.upsert({ externalId: "user_email" });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe("a@example.com");
  });

  it("an explicit new email overwrites the previous one", async () => {
    const adapter = sqliteAdapter({ url: ":memory:" });
    await adapter.migrations.apply();
    await adapter.customers.upsert({ externalId: "user_email2", email: "a@example.com" });
    const updated = await adapter.customers.upsert({ externalId: "user_email2", email: "b@example.com" });
    expect(updated.email).toBe("b@example.com");
  });
});
