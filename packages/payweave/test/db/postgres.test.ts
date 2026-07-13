/**
 * `payweave/db/postgres` — the direct `pg` adapter (docs/v1/database.md,
 * PW-704).
 *
 * ── What is (and is NOT) verified here — read this before trusting a green
 * run ─────────────────────────────────────────────────────────────────────
 * This sandbox has NO docker, so the real conformance suite (dockerized
 * `postgres:16`, database.md §6) cannot execute here — it is registered
 * behind `PW_DB_CONFORMANCE_DOCKER=1` (copied from `test/db/drizzle.test.ts`'s
 * exact gating pattern) so it SKIPS in this environment and runs for real in
 * PW-710's CI matrix. Everything else in this file is an IN-PROCESS structural
 * proof that does NOT require a live postgres:
 *
 * - Input validation (`connectionString` scheme, pool-instance detection) —
 *   pure functions, fully exercised.
 * - The install-hint error when `pg` is absent — `pg` is mocked to throw on
 *   import; fully exercised.
 * - `PostgresMigrationExecutor` wiring — proven against a hand-rolled fake
 *   `Runner` that behaves like an empty ledger; asserts the ACTUAL `$1, $2,
 *   $3`-placeholder SQL text `applyMigrations` sends for the ledger insert.
 * - The single-statement SHAPE of `balances.consume`/`webhookEvents.claim` —
 *   proven two ways: (a) `buildConsumeQuery`/`buildClaimQuery` unit tests
 *   inspecting the exact SQL text/param positions, and (b) a mock `pg` Pool
 *   that records every `query()` call, driving the real `postgresAdapter(...)`
 *   factory end to end and asserting EXACTLY ONE query is sent per call —
 *   this proves the adapter code path never issues a second round trip, i.e.
 *   never falls back to read-then-write. It does NOT prove postgres itself
 *   executes this SQL correctly (see the next bullet).
 * - The period-math CASE expression `./period-sql.ts` generates for the
 *   reset-due branch — cross-checked via a byte-for-byte JS transcription of
 *   the exact same FLOOR/MOD/EXTRACT operations, property-tested against
 *   `src/products/period.ts`'s `currentPeriod` (the shipped oracle, PW-901)
 *   across day/week/month/year, leap years, end-of-month anchors, and both
 *   directions of clock drift. This is the strongest confidence available
 *   without a live database, but it is NOT a substitute for actually running
 *   the SQL against postgres — only PW-710's docker leg can confirm
 *   postgres's own `EXTRACT`/`make_timestamptz`/interval semantics agree with
 *   the mirror bit-for-bit (e.g. `AT TIME ZONE 'UTC'` behavior, `FOR UPDATE`
 *   CTE locking semantics under real concurrency, `ON CONFLICT` interaction
 *   with a locked target row). Treat this suite as "structurally sound and
 *   logically re-derived", not as "verified against real postgres".
 * - `pg`-specific row decoding (`BIGINT` returned as `string`) — exercised via
 *   the mock pool returning string-typed `used`/`limit` values.
 * - `Runner.transaction` BEGIN/COMMIT/ROLLBACK + always-release sequencing —
 *   proven against a mock `PoolClient`.
 * - Connection-string redaction — see `test/core/redact.test.ts`'s dedicated
 *   cases (database.md §7/§8); this file additionally asserts the adapter's
 *   OWN validation error never echoes the raw string.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayweaveConfigError } from "../../src/core/errors";
import { applyMigrations, planMigrations, type MigrationExecutor } from "../../src/db/migrations/index";
import { postgresAdapter } from "../../src/db/postgres/index";
import { PostgresMigrationExecutor } from "../../src/db/postgres/migrations-executor";
import { buildClaimQuery, buildConsumeQuery } from "../../src/db/postgres/sql";
import { buildPeriodMathSql } from "../../src/db/postgres/period-sql";
import type { Runner } from "../../src/db/postgres/runner";
import { resolvePostgresInput, assertPostgresConnectionString } from "../../src/db/postgres/url";
import { generatePwId } from "../../src/db/postgres/id";
import { pwIdSchema } from "../../src/db/schema";
import { currentPeriod, type ResetInterval } from "../../src/products/period";
import { runDatabaseConformance, type DatabaseAdapterHandle } from "./conformance";

// ── Docker-gated conformance (PW-710's CI matrix) — copies drizzle.test.ts's
// exact gating pattern so this suite SKIPS here (no docker) and runs for real
// in CI once PW-710 sets the env flag. ──────────────────────────────────────

// eslint-disable-next-line turbo/no-undeclared-env-vars
const RUN_DOCKER_CONFORMANCE = process.env.PW_DB_CONFORMANCE_DOCKER === "1";

describe.skipIf(!RUN_DOCKER_CONFORMANCE)(
  "postgres (pg) — docker-only conformance (PW-710's CI matrix)",
  () => {
    async function makePostgresAdapter(): Promise<DatabaseAdapterHandle> {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- PW-710's docker leg only.
      const connectionString = process.env.PW_POSTGRES_URL ?? "postgres://postgres:postgres@localhost:5432/payweave";
      const adapter = postgresAdapter({ connectionString });
      await adapter.migrations.apply();
      return {
        adapter,
        teardown: async () => {
          // `postgresAdapter({ connectionString })` owns its pool; there is no
          // public "close" on the DatabaseAdapter contract, so PW-710's CI leg
          // truncates/drops the database between runs at the docker-compose
          // level rather than through this handle.
        },
      };
    }
    runDatabaseConformance("postgres (pg)", makePostgresAdapter);
  },
);

// ── Input validation — synchronous, side-effect-free (database.md §1) ──────

describe("assertPostgresConnectionString / resolvePostgresInput", () => {
  it("accepts postgres:// and postgresql:// schemes", () => {
    expect(assertPostgresConnectionString("postgres://u:p@host/db")).toBe("postgres://u:p@host/db");
    expect(assertPostgresConnectionString("postgresql://u:p@host/db")).toBe("postgresql://u:p@host/db");
  });

  it("rejects a garbage scheme eagerly", () => {
    expect(() => assertPostgresConnectionString("mysql://u:p@host/db")).toThrow(PayweaveConfigError);
    expect(() => assertPostgresConnectionString("mongodb://u:p@host/db")).toThrow(PayweaveConfigError);
  });

  it("rejects empty/non-string values", () => {
    expect(() => assertPostgresConnectionString("")).toThrow(PayweaveConfigError);
    expect(() => assertPostgresConnectionString(123)).toThrow(PayweaveConfigError);
    expect(() => assertPostgresConnectionString(undefined)).toThrow(PayweaveConfigError);
  });

  it("never echoes the raw connection string in the rejection message (never log credentials)", () => {
    const secretish = "mysql://app_user:s3cr3t-p4ss-value@db.example.com/payweave";
    try {
      assertPostgresConnectionString(secretish);
      expect.unreachable("must throw");
    } catch (error) {
      const message = (error as PayweaveConfigError).message;
      expect(message).not.toContain("s3cr3t-p4ss-value");
      expect(message).not.toContain(secretish);
    }
  });

  it("resolves { connectionString } and a Pool-shaped instance", () => {
    expect(resolvePostgresInput({ connectionString: "postgres://x/y" })).toEqual({
      kind: "connectionString",
      connectionString: "postgres://x/y",
    });
    const fakePool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
    expect(resolvePostgresInput(fakePool)).toEqual({ kind: "pool-instance", pool: fakePool });
  });

  it("throws PayweaveConfigError for null/primitive/unrecognized-shape input", () => {
    expect(() => resolvePostgresInput(null)).toThrow(PayweaveConfigError);
    expect(() => resolvePostgresInput(42)).toThrow(PayweaveConfigError);
    expect(() => resolvePostgresInput({ notAPool: true })).toThrow(PayweaveConfigError);
  });

  it("postgresAdapter(...) validates synchronously — construction never connects", () => {
    expect(() => postgresAdapter({ connectionString: "ftp://nope" })).toThrow(PayweaveConfigError);
    expect(() => postgresAdapter(null as unknown as { connectionString: string })).toThrow(
      PayweaveConfigError,
    );
  });
});

// ── Install hint when `pg` is absent ─────────────────────────────────────────

describe("install-hint error when the optional peer driver (pg) is missing", () => {
  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("names pg + an install command, only on first query (construction never imports pg)", async () => {
    vi.resetModules();
    vi.doMock("pg", () => {
      throw new Error("Cannot find package 'pg'");
    });
    // Re-import from the SAME reset module registry as `postgresAdapter` — a
    // `PayweaveConfigError` class pulled from the pre-reset registry is a
    // DIFFERENT class object than the one the fresh adapter throws.
    const { postgresAdapter: freshPostgresAdapter } = await import("../../src/db/postgres/index");
    const { PayweaveConfigError: FreshPayweaveConfigError } = await import("../../src/core/errors");
    const adapter = freshPostgresAdapter({ connectionString: "postgres://user:pass@localhost/db" });
    const error = await adapter.customers.getByExternalId("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreshPayweaveConfigError);
    const message = (error as InstanceType<typeof FreshPayweaveConfigError>).message;
    expect(message).toContain("pg");
    expect(message).toMatch(/npm install pg/);
  });

  it("passing an existing Pool instance never triggers a dynamic import (no install hint possible)", async () => {
    vi.resetModules();
    vi.doMock("pg", () => {
      throw new Error("should never be imported when a pool instance is passed directly");
    });
    const { postgresAdapter: freshPostgresAdapter } = await import("../../src/db/postgres/index");
    const fakePool = {
      query: async () => ({ rows: [] }),
      connect: async () => {
        throw new Error("not exercised in this test");
      },
    };
    const adapter = freshPostgresAdapter(fakePool as never);
    await expect(adapter.customers.getByExternalId("x")).resolves.toBeNull();
  });
});

// ── Single-statement shape — direct unit tests of the query builders ───────

const SAMPLE_INIT = {
  limit: 100,
  resetInterval: "month" as const,
  anchor: new Date("2026-01-15T12:00:00.000Z"),
  planId: "free",
  planVersion: 1,
};

describe("buildConsumeQuery — the atomic single-statement shape", () => {
  it("is one WITH ... INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement", () => {
    const { text, params } = buildConsumeQuery(
      {
        customerId: "pwv_customer",
        featureId: "messages",
        group: "base",
        amount: 1,
        conditional: true,
        init: SAMPLE_INIT,
        now: new Date("2026-01-15T13:00:00.000Z"),
      },
      "pwv_new_id",
    );
    // Exactly one statement — a single string, never multiple `;`-joined
    // statements (which would defeat single-round-trip atomicity).
    expect(text.trim().replace(/;$/, "").includes(";")).toBe(false);
    expect(text).toMatch(/^WITH existing AS \(/);
    expect(text).toContain("FOR UPDATE");
    expect(text).toContain("INSERT INTO pw_feature_balances");
    expect(text).toContain('ON CONFLICT (customer_id, feature_id, "group") DO UPDATE SET');
    expect(text).toContain("RETURNING");
    expect(text).toMatch(/AS applied\s*$/);
    // No read-modify-write: the decision (`applied`) is derived from the
    // pre-write, locked `computed` CTE — never re-read from the post-update
    // table row (see `./sql.ts`'s header for why that distinction matters).
    expect(text).not.toMatch(/RETURNING[\s\S]*pw_feature_balances\.(?:used|period_end)/);

    expect(params).toHaveLength(14);
    expect(params[0]).toBe("pwv_new_id");
    expect(params[1]).toBe("pwv_customer");
    expect(params[6]).toBe(true); // conditional, coerced to an explicit boolean
    expect(params[7]).toBe(100); // init.limit
  });

  it("coerces conditional: undefined to an explicit false bind (never null)", () => {
    const { params } = buildConsumeQuery(
      {
        customerId: "c",
        featureId: "f",
        group: "g",
        amount: 1,
        init: SAMPLE_INIT,
        now: new Date("2026-01-15T13:00:00.000Z"),
      },
      "pwv_new_id",
    );
    expect(params[6]).toBe(false);
  });

  it("computes the fresh-row period_start/period_end via the real period.ts oracle (no SQL month math needed for that branch)", () => {
    const now = new Date("2026-04-10T00:00:00.000Z");
    const { params } = buildConsumeQuery(
      {
        customerId: "c",
        featureId: "f",
        group: "g",
        amount: 1,
        init: { ...SAMPLE_INIT, anchor: new Date("2026-01-31T00:00:00.000Z") },
        now,
      },
      "pwv_new_id",
    );
    const expected = currentPeriod(new Date("2026-01-31T00:00:00.000Z").getTime(), "month", now.getTime());
    expect(params[12]).toEqual(new Date(expected.start));
    expect(params[13]).toEqual(new Date(expected.end));
  });
});

describe("buildClaimQuery — the insert-or-steal single-statement shape", () => {
  it("is one INSERT ... ON CONFLICT ... WHERE ... RETURNING statement", () => {
    const { text, params } = buildClaimQuery(
      "evt_1",
      { provider: "stripe", type: "customer.subscription.updated", now: new Date("2026-01-01T00:00:00Z") },
      60_000,
    );
    expect(text.trim().replace(/;$/, "").includes(";")).toBe(false);
    expect(text).toContain("INSERT INTO pw_webhook_events");
    expect(text).toContain("ON CONFLICT (dedupe_key) DO UPDATE SET claimed_at = EXCLUDED.claimed_at");
    expect(text).toContain("WHERE pw_webhook_events.applied_at IS NULL");
    expect(text).toContain("pw_webhook_events.claimed_at <= $6");
    expect(text).toContain("RETURNING dedupe_key");
    expect(params).toHaveLength(6);
    expect(params[0]).toBe("evt_1");
  });

  it("the stale threshold bind is now - staleClaimAfterMs", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { params } = buildClaimQuery("evt_1", { provider: "stripe", type: "x", now, staleClaimAfterMs: 5_000 }, 60_000);
    expect(params[5]).toEqual(new Date(now.getTime() - 5_000));
  });

  it("falls back to the default stale window when the caller omits it", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { params } = buildClaimQuery("evt_1", { provider: "stripe", type: "x", now }, 60_000);
    expect(params[5]).toEqual(new Date(now.getTime() - 60_000));
  });
});

// ── Single-statement proof at the ADAPTER level — a mock pg Pool recording
// every query() call. This is what proves the ADAPTER never falls back to a
// second round trip, not just that the builder CAN produce single-statement
// text. ──────────────────────────────────────────────────────────────────────

interface RecordedQuery {
  text: string;
  params: readonly unknown[];
}

function makeRecordingPool(rows: ReadonlyArray<Record<string, unknown>>) {
  const calls: RecordedQuery[] = [];
  const pool = {
    query: async (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      return { rows };
    },
    connect: async () => {
      throw new Error("connect() must never be called for a single-statement operation");
    },
  };
  return { pool, calls };
}

/** A canonical `pw_feature_balances` row shape, with BIGINT columns returned
 * as `pg`-style strings (the real driver's default `int8` behavior) to
 * exercise `./rows.ts`'s bigint-string parsing. */
function canonicalBalanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pwv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    customer_id: "pwv_customer",
    feature_id: "messages",
    group: "base",
    used: "1", // BIGINT returned as string by pg
    limit: "100", // BIGINT returned as string by pg
    reset_interval: "month",
    anchor: new Date("2026-01-15T12:00:00.000Z"),
    period_start: new Date("2026-01-15T12:00:00.000Z"),
    period_end: new Date("2026-02-15T12:00:00.000Z"),
    plan_id: "free",
    plan_version: 1,
    updated_at: new Date("2026-01-15T13:00:00.000Z"),
    applied: true,
    ...overrides,
  };
}

describe("balances.consume — single round trip, proven against a recording mock pool", () => {
  it("sends exactly ONE query and maps BIGINT-as-string columns correctly", async () => {
    const { pool, calls } = makeRecordingPool([canonicalBalanceRow()]);
    const adapter = postgresAdapter(pool as never);
    const result = await adapter.balances.consume({
      customerId: "pwv_customer",
      featureId: "messages",
      group: "base",
      amount: 1,
      conditional: true,
      init: SAMPLE_INIT,
      now: new Date("2026-01-15T13:00:00.000Z"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("FOR UPDATE");
    expect(result.applied).toBe(true);
    expect(result.used).toBe(1); // parsed from the "1" bigint-string
    expect(result.limit).toBe(100);
  });

  it("derives applied: false from the RETURNING row, no second query", async () => {
    const { pool, calls } = makeRecordingPool([canonicalBalanceRow({ applied: false, used: "5" })]);
    const adapter = postgresAdapter(pool as never);
    const result = await adapter.balances.consume({
      customerId: "pwv_customer",
      featureId: "messages",
      group: "base",
      amount: 10,
      conditional: true,
      init: SAMPLE_INIT,
      now: new Date("2026-01-15T13:00:00.000Z"),
    });
    expect(calls).toHaveLength(1);
    expect(result.applied).toBe(false);
    expect(result.used).toBe(5);
  });
});

describe("webhookEvents.claim — single round trip, proven against a recording mock pool", () => {
  it("sends exactly ONE query; a returned row means the caller won", async () => {
    const { pool, calls } = makeRecordingPool([{ dedupe_key: "evt_1" }]);
    const adapter = postgresAdapter(pool as never);
    const won = await adapter.webhookEvents.claim("evt_1", {
      provider: "stripe",
      type: "x",
      now: new Date(),
    });
    expect(calls).toHaveLength(1);
    expect(won).toBe(true);
  });

  it("zero returned rows means the caller lost — no second query to check why", async () => {
    const { pool, calls } = makeRecordingPool([]);
    const adapter = postgresAdapter(pool as never);
    const won = await adapter.webhookEvents.claim("evt_1", {
      provider: "stripe",
      type: "x",
      now: new Date(),
    });
    expect(calls).toHaveLength(1);
    expect(won).toBe(false);
  });
});

// ── transaction() — BEGIN/COMMIT/ROLLBACK sequencing + always-release ──────

describe("transaction() — dedicated client, BEGIN/COMMIT/ROLLBACK, always released", () => {
  function makeTransactionPool() {
    const clientCalls: string[] = [];
    let released = false;
    const client = {
      query: async (text: string) => {
        clientCalls.push(text);
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    };
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    };
    return { pool, clientCalls, isReleased: () => released };
  }

  it("commits on success and releases the client", async () => {
    const { pool, clientCalls, isReleased } = makeTransactionPool();
    const adapter = postgresAdapter(pool as never);
    const result = await adapter.transaction(async () => 42);
    expect(result).toBe(42);
    expect(clientCalls).toEqual(["BEGIN", "COMMIT"]);
    expect(isReleased()).toBe(true);
  });

  it("rolls back on throw and still releases the client", async () => {
    const { pool, clientCalls, isReleased } = makeTransactionPool();
    const adapter = postgresAdapter(pool as never);
    const boom = new Error("apply failed");
    await expect(
      adapter.transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(clientCalls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(isReleased()).toBe(true);
  });

  it("a transaction callback's own transaction() call is a reentrant passthrough (no nested BEGIN)", async () => {
    const { pool, clientCalls } = makeTransactionPool();
    const adapter = postgresAdapter(pool as never);
    await adapter.transaction(async (tx) => {
      await tx.transaction(async () => undefined);
    });
    expect(clientCalls).toEqual(["BEGIN", "COMMIT"]);
  });
});

// ── PostgresMigrationExecutor — $n-placeholder SQL, verified against a fake ledger ──

describe("PostgresMigrationExecutor", () => {
  it("query() is a thin pass-through to the runner", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const runner: Runner = {
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
      transaction: async (fn) => fn(runner),
    };
    const executor = new PostgresMigrationExecutor(runner);
    await executor.query("SELECT 1", [1, 2]);
    expect(calls).toEqual([{ sql: "SELECT 1", params: [1, 2] }]);
  });

  it("applyMigrations issues the ledger insert with $1, $2, $3 placeholders and a Date bind for applied_at", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    let ledgerRows: Array<{ name: string; checksum: string }> = [];
    const runner: Runner = {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/^CREATE TABLE IF NOT EXISTS pw_migrations/.test(sql)) return { rows: [] };
        if (/^SELECT name, checksum FROM pw_migrations/.test(sql)) return { rows: ledgerRows };
        if (/^INSERT INTO pw_migrations/.test(sql)) {
          ledgerRows = [...ledgerRows, { name: String(params[0]), checksum: String(params[2]) }];
          return { rows: [] };
        }
        // The postgres 0001_init DDL statements themselves — accept unconditionally.
        return { rows: [] };
      },
      transaction: async (fn) => fn(runner),
    };
    const executor = new PostgresMigrationExecutor(runner);
    const result = await applyMigrations(executor as unknown as MigrationExecutor, "postgres");
    expect(result.applied).toEqual(["0001_init"]);

    const insertCall = queries.find((q) => /^INSERT INTO pw_migrations/.test(q.sql));
    expect(insertCall).toBeDefined();
    expect(insertCall?.sql).toMatch(/VALUES \(\$1, \$2, \$3\)/);
    expect(insertCall?.params[0]).toBe("0001_init");
    expect(insertCall?.params[1]).toBeInstanceOf(Date); // applied_at — postgres binds a Date, not epoch ms
    expect(typeof insertCall?.params[2]).toBe("string"); // checksum

    // Re-running against the now-populated ledger reports nothing pending.
    const status = await planMigrations(executor as unknown as MigrationExecutor, "postgres");
    expect(status.pending).toEqual([]);
    expect(status.applied).toEqual(["0001_init"]);
  });
});

// ── Period math parity — JS mirror of ./period-sql.ts's exact CASE formula
// vs. src/products/period.ts's currentPeriod (the shipped oracle, PW-901).
// This is the strongest confidence available without a live postgres: it
// proves the SQL's ALGORITHM (not its postgres-dialect execution) reproduces
// the oracle exactly, across the same edge cases the conformance suite's
// boundary tests exercise. ───────────────────────────────────────────────────

/** `daysInMonthSql(year, month1)`: last day of `month1` (1-based) in `year` —
 * mirrors `make_date(year, month, 1) + INTERVAL '1 month - 1 day'`. */
function daysInMonthSql(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Mirrors `./period-sql.ts`'s `clampedMonthAddExpr` operation-for-operation. */
function clampedMonthAddSql(anchorMs: number, totalMonths: number): number {
  const anchor = new Date(anchorMs);
  const anchorYear = anchor.getUTCFullYear();
  const anchorMonth1 = anchor.getUTCMonth() + 1; // EXTRACT(MONTH) is 1-based
  const anchorDay = anchor.getUTCDate();
  const rawMonths = anchorMonth1 - 1 + totalMonths;
  const year = anchorYear + Math.floor(rawMonths / 12);
  const monthIndex = ((rawMonths % 12) + 12) % 12; // MOD(MOD(x,12)+12,12)
  const month1 = monthIndex + 1;
  const day = Math.min(anchorDay, daysInMonthSql(year, month1));
  return Date.UTC(
    year,
    month1 - 1,
    day,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

/** Mirrors `./period-sql.ts`'s `advanceExpr`. */
function advanceSql(anchorMs: number, reset: ResetInterval, n: number): number {
  switch (reset) {
    case "day":
      return anchorMs + n * 86_400_000;
    case "week":
      return anchorMs + n * 604_800_000;
    case "month":
      return clampedMonthAddSql(anchorMs, n * 1);
    case "year":
      return clampedMonthAddSql(anchorMs, n * 12);
  }
}

/** Mirrors `./period-sql.ts`'s `estimateExpr`. */
function estimateSql(anchorMs: number, reset: ResetInterval, nowMs: number): number {
  const diffMs = Math.round(nowMs - anchorMs);
  const anchor = new Date(anchorMs);
  const now = new Date(nowMs);
  const monthDiff =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  switch (reset) {
    case "day":
      return Math.floor(diffMs / 86_400_000);
    case "week":
      return Math.floor(diffMs / 604_800_000);
    case "month":
      return Math.floor(monthDiff / 1);
    case "year":
      return Math.floor(monthDiff / 12);
  }
}

/** Mirrors `buildPeriodMathSql`'s four-candidate unroll exactly. */
function periodMathSqlMirror(
  anchorMs: number,
  reset: ResetInterval,
  nowMs: number,
): { start: number; end: number } {
  const estimate = estimateSql(anchorMs, reset, nowMs);
  const index0 = Math.max(0, estimate - 1);
  const adv = (offset: number): number => advanceSql(anchorMs, reset, index0 + offset);
  const adv0 = adv(0);
  const adv1 = adv(1);
  const adv2 = adv(2);
  const adv3 = adv(3);
  const increments = nowMs < adv1 ? 0 : nowMs < adv2 ? 1 : 2;
  const start = increments === 0 ? adv0 : increments === 1 ? adv1 : adv2;
  const end = increments === 0 ? adv1 : increments === 1 ? adv2 : adv3;
  return { start, end };
}

describe("period-sql.ts parity vs. src/products/period.ts's currentPeriod (structural proof, no live DB)", () => {
  function expectParity(anchorMs: number, reset: ResetInterval, nowMs: number): void {
    const oracle = currentPeriod(anchorMs, reset, nowMs);
    const mirror = periodMathSqlMirror(anchorMs, reset, nowMs);
    expect(mirror.start, `start mismatch for reset=${reset} anchor=${new Date(anchorMs).toISOString()} now=${new Date(nowMs).toISOString()}`).toBe(oracle.start);
    expect(mirror.end, `end mismatch for reset=${reset} anchor=${new Date(anchorMs).toISOString()} now=${new Date(nowMs).toISOString()}`).toBe(oracle.end);
  }

  it("day/week: dense sweep across many periods", () => {
    const anchor = Date.UTC(2026, 0, 15, 12, 0, 0);
    for (const reset of ["day", "week"] as const) {
      const stepMs = reset === "day" ? 86_400_000 : 604_800_000;
      for (let i = -3; i <= 20; i++) {
        // A few offsets around each boundary: just before, exactly at, just after.
        for (const delta of [-1, 0, 1, Math.floor(stepMs / 2)]) {
          expectParity(anchor, reset, anchor + i * stepMs + delta);
        }
      }
    }
  });

  it("month: mid-month anchor, dense sweep including idle multi-period jumps", () => {
    const anchor = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00Z
    for (let months = -2; months <= 30; months++) {
      const boundary = new Date(anchor);
      // A representative "now" a bit into period `months` — cheap and covers
      // the idle-multi-period-jump case (metered-usage.md §5) via large `months`.
      const probe = clampedMonthAddSql(anchor, months) + 3_600_000; // +1h into the period
      void boundary;
      expectParity(anchor, "month", probe);
      expectParity(anchor, "month", clampedMonthAddSql(anchor, months)); // exactly at a boundary
      expectParity(anchor, "month", clampedMonthAddSql(anchor, months) - 1); // just before
    }
  });

  it("month: end-of-month anchor clamps without drift (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 ...)", () => {
    const anchor = Date.UTC(2026, 0, 31, 0, 0, 0); // 2026-01-31
    // Hard-coded oracle boundaries — iterating on a clamped output would give
    // Feb 28 -> Mar 28 (drift); the correct sequence re-anchors every time.
    const expected = [
      Date.UTC(2026, 0, 31),
      Date.UTC(2026, 1, 28), // 2026 is not a leap year
      Date.UTC(2026, 2, 31),
      Date.UTC(2026, 3, 30),
      Date.UTC(2026, 4, 31),
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(clampedMonthAddSql(anchor, i)).toBe(expected[i]);
    }
    for (let months = 0; months <= 12; months++) {
      expectParity(anchor, "month", clampedMonthAddSql(anchor, months) + 3_600_000);
    }
  });

  it("month: leap-year Feb 29 anchor advanced by whole years", () => {
    const anchor = Date.UTC(2024, 1, 29, 6, 0, 0); // 2024-02-29 (leap year)
    expect(clampedMonthAddSql(anchor, 12)).toBe(Date.UTC(2025, 1, 28, 6, 0, 0)); // clamps in a non-leap year
    expect(clampedMonthAddSql(anchor, 48)).toBe(Date.UTC(2028, 1, 29, 6, 0, 0)); // lands on Feb 29 again
    for (const years of [0, 1, 2, 4]) {
      expectParity(anchor, "year", clampedMonthAddSql(anchor, years * 12) + 3_600_000);
    }
  });

  it("year: dense sweep", () => {
    const anchor = Date.UTC(2020, 5, 15, 8, 30, 0);
    for (let years = -1; years <= 8; years++) {
      const boundary = clampedMonthAddSql(anchor, years * 12);
      expectParity(anchor, "year", boundary);
      expectParity(anchor, "year", boundary - 1);
      expectParity(anchor, "year", boundary + 86_400_000);
    }
  });

  it("now before the anchor clamps to period 0 (clock skew — same conservative behavior as period.ts)", () => {
    const anchor = Date.UTC(2026, 5, 1, 0, 0, 0);
    for (const reset of ["day", "week", "month", "year"] as const) {
      expectParity(anchor, reset, anchor - 3_600_000);
      expectParity(anchor, reset, anchor - 30 * 86_400_000);
    }
  });

  it("matches buildPeriodMathSql's actual generated SQL text shape (sanity: it references e.anchor/e.reset_interval, not init.*)", () => {
    const { periodStart, periodEnd } = buildPeriodMathSql("e.anchor", "e.reset_interval", "$5::timestamptz");
    expect(periodStart).toContain("e.anchor");
    expect(periodStart).toContain("e.reset_interval");
    expect(periodEnd).toContain("e.anchor");
    // Uses the CALLER-injected `now` parameter, never `now()`/`CURRENT_TIMESTAMP`
    // (database.md §3 — the suite drives time through the parameter).
    expect(periodStart + periodEnd).not.toMatch(/\bnow\(\)|\bCURRENT_TIMESTAMP\b/i);
  });
});

// ── Bundle isolation (spot check; PW-710 owns the formal gate) ─────────────

describe("payweave root never touches the postgres adapter", () => {
  it("importing payweave's root barrel does not import src/db/postgres/* or 'pg'", async () => {
    const rootSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/index.ts", import.meta.url), "utf8"),
    );
    expect(rootSrc).not.toMatch(/db\/postgres/);
    expect(rootSrc).not.toMatch(/from ["']pg["']/);
  });
});

// ── ULID id generation (self-contained copy — see ./id.ts's header) ────────

describe("generatePwId", () => {
  it("matches the pwIdSchema shape (pwv_ + 26-char Crockford Base32)", () => {
    expect(() => pwIdSchema.parse(generatePwId())).not.toThrow();
  });

  it("is unique across a burst of calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generatePwId()));
    expect(ids.size).toBe(500);
  });
});
