/**
 * embedded SQL migrations engine (docs/v1/database.md §4).
 *
 * Everything runs against a scripted fake executor (records every SQL call,
 * maintains an in-memory `pw_migrations` ledger) — no docker; real-database
 * DDL validation rides the PW-704/705/706 conformance legs.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PayweaveError } from "../../src/core/errors";
import type { PwMigrationApplyResult, PwMigrationStatus } from "../../src/db/index";
import {
  applyMigrations,
  ledgerEnsureSql,
  migrationChecksum,
  migrationsFor,
  MYSQL_INIT_STATEMENTS,
  PayweaveMigrationError,
  PayweaveMigrationHistoryError,
  planMigrations,
  POSTGRES_INIT_STATEMENTS,
  PW_MIGRATION_IDS,
  PW_SQL_DIALECTS,
  SQLITE_INIT_STATEMENTS,
  type MigrationExecutor,
  type MigrationQueryResult,
  type PwSqlDialect,
  type PwSqlMigration,
} from "../../src/db/migrations/index";
import {
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  PW_TABLES,
  pwCustomerSchema,
  pwFeatureBalanceSchema,
  pwMigrationRecordSchema,
  pwPlanVersionSchema,
  pwSubscriptionSchema,
  pwWebhookEventSchema,
} from "../../src/db/schema";

// ── Scripted fake executor ───────────────────────────────────────────────────

interface RecordedCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

/** Records SQL and keeps an in-memory `pw_migrations` ledger. */
class FakeExecutor implements MigrationExecutor {
  readonly calls: RecordedCall[] = [];
  readonly ledger = new Map<string, { appliedAt: unknown; checksum: string }>();
  /** When set, `query` throws for any statement this predicate matches. */
  failOn: ((sql: string) => boolean) | undefined;

  async query(sql: string, params?: readonly unknown[]): Promise<MigrationQueryResult> {
    this.calls.push({ sql, params });
    if (this.failOn?.(sql)) throw new Error(`fake driver failure on: ${sql.slice(0, 40)}`);
    if (sql.startsWith("SELECT name, checksum FROM pw_migrations")) {
      return {
        rows: [...this.ledger.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, row]) => ({ name, checksum: row.checksum })),
      };
    }
    if (sql.startsWith("INSERT INTO pw_migrations")) {
      const [name, appliedAt, checksum] = params ?? [];
      this.ledger.set(String(name), { appliedAt, checksum: String(checksum) });
    }
    return { rows: [] };
  }

  seed(name: string, checksum: string): void {
    this.ledger.set(name, { appliedAt: new Date(0), checksum });
  }

  sqlCalls(): string[] {
    return this.calls.map((c) => c.sql);
  }
}

/** FakeExecutor + a transactional wrapper with snapshot/rollback semantics. */
class TxFakeExecutor extends FakeExecutor {
  readonly txEvents: string[] = [];

  async transaction<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
    this.txEvents.push("begin");
    const snapshot = new Map(this.ledger);
    try {
      const result = await fn(this);
      this.txEvents.push("commit");
      return result;
    } catch (error) {
      this.ledger.clear();
      for (const [key, value] of snapshot) this.ledger.set(key, value);
      this.txEvents.push("rollback");
      throw error;
    }
  }
}

const syntheticMigration = (id: string, ...statements: string[]): PwSqlMigration => ({
  id,
  name: id.replace(/^\d+_/, ""),
  statements,
});

const DIALECT_STATEMENTS: Record<PwSqlDialect, readonly string[]> = {
  postgres: POSTGRES_INIT_STATEMENTS,
  mysql: MYSQL_INIT_STATEMENTS,
  sqlite: SQLITE_INIT_STATEMENTS,
};

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const ACTIVE_LIST = PW_ACTIVE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(", ");

// ── Embedded definitions ─────────────────────────────────────────────────────

