/**
 * `payweave/db/drizzle` — the Drizzle ORM adapter (docs/v1/database.md, PW-708).
 *
 * Conformance (database.md §6): the ONLY dialect this suite runs live, in
 * this environment, is sqlite — `runDatabaseConformance` against
 * `drizzle-orm/libsql` over an in-memory `@libsql/client` (a fully in-process
 * sqlite dialect, no docker needed, mirroring PW-706's own in-memory
 * conformance run). The schema is bootstrapped with `drizzle-kit`'s own
 * programmatic push API (`drizzle-kit/api`'s `pushSQLiteSchema`) against
 * `./schema/sqlite.ts` — i.e. this exercises the REAL "merge the published
 * schema + `drizzle-kit push`" user workflow end to end, not a hand-rolled
 * substitute.
 *
 * database.md §6's actual CI obligation for Drizzle is the POSTGRES variant
 * (dockerized `postgres:16` + `drizzle-kit push`) — unavailable here (no
 * docker in this sandbox, and `pg`/`mysql2` are intentionally NOT devDeps of
 * this ticket — see the brief's DEPS note). The postgres/mysql legs below are
 * real, runnable scaffolding gated behind `PW_DB_CONFORMANCE_DOCKER=1` so
 * they never execute (and never fail) in this environment or in default CI;
 * PW-710 flips the flag once it wires `pg`/`mysql2` into the CI matrix and
 * runs `drizzle-kit push` of `./schema/{pg,mysql}.ts` against the docker
 * services first (database.md §6 last bullet).
 */
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { pushSQLiteSchema } from "drizzle-kit/api";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getMysqlTableConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayweaveConfigError } from "../../src/core/errors";
import { detectDrizzleDialect } from "../../src/db/drizzle/detect";
import { drizzleAdapter, mysqlSchema, pgSchema, sqliteSchema } from "../../src/db/drizzle/index";
import { pwIdSchema } from "../../src/db/schema";
import { runDatabaseConformance, type DatabaseAdapterHandle } from "./conformance";

// ── Conformance — the whole point of this ticket ────────────────────────────

async function makeSqliteAdapter(): Promise<DatabaseAdapterHandle> {
  const client = createClient({ url: ":memory:" });
  const db = drizzleLibsql(client);
  // The real `drizzle-kit push` workflow, driven programmatically instead of
  // via the CLI — same DDL, no docker, no on-disk migration files.
  const { apply } = await pushSQLiteSchema(sqliteSchema, db);
  await apply();
  const adapter = drizzleAdapter(db);
  return { adapter, teardown: () => client.close() };
}

runDatabaseConformance("drizzle (sqlite, drizzle-orm/libsql :memory:)", makeSqliteAdapter);

// ── Postgres/mysql — docker-only, PW-710's CI matrix ────────────────────────

// Opt-in docker gate — PW-710 wires this into the CI matrix's env; never read outside this check.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const RUN_DOCKER_CONFORMANCE = process.env.PW_DB_CONFORMANCE_DOCKER === "1";

describe.skipIf(!RUN_DOCKER_CONFORMANCE)(
  "drizzle (postgres) — docker-only conformance (PW-710's CI matrix)",
  () => {
    async function makePostgresAdapter(): Promise<DatabaseAdapterHandle> {
      // `drizzle-orm/node-postgres` was not a devDependency of THIS ticket
      // (brief: PW-708's DEPS are drizzle-orm + better-sqlite3 only) — PW-710
      // installs it alongside the CI leg's postgres:16 service and a
      // `drizzle-kit push` of `./schema/pg.ts`. `pg` itself became resolvable
      // as a side effect of PW-704 (`payweave/db/postgres`) adding it as a
      // devDependency in the same worktree; that satisfies this import's
      // types today, but `drizzle-orm/node-postgres` below still is not one.
      const { Pool } = await import(/* @vite-ignore */ "pg");
      const { drizzle } = await import(/* @vite-ignore */ "drizzle-orm/node-postgres");
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- PW-710's docker leg only.
      const pool = new Pool({ connectionString: process.env.DRIZZLE_POSTGRES_URL });
      const db = drizzle(pool);
      const adapter = drizzleAdapter(db);
      return { adapter, teardown: () => pool.end() };
    }
    runDatabaseConformance("drizzle (postgres, docker)", makePostgresAdapter);
  },
);

