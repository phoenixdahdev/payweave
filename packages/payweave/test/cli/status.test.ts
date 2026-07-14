/**
 * `payweave status` (docs/v1/cli.md §4).
 *
 * Three layers of coverage:
 *   1. `runStatusChecks` against hand-built {@link StatusClientLike} objects —
 *      every check's pass/fail/skip branch, including a real in-memory sqlite
 *      adapter for the database/migration checks.
 *   2. `runStatusCommand` (flag parsing, exit codes, `--throw` semantics) with
 *      an injected loader — no real config file needed.
 *   3. An end-to-end pass through the REAL PW-1002 `loadConfig` against the
 *      shared fixture project (mirrors `config-loader.test.ts`'s symlink
 *      setup), with MSW mocking the network edge (never HttpClient/fetch).
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SetupServer } from "msw/node";

import type { CliIo } from "../../src/cli/command";
import {
  formatCheckLine,
  runStatusChecks,
  runStatusCommand,
  statusCommand,
  type StatusClientLike,
} from "../../src/cli/status";
import type { LoadConfigOptions } from "../../src/cli/config-loader";
import { createPayweave } from "../../src/index";
import { PAYSTACK_BASE_URL, FLW_V3_BASE_URL, STRIPE_BASE_URL } from "../../src/core/config";
import { createMswServer } from "../../src/testing/msw";
import { sqliteAdapter } from "../../src/db/sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const fixturesRoot = resolve(pkgRoot, "test/fixtures/cli");
const fixturesNodeModules = join(fixturesRoot, "node_modules");
const payweaveLink = join(fixturesNodeModules, "payweave");
const fixture = (name: string): string => resolve(fixturesRoot, name);

beforeAll(() => {
  mkdirSync(fixturesNodeModules, { recursive: true });
  if (!existsSync(payweaveLink)) {
    symlinkSync(pkgRoot, payweaveLink, "dir");
  }
});

afterAll(() => {
  rmSync(fixturesNodeModules, { recursive: true, force: true });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
};

/** A minimal, valid `StatusClientLike` with no providers/database/products. */
function baseClient(overrides: Partial<StatusClientLike> = {}): StatusClientLike {
  return {
    providers: [],
    defaultProvider: "stripe",
    environment: "test",
    webhooks: {
      verify: () => true,
      verifyOrThrow: () => undefined,
      constructEvent: () => ({}) as never,
    },
    capabilities: (() => ({})) as StatusClientLike["capabilities"],
    ...overrides,
  };
}