describe("migrationsFor", () => {
  for (const dialect of PW_SQL_DIALECTS) {
    it(`${dialect}: returns the ordered embedded list (ids = PW_MIGRATION_IDS), frozen`, () => {
      const migrations = migrationsFor(dialect);
      expect(migrations.map((m) => m.id)).toEqual([...PW_MIGRATION_IDS]);
      expect(migrations.map((m) => m.name)).toEqual(["init"]);
      expect(migrations[0]?.statements).toEqual(DIALECT_STATEMENTS[dialect]);
      expect(Object.isFrozen(migrations)).toBe(true);
      expect(Object.isFrozen(migrations[0])).toBe(true);
      expect(Object.isFrozen(migrations[0]?.statements)).toBe(true);
    });

    it(`${dialect}: is pure — repeated calls return the same list`, () => {
      expect(migrationsFor(dialect)).toBe(migrationsFor(dialect));
    });
  }

  it("ids are lexicographically sorted (filename ordering contract)", () => {
    const ids = [...PW_MIGRATION_IDS];
    expect(ids).toEqual([...ids].sort());
  });

  it("throws PayweaveMigrationError for non-SQL dialects (mongodb has no SQL migrations)", () => {
    expect(() => migrationsFor("mongodb" as unknown as PwSqlDialect)).toThrowError(
      PayweaveMigrationError,
    );
    expect(() => migrationsFor("mongodb" as unknown as PwSqlDialect)).toThrowError(
      /mongodb\/prisma\/drizzle have no Payweave-owned SQL migrations/,
    );
  });
});

// ── 0001_init DDL per dialect ────────────────────────────────────────────────

