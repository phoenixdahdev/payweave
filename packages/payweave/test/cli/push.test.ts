/**
 * PW-1004 — `payweave push` (docs/v1/cli.md §2, §8).
 *
 * Three layers of coverage, mirroring `status.test.ts` (PW-1003):
 *   1. Pure helpers — `resolvePlanDiffAction`, `computePlanDiff`, and the
 *      `format*` renderers — against hand-built fakes.
 *   2. `runPushCommand` — flags, gating (`-y`, non-TTY, declined prompt),
 *      pipeline ORDER, and exit codes — against a hand-built `PushClientLike`
 *      fake with an injected `loadConfig`.
 *   3. End-to-end against a REAL in-memory `sqliteAdapter` (PW-706) + a REAL
 *      `createPayweave` client, with MSW mocking only the network edge
 *      (`onUnhandledRequest: "error"` doubles as the zero-provider-write proof
 *      for the abort and idempotent-second-push cases).
 */
import { describe, expect, it, afterEach } from "vitest";
import type { SetupServer } from "msw/node";

import type { CliIo } from "../../src/cli/command";
import {
  computePlanDiff,
  formatMigrationsApplied,
  formatMigrationsPending,
  formatPlanDiffLine,
  formatSyncResultLine,
  pushCommand,
  resolvePlanDiffAction,
  runPushCommand,
  type PushClientLike,
  type PushCommandOptions,
  type PushDatabaseLike,
  type PushPlanVersionLike,
  type PushProductLike,
} from "../../src/cli/push";
import type { LoadConfigOptions, PayweaveClientLike } from "../../src/cli/config-loader";
import { createPayweave } from "../../src/index";
import { PAYSTACK_BASE_URL, STRIPE_BASE_URL } from "../../src/core/config";
import { createHandlers, type MockRoute } from "../../src/testing/msw";
import { sqliteAdapter } from "../../src/db/sqlite";
import { feature } from "../../src/products/feature";
import { plan } from "../../src/products/plan";

// ── Shared capture/io helper (status.test.ts precedent) ─────────────────────

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
};

// ── Pure helper tests ────────────────────────────────────────────────────────

const freeProduct: PushProductLike = {
  id: "free",
  name: "Free",
  includes: [{ featureId: "messages", type: "metered", limit: 100, reset: "month" }],
};

const proProduct: PushProductLike = {
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "USD", interval: "month" },
  includes: [{ featureId: "messages", type: "metered", limit: 2000, reset: "month" }],
};

const proActiveVersion: PushPlanVersionLike = {
  version: 1,
  name: "Pro",
  priceMinor: 1900,
  priceCurrency: "USD",
  priceInterval: "month",
  features: { messages: { type: "metered", limit: 2000, reset: "month" } },
};

describe("resolvePlanDiffAction", () => {
  it("is 'create' when no active version exists yet", () => {
    expect(resolvePlanDiffAction(proProduct, null)).toBe("create");
  });

  it("is 'unchanged' when name/price/features all match the active version", () => {
    expect(resolvePlanDiffAction(proProduct, proActiveVersion)).toBe("unchanged");
  });

  it("is 'update' when the price changed", () => {
    const repriced: PushProductLike = { ...proProduct, price: { amount: 2900, currency: "USD", interval: "month" } };
    expect(resolvePlanDiffAction(repriced, proActiveVersion)).toBe("update");
  });

  it("is 'update' when only the display name changed", () => {
    const renamed: PushProductLike = { ...proProduct, name: "Pro Plan" };
    expect(resolvePlanDiffAction(renamed, proActiveVersion)).toBe("update");
  });

  it("is 'update' when only a feature limit changed (never touches providers, plans-and-features.md §12)", () => {
    const relimited: PushProductLike = {
      ...proProduct,
      includes: [{ featureId: "messages", type: "metered", limit: 5000, reset: "month" }],
    };
    expect(resolvePlanDiffAction(relimited, proActiveVersion)).toBe("update");
  });

  it("is 'unchanged' for a free plan whose stored row matches", () => {
    const freeActive: PushPlanVersionLike = {
      version: 1,
      name: "Free",
      priceMinor: null,
      priceCurrency: null,
      priceInterval: null,
      features: { messages: { type: "metered", limit: 100, reset: "month" } },
    };
    expect(resolvePlanDiffAction(freeProduct, freeActive)).toBe("unchanged");
  });
});