describe("runStatusChecks (PW-1003 — cli.md §4)", () => {
  describe("check 1 — config validity", () => {
    it("always passes and summarizes providers/environment/database/products", async () => {
      const client = baseClient({ providers: ["paystack"], environment: "live" });
      const { checks } = await runStatusChecks(client);
      const config = checks.find((c) => c.name === "config")!;
      expect(config.status).toBe("pass");
      expect(config.message).toContain("providers: paystack");
      expect(config.message).toContain("environment: live");
      expect(config.message).toContain("database: not configured");
      expect(config.message).toContain("products: not configured");
    });

    it("reports database/products as configured once present on the client", async () => {
      const adapter = sqliteAdapter({ url: ":memory:" });
      await adapter.migrations.apply();
      const client = baseClient({ database: adapter, products: [{ id: "pro" }, { id: "basic" }] });
      const { checks } = await runStatusChecks(client);
      const config = checks.find((c) => c.name === "config")!;
      expect(config.message).toContain("database: configured");
      expect(config.message).toContain("products: 2 loaded");
    });

    it("summarizes capabilities() defensively even if it throws", async () => {
      const client = baseClient({
        providers: ["paystack"],
        capabilities: (() => {
          throw new Error("boom");
        }) as StatusClientLike["capabilities"],
      });
      const { checks } = await runStatusChecks(client);
      const config = checks.find((c) => c.name === "config")!;
      expect(config.status).toBe("pass"); // config check itself never fails
      expect(config.message).toContain("capabilities: unavailable");
    });
  });

  describe("checks 2+3 — database connection + migration status", () => {
    it("skips both when no database is configured (payments-only project)", async () => {
      const client = baseClient();
      const { checks, ok } = await runStatusChecks(client);
      expect(checks.find((c) => c.name === "database")).toMatchObject({ status: "skip" });
      expect(checks.find((c) => c.name === "migrations")).toMatchObject({ status: "skip" });
      expect(ok).toBe(true);
    });

    it("passes both against a migrated in-memory sqlite adapter (PW-706)", async () => {
      const adapter = sqliteAdapter({ url: ":memory:" });
      await adapter.migrations.apply();
      const client = baseClient({ database: adapter });
      const { checks, ok } = await runStatusChecks(client);
      expect(checks.find((c) => c.name === "database")).toMatchObject({ status: "pass" });
      const migrations = checks.find((c) => c.name === "migrations")!;
      expect(migrations.status).toBe("pass");
      expect(migrations.message).toContain("up to date");
      expect(ok).toBe(true);
    });

    it("fails migrations (but passes the connection) when the adapter reports pending migrations", async () => {
      const adapter = sqliteAdapter({ url: ":memory:" }); // never applied
      const client = baseClient({ database: adapter });
      const { checks, ok } = await runStatusChecks(client);
      expect(checks.find((c) => c.name === "database")).toMatchObject({ status: "pass" });
      const migrations = checks.find((c) => c.name === "migrations")!;
      expect(migrations.status).toBe("fail");
      expect(migrations.message).toContain("0001_init");
      expect(migrations.message).toContain("payweave push");
      expect(ok).toBe(false);
    });

    it("fails the connection (a broken DATABASE_URL) and skips migrations when the adapter throws", async () => {
      const client = baseClient({
        database: {
          dialect: "postgres",
          migrations: {
            status: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
          },
        },
      });
      const { checks, ok } = await runStatusChecks(client);
      const database = checks.find((c) => c.name === "database")!;
      expect(database.status).toBe("fail");
      expect(database.message).toContain("ECONNREFUSED");
      expect(checks.find((c) => c.name === "migrations")).toMatchObject({ status: "skip" });
      expect(ok).toBe(false);
    });
  });

  describe("check 4 — provider connectivity (harmless reads, MSW at the network edge)", () => {
    let server: SetupServer | undefined;
    afterEach(() => {
      server?.close();
      server = undefined;
    });

    it("passes for stripe/paystack/flutterwave against a harmless GET", async () => {
      server = await createMswServer([
        {
          method: "get",
          url: `${STRIPE_BASE_URL}/v1/products`,
          json: { object: "list", data: [], has_more: false },
        },
        {
          method: "get",
          url: `${PAYSTACK_BASE_URL}/balance`,
          json: { status: true, message: "ok", data: [] },
        },
        {
          method: "get",
          url: `${FLW_V3_BASE_URL}/banks/NG`,
          json: { status: "success", message: "ok", data: [] },
        },
      ]);
      server.listen({ onUnhandledRequest: "error" });

      const client = createPayweave({
        stripe: { secretKey: "sk_test_harness", maxRetries: 0 },
        paystack: { secretKey: "sk_test_harness", maxRetries: 0 },
        flutterwave: { secretKey: "FLWSECK_TEST-harness", maxRetries: 0 },
        defaultProvider: "stripe",
      }) as unknown as StatusClientLike;

      const { checks, ok } = await runStatusChecks(client);
      for (const provider of ["stripe", "paystack", "flutterwave"]) {
        const check = checks.find((c) => c.name === `provider:${provider}`)!;
        expect(check.status).toBe("pass");
        expect(check.message).toContain("test-mode key is valid");
      }
      expect(ok).toBe(true);
    });

    it("fails on a 401 and redacts any secret material echoed back in the error body", async () => {
      const leaked = "sk_test_51ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
      server = await createMswServer([
        {
          method: "get",
          url: `${PAYSTACK_BASE_URL}/balance`,
          status: 401,
          json: { status: false, message: `Invalid key: ${leaked}` },
        },
      ]);
      server.listen({ onUnhandledRequest: "error" });

      const client = createPayweave({
        paystack: { secretKey: "sk_test_harness", maxRetries: 0 },
      }) as unknown as StatusClientLike;

      const { checks, ok } = await runStatusChecks(client);
      const check = checks.find((c) => c.name === "provider:paystack")!;
      expect(check.status).toBe("fail");
      expect(check.message).toContain("PayweaveAuthError");
      expect(check.message).toContain("[REDACTED]");
      expect(check.message).not.toContain(leaked);
      expect(ok).toBe(false);
    });

    it("skips a configured provider id with no known connectivity check", async () => {
      const client = baseClient({ providers: ["somethingnew"] });
      const { checks } = await runStatusChecks(client);
      expect(checks.find((c) => c.name === "provider:somethingnew")).toMatchObject({ status: "skip" });
    });

    it("skips when a configured provider's namespace isn't mounted on the client", async () => {
      const client = baseClient({ providers: ["stripe"] }); // no client.stripe field
      const { checks } = await runStatusChecks(client);
      expect(checks.find((c) => c.name === "provider:stripe")).toMatchObject({ status: "skip" });
    });
  });

  describe("check 5 — sync status", () => {
    it("skips when no database/products configured", async () => {
      const client = baseClient();
      const { checks } = await runStatusChecks(client);
      expect(checks.find((c) => c.name === "sync")).toMatchObject({ status: "skip" });
    });

    it("skips even once database+products ARE configured (no read-only introspection yet)", async () => {
      const adapter = sqliteAdapter({ url: ":memory:" });
      const client = baseClient({ database: adapter, products: [{ id: "pro" }] });
      const { checks } = await runStatusChecks(client);
      const sync = checks.find((c) => c.name === "sync")!;
      expect(sync.status).toBe("skip");
      expect(sync.message).toContain("payweave push");
    });
  });

  it("runs every check even after an earlier one failed (never short-circuits)", async () => {
    const client = baseClient({
      providers: ["paystack"],
      database: {
        dialect: "sqlite",
        migrations: { status: () => Promise.reject(new Error("boom")) },
      },
    });
    const { checks } = await runStatusChecks(client);
    expect(checks.find((c) => c.name === "database")).toMatchObject({ status: "fail" });
    // Later checks still ran despite the earlier failure.
    expect(checks.some((c) => c.name === "provider:paystack")).toBe(true);
    expect(checks.some((c) => c.name === "sync")).toBe(true);
  });
});