describe("0001_init DDL", () => {
  for (const dialect of PW_SQL_DIALECTS) {
    const statements = DIALECT_STATEMENTS[dialect];
    const joined = statements.join("\n\n");

    describe(dialect, () => {
      it("matches the committed snapshot (any diff = a new migration, not an edit)", () => {
        expect(joined).toMatchSnapshot();
      });

      it("starts with the pw_migrations ledger bootstrap, verbatim", () => {
        expect(statements[0]).toBe(ledgerEnsureSql(dialect));
        expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS pw_migrations");
      });

      it("creates every §2 table", () => {
        for (const table of Object.values(PW_TABLES)) {
          expect(joined).toContain(`CREATE TABLE${table === PW_TABLES.migrations ? " IF NOT EXISTS" : ""} ${table} (`);
        }
      });

      it("contains every row-schema column (camelCase → snake_case)", () => {
        const shapes = [
          pwCustomerSchema.shape,
          pwPlanVersionSchema.shape,
          pwSubscriptionSchema.shape,
          pwFeatureBalanceSchema.shape,
          pwWebhookEventSchema.shape,
          pwMigrationRecordSchema.shape,
        ];
        for (const shape of shapes) {
          for (const key of Object.keys(shape)) {
            expect(joined).toContain(camelToSnake(key));
          }
        }
      });

      it("contains no float/decimal column type — money is integer minor units", () => {
        expect(joined).not.toMatch(/\b(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)\b/i);
      });

      it("declares the uniqueness rules of §2", () => {
        expect(joined).toContain("pw_customers_external_id_uq UNIQUE (external_id)");
        expect(joined).toContain("pw_plans_plan_id_version_uq UNIQUE (plan_id, version)");
        expect(joined).toMatch(
          /pw_feature_balances_customer_feature_group_uq UNIQUE \(customer_id, feature_id, ["`]group["`]\)/,
        );
      });
    });
  }

  it("postgres: native partial unique index on the active-subscription set", () => {
    const index = POSTGRES_INIT_STATEMENTS.find((s) =>
      s.startsWith("CREATE UNIQUE INDEX pw_subscriptions_active_uq"),
    );
    expect(index).toBeDefined();
    expect(index).toContain(`ON pw_subscriptions (customer_id, "group")`);
    expect(index).toContain(`WHERE status IN (${ACTIVE_LIST})`);
    // No emulation column on dialects with real partial indexes.
    expect(POSTGRES_INIT_STATEMENTS.join("\n")).not.toContain("active_slot");
  });

  it("sqlite: native partial unique index on the active-subscription set", () => {
    const index = SQLITE_INIT_STATEMENTS.find((s) =>
      s.startsWith("CREATE UNIQUE INDEX pw_subscriptions_active_uq"),
    );
    expect(index).toBeDefined();
    expect(index).toContain(`ON pw_subscriptions (customer_id, "group")`);
    expect(index).toContain(`WHERE status IN (${ACTIVE_LIST})`);
    expect(SQLITE_INIT_STATEMENTS.join("\n")).not.toContain("active_slot");
  });

  it("mysql: emulates the partial unique index via STORED generated column + unique key", () => {
    const table = MYSQL_INIT_STATEMENTS.find((s) => s.startsWith("CREATE TABLE pw_subscriptions"));
    expect(table).toBeDefined();
    expect(table).toContain("active_slot CHAR(1) GENERATED ALWAYS AS (");
    expect(table).toContain(`CASE WHEN status IN (${ACTIVE_LIST}) THEN 'x' ELSE NULL END`);
    expect(table).toContain(") STORED");
    expect(table).toContain(
      "CONSTRAINT pw_subscriptions_active_uq UNIQUE (customer_id, `group`, active_slot)",
    );
    // MySQL has no partial indexes — there must be no WHERE-qualified index.
    expect(MYSQL_INIT_STATEMENTS.join("\n")).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*WHERE/);
  });

  it("maps logical types per dialect (timestamps/JSON/booleans)", () => {
    const pg = POSTGRES_INIT_STATEMENTS.join("\n");
    expect(pg).toContain("provider_ids JSONB NOT NULL");
    expect(pg).toContain("anchor TIMESTAMPTZ NOT NULL");
    expect(pg).toContain("is_default BOOLEAN NOT NULL");
    expect(pg).toContain("price_minor BIGINT");

    const my = MYSQL_INIT_STATEMENTS.join("\n");
    expect(my).toContain("provider_ids JSON NOT NULL");
    expect(my).toContain("anchor DATETIME(3) NOT NULL");
    expect(my).toContain("is_default TINYINT(1) NOT NULL");
    expect(my).toContain("price_minor BIGINT NULL");
    expect(my).toContain("COLLATE=utf8mb4_bin");

    const lite = SQLITE_INIT_STATEMENTS.join("\n");
    expect(lite).toContain("provider_ids TEXT NOT NULL");
    expect(lite).toContain("anchor INTEGER NOT NULL");
    expect(lite).toContain("is_default INTEGER NOT NULL CHECK (is_default IN (0, 1))");
    expect(lite).toContain("cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1))");
  });

  it("quotes the reserved-word columns group/limit per dialect", () => {
    expect(POSTGRES_INIT_STATEMENTS.join("\n")).toContain(`"limit" BIGINT NOT NULL`);
    expect(MYSQL_INIT_STATEMENTS.join("\n")).toContain("`limit` BIGINT NOT NULL");
    expect(SQLITE_INIT_STATEMENTS.join("\n")).toContain(`"limit" INTEGER NOT NULL`);
  });
});

// ── Checksums ────────────────────────────────────────────────────────────────

describe("migrationChecksum", () => {
  it("is stable: same input → same hash across runs, sha256:<64 hex>", () => {
    for (const dialect of PW_SQL_DIALECTS) {
      const [migration] = migrationsFor(dialect);
      const first = migrationChecksum(migration!);
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(migrationChecksum(migration!)).toBe(first);
      expect(migrationChecksum({ statements: [...migration!.statements] })).toBe(first);
    }
  });

  it("implements the documented scheme: SHA-256 over UTF-8 statement bytes, NUL-terminated each", () => {
    // Independently rebuilt from raw bytes: "a" NUL "b" NUL.
    const expected = createHash("sha256")
      .update(Buffer.from([0x61, 0x00, 0x62, 0x00]))
      .digest("hex");
    expect(migrationChecksum({ statements: ["a", "b"] })).toBe(`sha256:${expected}`);
  });

  it("statement boundaries are part of the content", () => {
    expect(migrationChecksum({ statements: ["ab"] })).not.toBe(
      migrationChecksum({ statements: ["a", "b"] }),
    );
    expect(migrationChecksum({ statements: ["a b"] })).not.toBe(
      migrationChecksum({ statements: ["a", "b"] }),
    );
  });

  it("no normalization: a whitespace edit is a content change", () => {
    expect(migrationChecksum({ statements: ["SELECT 1"] })).not.toBe(
      migrationChecksum({ statements: ["SELECT  1"] }),
    );
  });

  it("checksums differ per dialect (statement text differs)", () => {
    const [pg] = migrationsFor("postgres");
    const [my] = migrationsFor("mysql");
    const [lite] = migrationsFor("sqlite");
    expect(new Set([migrationChecksum(pg!), migrationChecksum(my!), migrationChecksum(lite!)]).size).toBe(3);
  });
});

// ── plan ─────────────────────────────────────────────────────────────────────

describe("planMigrations", () => {
  it("fresh database: bootstraps the ledger, reads it, reports everything pending", async () => {
    const executor = new FakeExecutor();
    const status: PwMigrationStatus = await planMigrations(executor, "postgres");
    expect(status).toEqual({ pending: ["0001_init"], applied: [] });
    expect(executor.sqlCalls()).toEqual([
      ledgerEnsureSql("postgres"),
      "SELECT name, checksum FROM pw_migrations ORDER BY name",
    ]);
  });

  it("fully applied ledger (matching checksum): nothing pending", async () => {
    const executor = new FakeExecutor();
    const [migration] = migrationsFor("sqlite");
    executor.seed("0001_init", migrationChecksum(migration!));
    await expect(planMigrations(executor, "sqlite")).resolves.toEqual({
      pending: [],
      applied: ["0001_init"],
    });
  });

  it("partial ledger: only the tail is pending, in id order, even from unsorted input", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)");
    const two = syntheticMigration("0002_two", "CREATE TABLE t2 (id TEXT)");
    const three = syntheticMigration("0003_three", "CREATE TABLE t3 (id TEXT)");
    const executor = new FakeExecutor();
    executor.seed(one.id, migrationChecksum(one));
    await expect(
      planMigrations(executor, "sqlite", [three, one, two]), // deliberately unsorted
    ).resolves.toEqual({ pending: ["0002_two", "0003_three"], applied: ["0001_one"] });
  });

  it("ledger gap: an unapplied migration ordered before an applied one is reported pending", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)");
    const two = syntheticMigration("0002_two", "CREATE TABLE t2 (id TEXT)");
    const executor = new FakeExecutor();
    executor.seed(two.id, migrationChecksum(two));
    await expect(planMigrations(executor, "sqlite", [one, two])).resolves.toEqual({
      pending: ["0001_one"],
      applied: ["0002_two"],
    });
  });

  it("mutated history: checksum mismatch throws PayweaveMigrationHistoryError with the exact message", async () => {
    const executor = new FakeExecutor();
    const [migration] = migrationsFor("postgres");
    const expected = migrationChecksum(migration!);
    executor.seed("0001_init", "sha256:tampered");

    const error = await planMigrations(executor, "postgres").then(
      () => {
        throw new Error("expected planMigrations to reject");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PayweaveMigrationHistoryError);
    expect(error).toBeInstanceOf(PayweaveMigrationError);
    expect(error).toBeInstanceOf(PayweaveError);
    const history = error as PayweaveMigrationHistoryError;
    expect(history.name).toBe("PayweaveMigrationHistoryError");
    expect(history.migrationId).toBe("0001_init");
    expect(history.reason).toBe("checksum-mismatch");
    expect(history.isRetryable).toBe(false);
    expect(history.toJSON()).toMatchObject({
      name: "PayweaveMigrationHistoryError",
      migrationId: "0001_init",
      reason: "checksum-mismatch",
    });
    expect(history.message).toBe(
      `Payweave migration "0001_init" was modified after it was applied: ledger checksum ` +
        `sha256:tampered does not match this build's checksum ${expected}. Applied migrations are ` +
        `immutable — NEVER edit an applied migration; ship the change as a new migration ` +
        `instead (forward-only, docs/v1/database.md §4).`,
    );
  });

  it("unknown ledger row: throws PayweaveMigrationHistoryError with the exact message", async () => {
    const executor = new FakeExecutor();
    executor.seed("0000_ghost", "sha256:whatever");

    const error = await planMigrations(executor, "mysql").then(
      () => {
        throw new Error("expected planMigrations to reject");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PayweaveMigrationHistoryError);
    const history = error as PayweaveMigrationHistoryError;
    expect(history.migrationId).toBe("0000_ghost");
    expect(history.reason).toBe("unknown-migration");
    expect(history.message).toBe(
      `Payweave migration history mismatch: the pw_migrations ledger contains "0000_ghost", ` +
        `which is not among the migrations embedded in this build. Refusing to plan or apply ` +
        `against an unknown migration history — this usually means the database was migrated ` +
        `by a newer Payweave version, or the ledger was edited by hand (docs/v1/database.md §4).`,
    );
  });

  it("malformed ledger rows fail loudly instead of being skipped", async () => {
    const executor: MigrationExecutor = {
      query: async (sql: string) => ({
        rows: sql.startsWith("SELECT") ? [{ name: 42, checksum: "sha256:x" }] : [],
      }),
    };
    await expect(planMigrations(executor, "postgres")).rejects.toThrowError(
      /malformed row .*"name" and "checksum"/,
    );
  });

  it("rejects a malformed embedded set: duplicate ids", async () => {
    const dup = syntheticMigration("0001_one", "CREATE TABLE t (id TEXT)");
    await expect(planMigrations(new FakeExecutor(), "sqlite", [dup, dup])).rejects.toThrowError(
      /duplicate migration id "0001_one"/,
    );
  });

  it("rejects a malformed embedded set: empty or blank statements", async () => {
    const empty: PwSqlMigration = { id: "0001_e", name: "e", statements: [] };
    const blank = syntheticMigration("0002_b", "   ");
    await expect(planMigrations(new FakeExecutor(), "sqlite", [empty])).rejects.toThrowError(
      /empty statement list or a blank statement/,
    );
    await expect(planMigrations(new FakeExecutor(), "sqlite", [blank])).rejects.toThrowError(
      /empty statement list or a blank statement/,
    );
  });
});

// ── apply ────────────────────────────────────────────────────────────────────

describe("applyMigrations", () => {
  for (const dialect of PW_SQL_DIALECTS) {
    it(`${dialect}: fresh apply runs every statement in order, then writes the ledger row`, async () => {
      const executor = new FakeExecutor();
      const result: PwMigrationApplyResult = await applyMigrations(executor, dialect);
      expect(result).toEqual({ applied: ["0001_init"] });

      const statements = DIALECT_STATEMENTS[dialect];
      expect(executor.sqlCalls()).toEqual([
        ledgerEnsureSql(dialect),
        "SELECT name, checksum FROM pw_migrations ORDER BY name",
        ...statements,
        expect.stringContaining("INSERT INTO pw_migrations (name, applied_at, checksum) VALUES ("),
      ]);

      // Ledger row: id + content checksum + applied_at.
      const [migration] = migrationsFor(dialect);
      const row = executor.ledger.get("0001_init");
      expect(row?.checksum).toBe(migrationChecksum(migration!));
      const insert = executor.calls.at(-1);
      expect(insert?.params?.[0]).toBe("0001_init");
      expect(insert?.params?.[2]).toBe(migrationChecksum(migration!));
      if (dialect === "sqlite") {
        expect(typeof insert?.params?.[1]).toBe("number"); // epoch ms
      } else {
        expect(insert?.params?.[1]).toBeInstanceOf(Date);
      }
    });
  }

  it("emits dialect-appropriate ledger-insert placeholders ($1… vs ?)", async () => {
    for (const [dialect, marker] of [
      ["postgres", "VALUES ($1, $2, $3)"],
      ["mysql", "VALUES (?, ?, ?)"],
      ["sqlite", "VALUES (?, ?, ?)"],
    ] as const) {
      const executor = new FakeExecutor();
      await applyMigrations(executor, dialect);
      expect(executor.calls.at(-1)?.sql).toContain(marker);
    }
  });

  it("second apply is a no-op: nothing applied, no DDL re-executed", async () => {
    const executor = new FakeExecutor();
    await applyMigrations(executor, "postgres");
    executor.calls.length = 0;

    await expect(applyMigrations(executor, "postgres")).resolves.toEqual({ applied: [] });
    expect(executor.sqlCalls()).toEqual([
      ledgerEnsureSql("postgres"),
      "SELECT name, checksum FROM pw_migrations ORDER BY name",
    ]);
  });

  it("partial ledger: applies only the pending tail", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)");
    const two = syntheticMigration("0002_two", "CREATE TABLE t2 (id TEXT)", "CREATE INDEX i2 ON t2 (id)");
    const executor = new FakeExecutor();
    executor.seed(one.id, migrationChecksum(one));

    await expect(applyMigrations(executor, "sqlite", [one, two])).resolves.toEqual({
      applied: ["0002_two"],
    });
    const sql = executor.sqlCalls();
    expect(sql).toContain("CREATE TABLE t2 (id TEXT)");
    expect(sql).toContain("CREATE INDEX i2 ON t2 (id)");
    expect(sql).not.toContain("CREATE TABLE t1 (id TEXT)");
    expect(executor.ledger.has("0002_two")).toBe(true);
  });

  it("mutated history: apply throws the same loud error and executes NO migration DDL", async () => {
    const executor = new FakeExecutor();
    executor.seed("0001_init", "sha256:tampered");

    await expect(applyMigrations(executor, "sqlite")).rejects.toThrowError(
      PayweaveMigrationHistoryError,
    );
    // Only the ledger bootstrap + read ran — verification comes first.
    expect(executor.sqlCalls()).toEqual([
      ledgerEnsureSql("sqlite"),
      "SELECT name, checksum FROM pw_migrations ORDER BY name",
    ]);
  });

  it("unknown ledger row: apply refuses to continue", async () => {
    const executor = new FakeExecutor();
    executor.seed("9999_from_the_future", "sha256:whatever");
    await expect(applyMigrations(executor, "postgres")).rejects.toMatchObject({
      name: "PayweaveMigrationHistoryError",
      migrationId: "9999_from_the_future",
      reason: "unknown-migration",
    });
  });

  it("uses the executor's transaction wrapper: one transaction per migration", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)");
    const two = syntheticMigration("0002_two", "CREATE TABLE t2 (id TEXT)");
    const executor = new TxFakeExecutor();

    await expect(applyMigrations(executor, "sqlite", [one, two])).resolves.toEqual({
      applied: ["0001_one", "0002_two"],
    });
    expect(executor.txEvents).toEqual(["begin", "commit", "begin", "commit"]);
    // The ledger insert happens INSIDE the migration's transaction.
    expect(executor.ledger.has("0001_one")).toBe(true);
    expect(executor.ledger.has("0002_two")).toBe(true);
  });

  it("statement failure: wraps the driver error, rolls back, earlier migrations stay applied", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)");
    const two = syntheticMigration("0002_two", "CREATE TABLE t2 (id TEXT)");
    const executor = new TxFakeExecutor();
    executor.failOn = (sql) => sql === "CREATE TABLE t2 (id TEXT)";

    const error = await applyMigrations(executor, "sqlite", [one, two]).then(
      () => {
        throw new Error("expected applyMigrations to reject");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PayweaveMigrationError);
    const wrapped = error as PayweaveMigrationError;
    expect(wrapped.message).toBe(`Payweave migration "0002_two" failed at statement 1 of 1.`);
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect((wrapped.cause as Error).message).toContain("fake driver failure");
    // First migration committed; failing one rolled back, never recorded.
    expect(executor.txEvents).toEqual(["begin", "commit", "begin", "rollback"]);
    expect(executor.ledger.has("0001_one")).toBe(true);
    expect(executor.ledger.has("0002_two")).toBe(false);
  });

  it("statement failure without a transaction wrapper surfaces immediately, ledger unchanged", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)", "CREATE INDEX i1 ON t1 (id)");
    const executor = new FakeExecutor();
    executor.failOn = (sql) => sql === "CREATE INDEX i1 ON t1 (id)";

    await expect(applyMigrations(executor, "sqlite", [one])).rejects.toThrowError(
      `Payweave migration "0001_one" failed at statement 2 of 2.`,
    );
    expect(executor.ledger.size).toBe(0);
  });

  it("ledger-insert failure is wrapped with a dedicated message", async () => {
    const one = syntheticMigration("0001_one", "CREATE TABLE t1 (id TEXT)");
    const executor = new FakeExecutor();
    executor.failOn = (sql) => sql.startsWith("INSERT INTO pw_migrations");

    await expect(applyMigrations(executor, "sqlite", [one])).rejects.toThrowError(
      `Payweave migration "0001_one" executed, but recording it in the pw_migrations ledger failed.`,
    );
  });

  it("full round-trip: apply then plan agrees the schema is current", async () => {
    const executor = new FakeExecutor();
    await applyMigrations(executor, "mysql");
    await expect(planMigrations(executor, "mysql")).resolves.toEqual({
      pending: [],
      applied: ["0001_init"],
    });
  });
});