describe.skipIf(!RUN_DOCKER_CONFORMANCE)(
  "drizzle (mysql) — docker-only conformance (PW-710's CI matrix)",
  () => {
    async function makeMysqlAdapter(): Promise<DatabaseAdapterHandle> {
      // @ts-expect-error - "mysql2" is not a devDependency of this ticket (see ../postgres block);
      // only resolvable once PW-710's docker leg installs it alongside PW_DB_CONFORMANCE_DOCKER=1.
      const mysql2 = await import(/* @vite-ignore */ "mysql2/promise");
      const { drizzle } = await import(/* @vite-ignore */ "drizzle-orm/mysql2");
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- PW-710's docker leg only.
      const pool = mysql2.createPool(process.env.DRIZZLE_MYSQL_URL ?? "");
      const db = drizzle(pool);
      const adapter = drizzleAdapter(db);
      return { adapter, teardown: () => pool.end() };
    }
    runDatabaseConformance("drizzle (mysql, docker)", makeMysqlAdapter);
  },
);

// ── Cross-dialect schema parity (PW-708 brief: "add a parity unit test") ───

interface NormalizedColumn {
  name: string;
  notNull: boolean;
  primary: boolean;
}
interface NormalizedIndex {
  name: string;
  unique: boolean;
  columns: string[];
}
interface NormalizedTable {
  columns: NormalizedColumn[];
  uniqueIndexes: NormalizedIndex[];
}

/** The subset of `getTableConfig(...)`'s return shape every dialect shares — read defensively since
 *  pg-core/mysql-core/sqlite-core each type `name`/`unique`/index `columns` slightly differently
 *  (e.g. sqlite's `IndexColumn` may be a raw `SQL` expression instead of a plain column). */
interface TableConfigLike {
  columns: ReadonlyArray<{ name: string; notNull: boolean; primary: boolean }>;
  indexes: ReadonlyArray<{
    config: {
      name?: string;
      unique?: boolean;
      columns: ReadonlyArray<{ name?: string } | unknown>;
    };
  }>;
}