function fakeDatabase(versions: Record<string, PushPlanVersionLike | null>): PushDatabaseLike {
  return {
    dialect: "sqlite",
    migrations: {
      status: () => Promise.resolve({ pending: [], applied: ["0001_init"] }),
      apply: () => Promise.resolve({ applied: [] }),
    },
    plans: {
      getActiveVersion: (planId) => Promise.resolve(versions[planId] ?? null),
    },
  };
}

describe("computePlanDiff", () => {
  it("classifies each product and scopes providers to configured, billing-capable ones only", async () => {
    const db = fakeDatabase({ pro: proActiveVersion });
    const entries = await computePlanDiff(db, [freeProduct, proProduct], ["stripe", "paystack", "flutterwave"]);

    const free = entries.find((e) => e.planId === "free")!;
    expect(free).toMatchObject({ action: "create", paid: false, providers: [] });

    const pro = entries.find((e) => e.planId === "pro")!;
    expect(pro).toMatchObject({ action: "unchanged", paid: true, providers: ["stripe", "paystack"] });
  });

  it("excludes non-billing-capable configured providers (e.g. flutterwave) from a paid plan's provider list", async () => {
    const db = fakeDatabase({});
    const entries = await computePlanDiff(db, [proProduct], ["flutterwave"]);
    expect(entries[0]).toMatchObject({ action: "create", providers: [] });
  });
});

describe("format* renderers", () => {
  it("formatMigrationsPending reports pending count + ids, or up-to-date", () => {
    expect(formatMigrationsPending({ pending: [] })).toBe("Migrations: up to date — no pending migrations");
    expect(formatMigrationsPending({ pending: ["0001_init", "0002_x"] })).toBe(
      "Migrations: 2 pending — 0001_init, 0002_x",
    );
  });

  it("formatMigrationsApplied reports instructions, applied count, or undefined (nothing new)", () => {
    expect(formatMigrationsApplied({ applied: [], instructions: "run `prisma migrate dev`" })).toBe(
      "Migrations: run `prisma migrate dev`",
    );
    expect(formatMigrationsApplied({ applied: ["0001_init"] })).toBe(
      "Migrations: applied 1 migration(s): 0001_init",
    );
    expect(formatMigrationsApplied({ applied: [] })).toBeUndefined();
  });

  it("formatPlanDiffLine renders the action, plan id, and provider scope", () => {
    expect(formatPlanDiffLine({ planId: "pro", action: "create", paid: true, providers: ["stripe"] })).toContain(
      "CREATE",
    );
    expect(
      formatPlanDiffLine({ planId: "free", action: "unchanged", paid: false, providers: [] }),
    ).toContain("free plan");
  });

  it("formatSyncResultLine renders the real per-provider outcome", () => {
    const line = formatSyncResultLine({
      planId: "pro",
      version: 2,
      versionChanged: true,
      providers: { stripe: "created", paystack: "adopted" },
    });
    expect(line).toContain("stripe: created");
    expect(line).toContain("paystack: adopted");
    expect(line).toContain("version 2 (new)");
  });
});

// ── runPushCommand — flags, gating, exit codes (hand-built fake client) ─────

function baseClient(overrides: Partial<PushClientLike> = {}): PushClientLike {
  return {
    providers: ["stripe", "paystack"],
    defaultProvider: "stripe",
    environment: "test",
    webhooks: {
      verify: () => true,
      verifyOrThrow: () => undefined,
      constructEvent: () => ({}) as never,
    },
    capabilities: (() => ({})) as PushClientLike["capabilities"],
    sync: () => Promise.resolve({ plans: [], skippedProviders: [] }),
    ...overrides,
  };
}