describe("runStatusCommand (flags, exit codes, --throw)", () => {
  it("exits 1 when config fails to load, regardless of --throw", async () => {
    const loadConfigFn = () => Promise.reject(new Error("no Payweave config found"));

    const c1 = capture();
    await expect(runStatusCommand([], c1.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c1.err()).toContain("failed to load config");

    const c2 = capture();
    await expect(runStatusCommand(["--throw"], c2.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
  });

  it("default mode exits 0 even when a check fails (diagnostic only, cli.md §4)", async () => {
    const c = capture();
    const client = baseClient({
      database: { dialect: "sqlite", migrations: { status: () => Promise.reject(new Error("down")) } },
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runStatusCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(0);
    expect(c.out()).toContain("FAIL");
  });

  it("--throw exits 1 when a check fails", async () => {
    const c = capture();
    const client = baseClient({
      database: { dialect: "sqlite", migrations: { status: () => Promise.reject(new Error("down")) } },
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runStatusCommand(["--throw"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("--throw");
  });

  it("--throw exits 0 on an all-green result", async () => {
    const c = capture();
    const client = baseClient();
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runStatusCommand(["--throw"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(0);
  });

  it("prints every check as a formatted line, in cli.md §4 order", async () => {
    const c = capture();
    const client = baseClient({ providers: ["paystack"] });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await runStatusCommand([], c.io, { loadConfig: loadConfigFn });
    const lines = c.out().split("\n");
    expect(lines[0]).toBe("Payweave status — config: /fake/payweave.ts");
    const names = ["config", "database", "migrations", "provider:paystack", "sync"];
    const positions = names.map((n) => lines.findIndex((l) => l.includes(`] ${n}`)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("--config passes through to the loader", async () => {
    const c = capture();
    let seen: LoadConfigOptions | undefined;
    const client = baseClient();
    const loadConfigFn = (o: LoadConfigOptions) => {
      seen = o;
      return Promise.resolve({ path: "/fake/payweave.ts", client });
    };
    await runStatusCommand(["--config", "/some/path.ts"], c.io, { loadConfig: loadConfigFn });
    expect(seen?.configPath).toBe("/some/path.ts");
  });

  it('statusCommand registers as "status"', () => {
    expect(statusCommand.name).toBe("status");
  });
});

describe("end-to-end via the real PW-1002 loader (fixture project, MSW)", () => {
  let server: SetupServer | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("a healthy paystack-only fixture project passes end to end (--throw exits 0)", async () => {
    server = await createMswServer([
      { method: "get", url: `${PAYSTACK_BASE_URL}/balance`, json: { status: true, message: "ok", data: [] } },
    ]);
    server.listen({ onUnhandledRequest: "error" });

    const c = capture();
    const configPath = join(fixture("root-ts"), "payweave.ts");
    const exitCode = await runStatusCommand(["--throw", "--config", configPath], c.io);
    expect(exitCode).toBe(0);
    expect(c.out()).toContain(configPath);
    expect(c.out()).toContain("PASS");
    expect(c.out()).not.toContain("FAIL");
  });

  it("a nonexistent --config path fails to load and exits 1 even without --throw", async () => {
    const c = capture();
    const configPath = join(fixture("root-ts"), "does-not-exist.ts");
    const exitCode = await runStatusCommand(["--config", configPath], c.io);
    expect(exitCode).toBe(1);
    expect(c.err()).toContain("does not exist");
  });
});

describe("formatCheckLine", () => {
  it("renders the status label, name, and message", () => {
    const line = formatCheckLine({ name: "config", status: "pass", message: "ok" });
    expect(line).toContain("PASS");
    expect(line).toContain("config");
    expect(line).toContain("ok");
  });
});