function normalize(
  tables: Record<string, unknown>,
  getConfig: (table: unknown) => TableConfigLike,
  // mysql's generated `active_slot` column (+ its composite unique index)
  // emulates the partial-unique rule the OTHER two dialects express as a
  // native partial index (database.md §4 build-time resolution) — it is a
  // deliberate, documented per-dialect divergence, not schema drift.
  ignoreColumns: readonly string[] = [],
): Record<string, NormalizedTable> {
  const out: Record<string, NormalizedTable> = {};
  for (const [key, table] of Object.entries(tables)) {
    const cfg = getConfig(table);
    out[key] = {
      columns: cfg.columns
        .filter((c) => !ignoreColumns.includes(c.name))
        .map((c) => ({ name: c.name, notNull: c.notNull, primary: c.primary }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      uniqueIndexes: cfg.indexes
        .filter((i) => i.config.unique === true)
        .map((i) => ({
          name: i.config.name ?? "",
          unique: i.config.unique === true,
          columns: i.config.columns
            .map((c) => (c as { name?: string }).name ?? "")
            .filter((n) => n !== "" && !ignoreColumns.includes(n)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return out;
}

describe("cross-dialect schema parity (pg.ts / mysql.ts / sqlite.ts)", () => {
  const pg = normalize(pgSchema, (t) => getPgTableConfig(t as never));
  const mysql = normalize(mysqlSchema, (t) => getMysqlTableConfig(t as never), ["active_slot"]);
  const sqlite = normalize(sqliteSchema, (t) => getSqliteTableConfig(t as never));

  it("publishes the same five tables in every dialect", () => {
    expect(Object.keys(pg).sort()).toEqual(Object.keys(sqliteSchema).sort());
    expect(Object.keys(mysql).sort()).toEqual(Object.keys(sqliteSchema).sort());
    expect(Object.keys(sqlite).sort()).toEqual(Object.keys(sqliteSchema).sort());
  });

  it.each(Object.keys(sqliteSchema))("table %s has the same column names across all three dialects", (key) => {
    const names = (t: NormalizedTable) => t.columns.map((c) => c.name).sort();
    const pgTable = pg[key];
    const mysqlTable = mysql[key];
    const sqliteTable = sqlite[key];
    expect(pgTable).toBeDefined();
    expect(mysqlTable).toBeDefined();
    expect(sqliteTable).toBeDefined();
    if (!pgTable || !mysqlTable || !sqliteTable) return;
    expect(names(pgTable)).toEqual(names(sqliteTable));
    expect(names(mysqlTable)).toEqual(names(sqliteTable));
  });

  it("the partial-unique active-subscription rule is one unique index on (customer_id, group) in every dialect", () => {
    for (const table of [pg.pwSubscriptions, mysql.pwSubscriptions, sqlite.pwSubscriptions]) {
      expect(table).toBeDefined();
      const uq = table?.uniqueIndexes.find((i) => i.columns.includes("customer_id"));
      expect(uq).toBeDefined();
      expect(uq?.columns.filter((c) => c !== "active_slot").sort()).toEqual(["customer_id", "group"]);
    }
  });

  it("mysql's active_slot generated column exists ONLY on mysql (documented divergence)", () => {
    const mysqlRaw = normalize(mysqlSchema, (t) => getMysqlTableConfig(t as never));
    const mysqlColumns = mysqlRaw.pwSubscriptions?.columns.map((c) => c.name) ?? [];
    expect(mysqlColumns).toContain("active_slot");
    expect(pg.pwSubscriptions?.columns.map((c) => c.name)).not.toContain("active_slot");
    expect(sqlite.pwSubscriptions?.columns.map((c) => c.name)).not.toContain("active_slot");
  });

  it("every table's uniqueness rules match column-for-column (id/table PKs aside)", () => {
    for (const key of Object.keys(sqliteSchema)) {
      const pgTable = pg[key];
      const mysqlTable = mysql[key];
      const sqliteTable = sqlite[key];
      if (!pgTable || !mysqlTable || !sqliteTable) throw new Error(`missing table ${key}`);
      const cols = (t: NormalizedTable) => t.uniqueIndexes.map((u) => [...u.columns].sort().join(","));
      expect(cols(pgTable).sort()).toEqual(cols(sqliteTable).sort());
      expect(cols(mysqlTable).sort()).toEqual(cols(sqliteTable).sort());
    }
  });
});

// ── Dialect detection ────────────────────────────────────────────────────────

describe("detectDrizzleDialect", () => {
  it("detects sqlite from a real drizzle-orm/libsql instance", () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    expect(detectDrizzleDialect(db)).toBe("sqlite");
    client.close();
  });

  it("an explicit options.dialect override always wins", () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    expect(detectDrizzleDialect(db, "postgres")).toBe("postgres");
    client.close();
  });

  it("throws PayweaveConfigError for something that isn't a recognizable Drizzle instance", () => {
    expect(() => detectDrizzleDialect({})).toThrow(PayweaveConfigError);
    expect(() => detectDrizzleDialect({})).toThrow(/could not detect the SQL dialect/);
  });
});

// ── drizzleAdapter(db) — synchronous, side-effect-free construction ─────────

describe("drizzleAdapter(db, options?) input validation", () => {
  it("throws PayweaveConfigError synchronously for a non-Drizzle value", () => {
    expect(() => drizzleAdapter(null)).toThrow(PayweaveConfigError);
    expect(() => drizzleAdapter(42)).toThrow(PayweaveConfigError);
    expect(() => drizzleAdapter({})).toThrow(PayweaveConfigError);
    expect(() => drizzleAdapter({ select: () => undefined })).toThrow(PayweaveConfigError);
  });

  it("accepts a real drizzle-orm/libsql instance and exposes dialect: 'sqlite'", () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    const adapter = drizzleAdapter(db);
    expect(adapter.dialect).toBe("sqlite");
    client.close();
  });

  it("construction never queries the database (sync, side-effect-free — database.md §1)", () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    // No schema pushed yet — if construction queried anything, this would
    // already reflect a missing-table failure synchronously (it can't: the
    // factory returns a plain object with lazy async methods).
    expect(() => drizzleAdapter(db)).not.toThrow();
    client.close();
  });
});

// ── First-use table verification (database.md §4 "Same model" as Prisma) ───

describe("first-use table verification", () => {
  it("throws PayweaveConfigError naming the missing tables and the schema file on first store call", async () => {
    const client = createClient({ url: ":memory:" });
    const adapter = drizzleAdapter(drizzleLibsql(client));
    await expect(adapter.customers.getByExternalId("x")).rejects.toThrow(PayweaveConfigError);
    await expect(adapter.customers.getByExternalId("x")).rejects.toThrow(/pw_customers/);
    await expect(adapter.customers.getByExternalId("x")).rejects.toThrow(
      /schema\/\{pg,mysql,sqlite\}\.ts/,
    );
    client.close();
  });

  it("re-checks and recovers once the schema is pushed mid-process", async () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzleLibsql(client);
    const adapter = drizzleAdapter(db);
    await expect(adapter.customers.getByExternalId("x")).rejects.toThrow(PayweaveConfigError);
    await (await pushSQLiteSchema(sqliteSchema, db)).apply();
    await expect(adapter.customers.getByExternalId("x")).resolves.toBeNull();
  });

  it("migrations.status() reports pending, never throws, even before the schema exists", async () => {
    const client = createClient({ url: ":memory:" });
    const adapter = drizzleAdapter(drizzleLibsql(client));
    const status = await adapter.migrations.status();
    expect(status.applied).toEqual([]);
    expect(status.pending).toEqual(["0001_init"]);
    client.close();
  });
});

// ── migrations.apply() — instructions only, never DDL (database.md §4) ─────

describe("migrations.apply() — Prisma-style instructions, never shells out", () => {
  it("returns instructions naming drizzle-kit and applies nothing", async () => {
    const client = createClient({ url: ":memory:" });
    const adapter = drizzleAdapter(drizzleLibsql(client));
    const result = await adapter.migrations.apply();
    expect(result.applied).toEqual([]);
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toMatch(/drizzle-kit/);
    // Idempotent/stable — never varies between calls.
    const second = await adapter.migrations.apply();
    expect(second.instructions).toBe(result.instructions);
    client.close();
  });

  it("status() still reports pending after apply() — apply() never ran any DDL", async () => {
    const client = createClient({ url: ":memory:" });
    const adapter = drizzleAdapter(drizzleLibsql(client));
    await adapter.migrations.apply();
    expect((await adapter.migrations.status()).pending).toEqual(["0001_init"]);
    client.close();
  });
});

// ── Bundle isolation (spot check; PW-710 owns the formal gate) ─────────────

describe("payweave root never touches the Drizzle adapter", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("importing payweave's root barrel does not import src/db/drizzle/*", async () => {
    const rootSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/index.ts", import.meta.url), "utf8"),
    );
    expect(rootSrc).not.toMatch(/db\/drizzle/);
    expect(rootSrc).not.toMatch(/drizzle-orm/);
  });
});

// ── ULID id generation (self-contained copy — see ./id.ts's header) ────────

describe("generatePwId", () => {
  it("matches the pwIdSchema shape (pwv_ + 26-char Crockford Base32)", async () => {
    const { generatePwId } = await import("../../src/db/drizzle/id");
    expect(() => pwIdSchema.parse(generatePwId())).not.toThrow();
  });

  it("is unique across a burst of calls", async () => {
    const { generatePwId } = await import("../../src/db/drizzle/id");
    const ids = new Set(Array.from({ length: 500 }, () => generatePwId()));
    expect(ids.size).toBe(500);
  });
});