describe("runPushCommand — config/database preconditions", () => {
  it("exits 1 when config fails to load", async () => {
    const c = capture();
    const loadConfigFn = () => Promise.reject(new Error("no Payweave config found"));
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("payweave push: failed to load config");
  });

  it("exits 1 when no database is configured", async () => {
    const c = capture();
    const client = baseClient();
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("no database configured");
  });

  it("exits 1 when migrations.status() throws", async () => {
    const c = capture();
    const database: PushDatabaseLike = {
      migrations: {
        status: () => Promise.reject(new Error("connect ECONNREFUSED")),
        apply: () => Promise.reject(new Error("unreachable")),
      },
      plans: { getActiveVersion: () => Promise.resolve(null) },
    };
    const client = baseClient({ database });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("could not read migration status");
    expect(c.err()).toContain("ECONNREFUSED");
  });

  it("exits 1 when migrations.apply() throws (status succeeded)", async () => {
    const c = capture();
    const database: PushDatabaseLike = {
      migrations: {
        status: () => Promise.resolve({ pending: ["0001_init"], applied: [] }),
        apply: () => Promise.reject(new Error("permission denied for schema public")),
      },
      plans: { getActiveVersion: () => Promise.resolve(null) },
    };
    const client = baseClient({ database });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("migrations failed");
    expect(c.err()).toContain("permission denied");
    // The pending-migrations announcement still printed BEFORE the failing apply call.
    expect(c.out()).toContain("1 pending");
  });

  it("exits 0 with no products configured — migrations still ran, sync never called", async () => {
    const c = capture();
    let syncCalled = false;
    const database = fakeDatabase({});
    const client = baseClient({
      database,
      sync: () => {
        syncCalled = true;
        return Promise.resolve({ plans: [], skippedProviders: [] });
      },
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runPushCommand(["-y"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(0);
    expect(c.out()).toContain("no products configured");
    expect(syncCalled).toBe(false);
  });

  it("treats an empty products array the same as undefined", async () => {
    const c = capture();
    const client = baseClient({ database: fakeDatabase({}), products: [] });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    await expect(runPushCommand(["-y"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(0);
    expect(c.out()).toContain("no products configured");
  });
});

describe("runPushCommand — pipeline order (spy sequence)", () => {
  it("runs migrations status -> apply -> plan-state reads -> confirm -> sync, in that order", async () => {
    const calls: string[] = [];
    const database: PushDatabaseLike = {
      migrations: {
        status: () => {
          calls.push("migrations.status");
          return Promise.resolve({ pending: ["0001_init"], applied: [] });
        },
        apply: () => {
          calls.push("migrations.apply");
          return Promise.resolve({ applied: ["0001_init"] });
        },
      },
      plans: {
        getActiveVersion: (planId) => {
          calls.push(`plans.getActiveVersion(${planId})`);
          return Promise.resolve(null);
        },
      },
    };
    const client = baseClient({
      database,
      products: [proProduct],
      sync: () => {
        calls.push("sync");
        return Promise.resolve({ plans: [], skippedProviders: [] });
      },
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const confirm = () => {
      calls.push("confirm");
      return Promise.resolve(true);
    };

    const c = capture();
    await expect(
      runPushCommand([], c.io, { loadConfig: loadConfigFn, confirm, isInteractive: true }),
    ).resolves.toBe(0);

    expect(calls).toEqual([
      "migrations.status",
      "migrations.apply",
      "plans.getActiveVersion(pro)",
      "confirm",
      "sync",
    ]);
  });
});

describe("runPushCommand — confirmation gate", () => {
  function clientWithOneProduct(sync: PushClientLike["sync"]): PushClientLike {
    return baseClient({ database: fakeDatabase({}), products: [proProduct], sync });
  }

  it("-y skips the prompt entirely — the confirm seam is never invoked", async () => {
    let syncCalled = false;
    const client = clientWithOneProduct(() => {
      syncCalled = true;
      return Promise.resolve({ plans: [], skippedProviders: [] });
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const confirm = () => Promise.reject(new Error("confirm must never be called when -y is passed"));

    const c = capture();
    await expect(runPushCommand(["-y"], c.io, { loadConfig: loadConfigFn, confirm })).resolves.toBe(0);
    expect(syncCalled).toBe(true);
  });

  it("--yes is the long form of -y", async () => {
    const client = clientWithOneProduct(() => Promise.resolve({ plans: [], skippedProviders: [] }));
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const c = capture();
    await expect(runPushCommand(["--yes"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(0);
  });

  it("without -y, a non-interactive session fails with guidance — sync never called", async () => {
    let syncCalled = false;
    const client = clientWithOneProduct(() => {
      syncCalled = true;
      return Promise.resolve({ plans: [], skippedProviders: [] });
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });

    const c = capture();
    await expect(
      runPushCommand([], c.io, { loadConfig: loadConfigFn, isInteractive: false }),
    ).resolves.toBe(1);
    expect(c.err()).toContain("non-interactive session");
    expect(c.err()).toContain("-y");
    expect(syncCalled).toBe(false);
  });

  it("without -y and no isInteractive override, defaults to the real (non-TTY test) stdin — refuses", async () => {
    // vitest's process.stdin is not a real TTY, so the default `isInteractive`
    // (process.stdin.isTTY === true) is false here — proving the wiring
    // without an explicit override.
    const client = clientWithOneProduct(() => Promise.resolve({ plans: [], skippedProviders: [] }));
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const c = capture();
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("non-interactive session");
  });

  it("an interactive session prompts via the injected confirm seam — declining aborts, sync never called", async () => {
    let syncCalled = false;
    const client = clientWithOneProduct(() => {
      syncCalled = true;
      return Promise.resolve({ plans: [], skippedProviders: [] });
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const confirm = () => Promise.resolve(false);

    const c = capture();
    await expect(
      runPushCommand([], c.io, { loadConfig: loadConfigFn, confirm, isInteractive: true }),
    ).resolves.toBe(1);
    expect(c.err()).toContain("aborted");
    expect(syncCalled).toBe(false);
  });

  it("an interactive session that confirms proceeds to sync", async () => {
    let syncCalled = false;
    const client = clientWithOneProduct(() => {
      syncCalled = true;
      return Promise.resolve({ plans: [], skippedProviders: [] });
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const confirm = () => Promise.resolve(true);

    const c = capture();
    await expect(
      runPushCommand([], c.io, { loadConfig: loadConfigFn, confirm, isInteractive: true }),
    ).resolves.toBe(0);
    expect(syncCalled).toBe(true);
  });
});

describe("runPushCommand — sync failure + redaction", () => {
  it("exits 1 with a clear message when sync() throws", async () => {
    const client = baseClient({
      database: fakeDatabase({}),
      products: [proProduct],
      sync: () => Promise.reject(new Error("stripe request failed: rate limited")),
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const c = capture();
    await expect(runPushCommand(["-y"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("sync failed");
    expect(c.err()).toContain("rate limited");
    expect(c.err()).toContain("safe");
  });

  it("exits 1 with a clear message when reading plan state (getActiveVersion) throws", async () => {
    const database: PushDatabaseLike = {
      migrations: {
        status: () => Promise.resolve({ pending: [], applied: [] }),
        apply: () => Promise.resolve({ applied: [] }),
      },
      plans: { getActiveVersion: () => Promise.reject(new Error("database connection lost")) },
    };
    const client = baseClient({ database, products: [proProduct] });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const c = capture();
    await expect(runPushCommand(["-y"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("failed to read plan state");
    expect(c.err()).toContain("database connection lost");
  });

  it("reports skippedProviders (e.g. flutterwave) after a successful sync", async () => {
    const client = baseClient({
      database: fakeDatabase({}),
      products: [proProduct],
      providers: ["stripe", "paystack", "flutterwave"],
      sync: () =>
        Promise.resolve({
          plans: [{ planId: "pro", version: 1, versionChanged: true, providers: { stripe: "created" } }],
          skippedProviders: ["flutterwave"],
        }),
    });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const c = capture();
    await expect(runPushCommand(["-y"], c.io, { loadConfig: loadConfigFn })).resolves.toBe(0);
    expect(c.out()).toContain("Skipped providers (not billing-capable yet): flutterwave");
  });

  it("never prints a raw secret leaked in an error message", async () => {
    const leaked = "sk_test_51ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const database: PushDatabaseLike = {
      migrations: {
        status: () => Promise.reject(new Error(`auth failed using key ${leaked}`)),
        apply: () => Promise.reject(new Error("unreachable")),
      },
      plans: { getActiveVersion: () => Promise.resolve(null) },
    };
    const client = baseClient({ database });
    const loadConfigFn = () => Promise.resolve({ path: "/fake/payweave.ts", client });
    const c = capture();
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("[REDACTED]");
    expect(c.err()).not.toContain(leaked);
  });

  it("--config passes through to the loader", async () => {
    let seen: LoadConfigOptions | undefined;
    const loadConfigFn = (o: LoadConfigOptions) => {
      seen = o;
      return Promise.reject(new Error("stop here"));
    };
    const c = capture();
    await runPushCommand(["--config", "/some/path.ts"], c.io, { loadConfig: loadConfigFn });
    expect(seen?.configPath).toBe("/some/path.ts");
  });
});

describe("runPushCommand — non-Error rejection shapes (errorMessage/errorName edge cases)", () => {
  it("handles a bare string thrown by the loader", async () => {
    const loadConfigFn = () => Promise.reject("plain string failure");
    const c = capture();
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("plain string failure");
  });

  it("handles a plain (non-Error, nameless) object thrown by the loader", async () => {
    const loadConfigFn = () => Promise.reject({ reason: "totally not an Error" });
    const c = capture();
    await expect(runPushCommand([], c.io, { loadConfig: loadConfigFn })).resolves.toBe(1);
    expect(c.err()).toContain("totally not an Error");
  });
});

describe("pushCommand registration", () => {
  it("registers as \"push\" (PW-1004) — no longer the PW-1001 placeholder", () => {
    expect(pushCommand.name).toBe("push");
    expect(pushCommand.ticket).toBe("PW-1004");
  });
});

// ── End-to-end: real sqliteAdapter + real createPayweave client + MSW ───────

const messages = feature({ id: "messages", type: "metered" });

const freePlanDef = plan({
  id: "free",
  name: "Free",
  group: "base",
  default: true,
  includes: [messages({ limit: 100, reset: "month" })],
});
const proPlanDef = plan({
  id: "pro",
  name: "Pro",
  group: "base",
  price: { amount: 19, currency: "USD", interval: "month" },
  includes: [messages({ limit: 2_000, reset: "month" })],
});

const PROD_ID = "prod_push_pro";
const PRICE_ID = "price_push_pro_v1";
const PLAN_CODE = "PLN_push_pro_v1";

const FIRST_PUSH_ROUTES = [
  { method: "get" as const, url: `${STRIPE_BASE_URL}/v1/products/search`, json: { object: "search_result", data: [], has_more: false } },
  { method: "get" as const, url: `${STRIPE_BASE_URL}/v1/prices/search`, json: { object: "search_result", data: [], has_more: false } },
  { method: "post" as const, url: `${STRIPE_BASE_URL}/v1/products`, json: { id: PROD_ID, object: "product" } },
  { method: "post" as const, url: `${STRIPE_BASE_URL}/v1/prices`, json: { id: PRICE_ID, object: "price" } },
  { method: "get" as const, url: `${PAYSTACK_BASE_URL}/plan`, json: { status: true, message: "ok", data: [] } },
  {
    method: "post" as const,
    url: `${PAYSTACK_BASE_URL}/plan`,
    json: { status: true, message: "plan created", data: { id: 1, plan_code: PLAN_CODE } },
  },
];

interface Edge {
  server: SetupServer;
  requests: () => Promise<Request[]>;
  close: () => void;
}

async function startEdge(routes: MockRoute[]): Promise<Edge> {
  const { setupServer } = await import("msw/node");
  const handlers = await createHandlers(routes);
  const server = setupServer(...handlers);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => raw.push(request.clone()));
  server.listen({ onUnhandledRequest: "error" });
  return { server, requests: () => Promise.resolve(raw), close: () => server.close() };
}

let edge: Edge | undefined;
afterEach(() => {
  edge?.close();
  edge = undefined;
});

describe("runPushCommand — end to end (real sqliteAdapter + real createPayweave client, MSW)", () => {
  /** Wraps a real client so `runPushCommand` skips PW-1002's file-discovery loader entirely. */
  function loaderFor(client: unknown): Pick<PushCommandOptions, "loadConfig"> {
    return {
      loadConfig: () =>
        Promise.resolve({ path: "/fixture/payweave.ts", client: client as PayweaveClientLike }),
    };
  }

  it("applies the initial migration, shows a CREATE diff, and syncs both plans on first push", async () => {
    const db = sqliteAdapter({ url: ":memory:" }); // fresh — migrations NOT pre-applied
    // MSW must be listening BEFORE `createPayweave` builds its `HttpClient`s
    // (sync.test.ts precedent) — otherwise the client's fetch reference is
    // captured before the interceptor patches it and calls hit the real network.
    edge = await startEdge(FIRST_PUSH_ROUTES);
    const client = createPayweave({
      stripe: { secretKey: "sk_test_push_stripe" },
      paystack: { secretKey: "sk_test_push_paystack" },
      defaultProvider: "stripe",
      database: db,
      products: [freePlanDef, proPlanDef],
    });

    const c = capture();
    const exitCode = await runPushCommand(["-y"], c.io, loaderFor(client));
    expect(exitCode).toBe(0);

    expect(c.out()).toContain("1 pending");
    expect(c.out()).toContain("applied 1 migration(s): 0001_init");
    expect(c.out()).toContain("[CREATE");
    expect(c.out()).toContain("providers: stripe, paystack");
    expect(c.out()).toContain("free plan");
    expect(c.out()).toContain("stripe: created");
    expect(c.out()).toContain("paystack: created");

    const pushedPro = await db.plans.getActiveVersion("pro");
    expect(pushedPro?.providerRefs.stripe).toMatchObject({ productId: PROD_ID, priceId: PRICE_ID });
  });

  it("second push is idempotent — up-to-date migrations, UNCHANGED diff, zero provider writes", async () => {
    const db = sqliteAdapter({ url: ":memory:" });
    // ONE continuous server for both runs (`resetHandlers` swaps the route
    // set in place) — the client's `HttpClient` captures its fetch reference
    // once at construction, so closing and re-listening a SECOND server
    // between the two pushes would re-patch global fetch out from under an
    // already-built client and silently fall through to the real network.
    const handlers = await createHandlers(FIRST_PUSH_ROUTES);
    const { setupServer } = await import("msw/node");
    const server = setupServer(...handlers);
    let raw: Request[] = [];
    server.events.on("request:start", ({ request }) => raw.push(request.clone()));
    server.listen({ onUnhandledRequest: "error" });

    try {
      const client = createPayweave({
        stripe: { secretKey: "sk_test_push_stripe" },
        paystack: { secretKey: "sk_test_push_paystack" },
        defaultProvider: "stripe",
        database: db,
        products: [freePlanDef, proPlanDef],
      });

      const first = capture();
      expect(await runPushCommand(["-y"], first.io, loaderFor(client))).toBe(0);

      // Zero routes registered for the second run — ANY provider HTTP call fails the test.
      raw = [];
      server.resetHandlers();
      const second = capture();
      const exitCode = await runPushCommand(["-y"], second.io, loaderFor(client));
      expect(exitCode).toBe(0);

      expect(second.out()).toContain("up to date — no pending migrations");
      expect(second.out()).toContain("[UNCHANGED");
      expect(second.out()).toContain("stripe: unchanged");
      expect(second.out()).toContain("paystack: unchanged");
      expect(raw).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("a declined confirmation aborts before any provider call is made", async () => {
    const db = sqliteAdapter({ url: ":memory:" });
    // Zero routes registered — any provider HTTP call at all fails the test.
    edge = await startEdge([]);
    const client = createPayweave({
      stripe: { secretKey: "sk_test_push_stripe" },
      paystack: { secretKey: "sk_test_push_paystack" },
      defaultProvider: "stripe",
      database: db,
      products: [freePlanDef, proPlanDef],
    });

    const c = capture();
    const exitCode = await runPushCommand([], c.io, {
      ...loaderFor(client),
      isInteractive: true,
      confirm: () => Promise.resolve(false),
    });
    expect(exitCode).toBe(1);
    expect(c.err()).toContain("aborted");
    expect(await edge.requests()).toEqual([]);
  });

  it("redacts a secret leaked in a provider error surfaced through sync failure", async () => {
    const db = sqliteAdapter({ url: ":memory:" });
    const leaked = "sk_test_51ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    edge = await startEdge([
      {
        method: "get" as const,
        url: `${STRIPE_BASE_URL}/v1/products/search`,
        status: 401,
        json: { error: { message: `Invalid API Key provided: ${leaked}` } },
      },
    ]);
    const client = createPayweave({
      stripe: { secretKey: "sk_test_push_stripe" },
      defaultProvider: "stripe",
      database: db,
      products: [proPlanDef],
    });

    const c = capture();
    const exitCode = await runPushCommand(["-y"], c.io, loaderFor(client));
    expect(exitCode).toBe(1);
    expect(c.err()).toContain("sync failed");
    expect(c.err()).toContain("[REDACTED]");
    expect(c.err()).not.toContain(leaked);
  });
});
