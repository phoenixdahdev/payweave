/**
 * `payweave init` (docs/v1/cli.md §1).
 *
 * Four layers of coverage, mirroring `push.test.ts`/`status.test.ts`:
 *   1. `detectFramework` against committed fixture projects
 *      (`test/fixtures/cli/init-detect-*`).
 *   2. The pure `./templates` renderers + `planScaffold` — string-content
 *      assertions, no filesystem I/O.
 *   3. `runInitCommand` — flags, the injectable `InitPrompts` seam, overwrite
 *      gating, exit codes — against ephemeral temp dirs (cleaned up every
 *      test) with a hand-built fake `InitPrompts`.
 *   4. Scaffold VALIDITY: a real PW-1002 `loadConfig()` round trip for the
 *      two combinations whose adapters are genuinely implemented today
 *      (`"none"` and `sqlite` — see the `describe("scaffold validity"...)`
 *      block's own doc comment for why `postgres`/`mysql`/`mongodb`/`prisma`
 *      get a lighter treatment), PLUS a real multi-file TypeScript semantic
 *      typecheck (via the `typescript` compiler API, resolved against the
 *      REAL BUILT `dist/` through a dedicated node_modules symlink — same
 *      technique `config-loader.test.ts` uses, just a separate symlink
 *      directory so the two suites' beforeAll/afterAll lifecycles never race
 *      on the same path).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";

import type { CliIo } from "../../src/cli/command";
import {
  detectFramework,
  detectPackageManager,
  findAppModule,
  initCommand,
  planScaffold,
  runInitCommand,
  wirePayweaveModule,
  type InitPrompts,
  type PackageManager,
  type RunToCompletion,
} from "../../src/cli/init";
import {
  mergeEnvExample,
  renderClientFile,
  renderDrizzleSchema,
  renderEnvExample,
  renderNestPayweaveModule,
  renderNestPayweaveService,
  renderNestReadme,
  renderNestWebhookController,
  renderPayweaveConfig,
  renderPrismaSchema,
  renderProducts,
  renderWebhookRoute,
  type DatabaseChoice,
  type FrameworkId,
  type ProviderId,
} from "../../src/cli/templates";
import { isPayweaveClientLike, loadConfig } from "../../src/cli/config-loader";

// ── Shared capture/io helper (push.test.ts / status.test.ts precedent) ──────

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
};

// ── Isolated fixture tree for THIS suite (own node_modules symlink — never
// shares a path with config-loader.test.ts's own `test/fixtures/cli/node_modules`,
// so the two suites' beforeAll/afterAll lifecycles can never race) ─────────

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const detectFixture = (name: string): string => resolve(pkgRoot, "test/fixtures/cli", name);

const initFixturesRoot = resolve(pkgRoot, "test/fixtures/cli/init");
const initNodeModules = join(initFixturesRoot, "node_modules");
const payweaveLink = join(initNodeModules, "payweave");

beforeAll(() => {
  mkdirSync(initNodeModules, { recursive: true });
  if (!existsSync(payweaveLink)) {
    symlinkSync(pkgRoot, payweaveLink, "dir");
  }
});

afterAll(() => {
  rmSync(initFixturesRoot, { recursive: true, force: true });
});

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  mkdirSync(initFixturesRoot, { recursive: true });
  const dir = mkdtempSync(join(initFixturesRoot, "tmp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fake InitPrompts (the non-interactive test seam cli.md/PW-1005 asks for) ─

interface FakePromptsResult {
  readonly prompts: InitPrompts;
  readonly confirmOverwriteCalls: string[];
}

function fakePrompts(
  config: {
    providers?: readonly ProviderId[];
    database?: DatabaseChoice;
    confirmOverwrite?: (relPath: string) => Promise<boolean>;
    selectProviders?: () => Promise<readonly ProviderId[]>;
    selectDatabase?: () => Promise<DatabaseChoice>;
  } = {},
): FakePromptsResult {
  const confirmOverwriteCalls: string[] = [];
  const confirmOverwriteImpl = config.confirmOverwrite ?? (async () => false);
  return {
    confirmOverwriteCalls,
    prompts: {
      selectProviders: config.selectProviders ?? (async () => config.providers ?? ["stripe"]),
      selectDatabase: config.selectDatabase ?? (async () => config.database ?? "sqlite"),
      confirmOverwrite: async (relPath) => {
        confirmOverwriteCalls.push(relPath);
        return confirmOverwriteImpl(relPath);
      },
    },
  };
}

// ── TypeScript compiler-API helpers ──────────────────────────────────────────

/**
 * Full multi-file SEMANTIC typecheck against the REAL built SDK (`dist/`,
 * resolved via the symlink above) — proves the scaffolded files not only
 * parse but that every import resolves and every call typechecks.
 */
// Explicit, not left to TypeScript's implicit directory-walking discovery —
// that walk's starting point depends on the host's cwd/rootNames in ways
// that don't reliably agree between environments (a scaffolded fixture
// under test/fixtures/cli/init/tmp-* is well outside this package's own
// node_modules). Pointing typeRoots directly at this package's own
// node_modules/@types removes that ambiguity.
const PACKAGE_TYPE_ROOTS = [fileURLToPath(new URL("../../node_modules/@types", import.meta.url))];

function typecheckFiles(absPaths: readonly string[], options: { dom?: boolean } = {}): string[] {
  const lib = options.dom ? ["lib.es2022.d.ts", "lib.dom.d.ts"] : ["lib.es2022.d.ts"];
  const program = ts.createProgram({
    rootNames: [...absPaths],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      noEmit: true,
      lib,
      types: ["node"],
      typeRoots: PACKAGE_TYPE_ROOTS,
    },
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file !== undefined && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      return `${d.file.fileName}:${pos.line + 1}:${pos.character + 1} - ${message}`;
    }
    return message;
  });
}

/**
 * SYNTAX-only check (no module resolution, no external types needed) — used
 * for every generated file, including the Express/Fastify webhook routes
 * whose framework type packages aren't installed in THIS monorepo (they'd be
 * installed in whatever real project `init` detected express/fastify from).
 */
function assertParses(contents: string, label: string): void {
  const result = ts.transpileModule(contents, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errors, `${label} failed to parse: ${JSON.stringify(errors.map((d) => d.messageText))}`).toHaveLength(0);
}

/** Mirrors (a subset of) `scripts/check-no-secrets.mjs`'s shape patterns — no committed template may match these. */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)_test_[A-Za-z0-9]{20,}\b/,
  /\bwhsec_[A-Za-z0-9]{20,}\b/,
  /\bFLWSECK[A-Za-z0-9_]*-[A-Za-z0-9]{20,}\b/,
];
function assertNoSecretShapes(content: string, label: string): void {
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    expect(content, `${label} matched a secret-shaped pattern (${pattern})`).not.toMatch(pattern);
  }
}

// ── 1. Framework detection ───────────────────────────────────────────────────

describe("detectFramework", () => {
  it("detects Next.js from a package.json dependency", () => {
    expect(detectFramework(detectFixture("init-detect-next"))).toBe("next");
  });

  it("detects Next.js from a next.config.mjs filesystem marker alone (no package.json)", () => {
    expect(detectFramework(detectFixture("init-detect-next-config-only"))).toBe("next");
  });

  it("detects Express from a package.json dependency", () => {
    expect(detectFramework(detectFixture("init-detect-express"))).toBe("express");
  });

  it("detects Fastify from a package.json dependency", () => {
    expect(detectFramework(detectFixture("init-detect-fastify"))).toBe("fastify");
  });

  it("detects NestJS from a package.json dependency, even alongside express (precedence)", () => {
    // The fixture also depends on express (Nest's own default HTTP adapter) —
    // this proves @nestjs/core is checked BEFORE express, not the reverse.
    expect(detectFramework(detectFixture("init-detect-nest"))).toBe("nest");
  });

  it("falls back to the plain node:http target when nothing matches", () => {
    expect(detectFramework(detectFixture("init-detect-generic"))).toBe("node");
  });

  it("falls back to node when there is no package.json at all (fresh empty directory)", () => {
    const dir = makeTmpDir();
    expect(detectFramework(dir)).toBe("node");
  });

  it("falls back to node on a malformed package.json rather than throwing", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), "{ not valid json", "utf8");
    expect(detectFramework(dir)).toBe("node");
  });
});

describe("detectPackageManager", () => {
  it.each<[string, PackageManager]>([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ])("detects %s as %s", (lockfile, manager) => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, lockfile), "", "utf8");
    expect(detectPackageManager(dir)).toBe(manager);
  });

  it("defaults to npm when no lockfile is present", () => {
    expect(detectPackageManager(makeTmpDir())).toBe("npm");
  });

  it("prefers pnpm-lock.yaml over package-lock.json when both are somehow present", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "pnpm-lock.yaml"), "", "utf8");
    writeFileSync(join(dir, "package-lock.json"), "{}", "utf8");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });
});

// ── 2. Template renderers (pure — no filesystem I/O) ────────────────────────

describe("template renderers", () => {
  it("renderPayweaveConfig: single provider, no database — omits defaultProvider and products", () => {
    const content = renderPayweaveConfig({ providers: ["stripe"], database: "none", framework: "node" });
    expect(content).toContain('import { createPayweave } from "payweave";');
    expect(content).toContain("STRIPE_SECRET_KEY");
    expect(content).toContain("STRIPE_WEBHOOK_SECRET");
    expect(content).not.toContain("defaultProvider");
    expect(content).not.toContain("products:");
    expect(content).not.toContain('import { free, pro } from "./products";');
    assertParses(content, "payweave.ts (stripe/none)");
    assertNoSecretShapes(content, "payweave.ts (stripe/none)");
  });

  it("renderPayweaveConfig: multiple providers requires defaultProvider (unified-config.md §2 rule 3)", () => {
    const content = renderPayweaveConfig({
      providers: ["stripe", "paystack"],
      database: "none",
      framework: "node",
    });
    expect(content).toContain('defaultProvider: "stripe"');
    assertParses(content, "payweave.ts (multi-provider)");
  });

  it("renderPayweaveConfig: paystack has no webhookSecret field (webhook scheme signs with the secret key)", () => {
    const content = renderPayweaveConfig({ providers: ["paystack"], database: "none", framework: "node" });
    expect(content).toContain("PAYSTACK_SECRET_KEY");
    expect(content).not.toContain("PAYSTACK_WEBHOOK_SECRET");
  });

  it.each<[DatabaseChoice, string, string]>([
    ["prisma", 'import { prismaAdapter } from "payweave/db/prisma";', "prismaAdapter(prisma)"],
    ["drizzle", 'import { drizzleAdapter } from "payweave/db/drizzle";', "drizzleAdapter(db)"],
    [
      "postgres",
      'import { postgresAdapter } from "payweave/db/postgres";',
      "postgresAdapter({ connectionString: process.env.DATABASE_URL! })",
    ],
    ["mysql", 'import { mysqlAdapter } from "payweave/db/mysql";', "mysqlAdapter({ uri: process.env.DATABASE_URL! })"],
    ["sqlite", 'import { sqliteAdapter } from "payweave/db/sqlite";', "sqliteAdapter({"],
    [
      "mongodb",
      'import { mongodbAdapter } from "payweave/db/mongodb";',
      'mongodbAdapter({ url: process.env.MONGODB_URI!, dbName: "app" })',
    ],
  ])("renderPayweaveConfig: %s wires the documented database.md §1 import + factory shape", (database, importLine, factoryCall) => {
    const content = renderPayweaveConfig({ providers: ["stripe"], database, framework: "node" });
    expect(content).toContain(importLine);
    expect(content).toContain(factoryCall);
    expect(content).toContain('import { free, pro } from "./products";');
    expect(content).toContain("products: [free, pro]");
    assertParses(content, `payweave.ts (${database})`);
    assertNoSecretShapes(content, `payweave.ts (${database})`);
  });

  it("renderProducts: imports feature/plan from the package root and exports free + pro", () => {
    const content = renderProducts();
    expect(content).toContain('import { feature, plan } from "payweave";');
    expect(content).toContain('export const free = plan({');
    expect(content).toContain('export const pro = plan({');
    expect(content).toContain('default: true');
    assertParses(content, "products.ts");
  });

  it("renderEnvExample: names only, never real-looking secret values", () => {
    const content = renderEnvExample({
      providers: ["stripe", "paystack", "flutterwave"],
      database: "postgres",
      framework: "node",
    });
    expect(content).toContain("STRIPE_SECRET_KEY=");
    expect(content).toContain("STRIPE_WEBHOOK_SECRET=");
    expect(content).toContain("PAYSTACK_SECRET_KEY=");
    expect(content).toContain("FLUTTERWAVE_SECRET_KEY=");
    expect(content).toContain("FLUTTERWAVE_WEBHOOK_SECRET=");
    expect(content).toContain("DATABASE_URL=");
    // Every var line is bare `NAME=` — no value ever follows the `=`.
    for (const line of content.split("\n")) {
      if (line.includes("=")) expect(line.trim()).toMatch(/^[A-Z_]+=$/);
    }
    assertNoSecretShapes(content, ".env.example");
  });

  it("renderEnvExample: mongodb gets MONGODB_URI, not DATABASE_URL", () => {
    const content = renderEnvExample({ providers: ["stripe"], database: "mongodb", framework: "node" });
    expect(content).toContain("MONGODB_URI=");
    expect(content).not.toContain("DATABASE_URL=");
  });

  it("renderEnvExample: prisma/drizzle/none add no extra database env block", () => {
    for (const database of ["none", "prisma", "drizzle"] as const) {
      const content = renderEnvExample({ providers: ["stripe"], database, framework: "node" });
      expect(content).not.toContain("DATABASE_URL=");
      expect(content).not.toContain("MONGODB_URI=");
    }
  });

  // NestJS is excluded — it doesn't go through renderWebhookRoute at all
  // (see the "NestJS scaffold renderers" describe block below).
  const FRAMEWORK_PATHS: Record<Exclude<FrameworkId, "nest">, string> = {
    next: "app/api/webhooks/payweave/route.ts",
    express: "payweave-webhook.ts",
    fastify: "payweave-webhook-plugin.ts",
    node: "payweave-webhook-server.ts",
  };

  it.each(Object.keys(FRAMEWORK_PATHS) as Exclude<FrameworkId, "nest">[])(
    "renderWebhookRoute: %s writes to the documented path and imports payweave.webhooks.constructEvent",
    (framework) => {
      const file = renderWebhookRoute(framework);
      expect(file.relPath).toBe(FRAMEWORK_PATHS[framework]);
      expect(file.contents).toContain("payweave.webhooks.constructEvent");
      expect(file.contents).toContain("event.apply()");
      assertParses(file.contents, `webhook route (${framework})`);
    },
  );

  it("renderWebhookRoute: Next.js computes the correct relative import depth back to payweave.ts", () => {
    const file = renderWebhookRoute("next");
    expect(file.contents).toContain('from "../../../../payweave";');
  });

  it("renderWebhookRoute: root-level frameworks import payweave from ./payweave", () => {
    for (const framework of ["express", "fastify", "node"] as const) {
      const file = renderWebhookRoute(framework);
      expect(file.contents).toContain('from "./payweave";');
    }
  });

  it("renderPrismaSchema: emits the pw_ table fragment, no pw_migrations (database.md §4)", () => {
    const file = renderPrismaSchema();
    expect(file.relPath).toBe("payweave.prisma");
    expect(file.contents).toContain('@@map("pw_plans")');
    expect(file.contents).toContain('@@map("pw_subscriptions")');
    expect(file.contents).not.toContain("pw_migrations");
  });

  it("renderDrizzleSchema: re-exports the REAL shipped payweave/db/drizzle schemas, doesn't duplicate them", () => {
    const file = renderDrizzleSchema();
    expect(file.relPath).toBe("payweave-schema.ts");
    expect(file.contents).toContain('from "payweave/db/drizzle"');
    assertParses(file.contents, "payweave-schema.ts");
  });

  it("renderClientFile: a fetch wrapper, never imports the SDK itself (server-only)", () => {
    const file = renderClientFile();
    expect(file.relPath).toBe("lib/payweave-client.ts");
    expect(file.contents).not.toContain('from "payweave"');
    expect(file.contents).toContain("fetch(");
    assertParses(file.contents, "lib/payweave-client.ts");
  });

  it("mergeEnvExample: appends only the blocks with a var not already present", () => {
    const existing = "# my own notes\nCUSTOM_VAR=already-here\n";
    const merged = mergeEnvExample({ providers: ["stripe"], database: "none", framework: "node" }, existing);
    expect(merged).toContain("CUSTOM_VAR=already-here");
    expect(merged).toContain("STRIPE_SECRET_KEY=");
    assertNoSecretShapes(merged ?? "", ".env.example (merged)");
  });

  it("mergeEnvExample: returns undefined when every needed var is already present (true no-op)", () => {
    const existing = renderEnvExample({ providers: ["stripe"], database: "none", framework: "node" });
    const merged = mergeEnvExample({ providers: ["stripe"], database: "none", framework: "node" }, existing);
    expect(merged).toBeUndefined();
  });

  it("mergeEnvExample: a newly-added provider appends just its own block, not a duplicate of the existing one", () => {
    const existing = renderEnvExample({ providers: ["stripe"], database: "none", framework: "node" });
    const merged = mergeEnvExample(
      { providers: ["stripe", "paystack"], database: "none", framework: "node" },
      existing,
    );
    expect(merged).toContain("PAYSTACK_SECRET_KEY=");
    expect(merged?.split("STRIPE_SECRET_KEY=")).toHaveLength(2); // appears once — not re-added
  });
});

// ── 2b. NestJS scaffold renderers (pure — no filesystem I/O) ────────────────

describe("NestJS scaffold renderers", () => {
  it("renderNestPayweaveService: wraps createPayweave in an injectable service, reusing the root renderer's provider config shape", () => {
    const file = renderNestPayweaveService({ providers: ["stripe"], database: "none", framework: "nest" });
    expect(file.relPath).toBe("src/payweave/payweave.service.ts");
    expect(file.contents).toContain('import { Injectable } from "@nestjs/common";');
    expect(file.contents).toContain("@Injectable()");
    expect(file.contents).toContain("export class PayweaveService {");
    expect(file.contents).toContain("readonly client = createPayweave({");
    expect(file.contents).toContain("STRIPE_SECRET_KEY");
    assertParses(file.contents, "payweave.service.ts (stripe/none)");
    assertNoSecretShapes(file.contents, "payweave.service.ts (stripe/none)");
  });

  it("renderNestPayweaveService: multiple providers still requires defaultProvider", () => {
    const file = renderNestPayweaveService({
      providers: ["stripe", "paystack"],
      database: "none",
      framework: "nest",
    });
    expect(file.contents).toContain('defaultProvider: "stripe"');
    assertParses(file.contents, "payweave.service.ts (multi-provider)");
  });

  it("renderNestPayweaveService: a configured database imports products from the SAME payweave folder, not the project root", () => {
    const file = renderNestPayweaveService({ providers: ["stripe"], database: "sqlite", framework: "nest" });
    expect(file.contents).toContain('import { free, pro } from "./products";');
    expect(file.contents).toContain("products: [free, pro]");
    assertParses(file.contents, "payweave.service.ts (sqlite)");
  });

  it("renderNestPayweaveService: prisma/drizzle point one directory shallower than the root renderer (../lib/*, not ./lib/*)", () => {
    const prisma = renderNestPayweaveService({ providers: ["stripe"], database: "prisma", framework: "nest" });
    expect(prisma.contents).toContain('from "../lib/prisma";');
    const drizzle = renderNestPayweaveService({ providers: ["stripe"], database: "drizzle", framework: "nest" });
    expect(drizzle.contents).toContain('from "../lib/db";');
  });

  it("renderNestWebhookController: injects PayweaveService via DI rather than constructing its own client", () => {
    const file = renderNestWebhookController();
    expect(file.relPath).toBe("src/payweave/payweave-webhook.controller.ts");
    expect(file.contents).toContain('import { PayweaveService } from "./payweave.service";');
    expect(file.contents).toContain("constructor(private readonly payweaveService: PayweaveService)");
    expect(file.contents).toContain("this.payweaveService.client.webhooks.constructEvent");
    expect(file.contents).toContain("RawBodyRequest");
    expect(file.contents).toContain("rawBody: true");
    expect(file.contents).toContain("req.rawBody");
    assertParses(file.contents, "payweave-webhook.controller.ts");
  });

  it("renderNestPayweaveModule: wires the service + controller together and exports the service", () => {
    const file = renderNestPayweaveModule();
    expect(file.relPath).toBe("src/payweave/payweave.module.ts");
    expect(file.contents).toContain("providers: [PayweaveService]");
    expect(file.contents).toContain("controllers: [PayweaveWebhookController]");
    expect(file.contents).toContain("exports: [PayweaveService]");
    assertParses(file.contents, "payweave.module.ts");
  });

  it("renderNestReadme: documents products.ts + npx payweave push only when a database is configured", () => {
    const withDb = renderNestReadme({ providers: ["stripe"], database: "sqlite", framework: "nest" });
    expect(withDb.relPath).toBe("src/payweave/README.md");
    expect(withDb.contents).toContain("products.ts");
    expect(withDb.contents).toContain("npx payweave push");

    const withoutDb = renderNestReadme({ providers: ["stripe"], database: "none", framework: "nest" });
    expect(withoutDb.contents).not.toContain("products.ts");
  });

  it("renderNestReadme: always documents the rawBody: true bootstrap requirement", () => {
    const file = renderNestReadme({ providers: ["stripe"], database: "none", framework: "nest" });
    expect(file.contents).toContain("rawBody: true");
  });
});

describe("planScaffold", () => {
  it("always includes payweave.ts, .env.example, a webhook route, and the client file", () => {
    const files = planScaffold({ providers: ["stripe"], database: "none", framework: "node" });
    const paths = files.map((f) => f.relPath);
    expect(paths).toEqual(
      expect.arrayContaining([
        "payweave.ts",
        ".env.example",
        "payweave-webhook-server.ts",
        "lib/payweave-client.ts",
      ]),
    );
    expect(paths).not.toContain("payweave.prisma");
    expect(paths).not.toContain("payweave-schema.ts");
  });

  it("includes products.ts when a database is configured", () => {
    const paths = planScaffold({ providers: ["stripe"], database: "sqlite", framework: "node" }).map(
      (f) => f.relPath,
    );
    expect(paths).toContain("products.ts");
  });

  it("omits products.ts for database: \"none\" — no database means no plans/features surface", () => {
    const paths = planScaffold({ providers: ["stripe"], database: "none", framework: "node" }).map(
      (f) => f.relPath,
    );
    expect(paths).not.toContain("products.ts");
  });

  it("adds payweave.prisma only for the prisma database choice", () => {
    const paths = planScaffold({ providers: ["stripe"], database: "prisma", framework: "node" }).map(
      (f) => f.relPath,
    );
    expect(paths).toContain("payweave.prisma");
    expect(paths).not.toContain("payweave-schema.ts");
  });

  it("adds payweave-schema.ts only for the drizzle database choice", () => {
    const paths = planScaffold({ providers: ["stripe"], database: "drizzle", framework: "node" }).map(
      (f) => f.relPath,
    );
    expect(paths).toContain("payweave-schema.ts");
    expect(paths).not.toContain("payweave.prisma");
  });

  it("nest: scaffolds a payweave module instead of the generic root files", () => {
    const paths = planScaffold({ providers: ["stripe"], database: "none", framework: "nest" }).map(
      (f) => f.relPath,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "src/payweave/payweave.service.ts",
        "src/payweave/payweave-webhook.controller.ts",
        "src/payweave/payweave.module.ts",
        "src/payweave/README.md",
        ".env.example",
      ]),
    );
    expect(paths).not.toContain("payweave.ts");
    expect(paths).not.toContain("lib/payweave-client.ts");
    expect(paths.some((p) => p.endsWith("products.ts"))).toBe(false);
  });

  it("nest + a configured database: products.ts lives inside src/payweave/, not at the project root", () => {
    const paths = planScaffold({ providers: ["stripe"], database: "sqlite", framework: "nest" }).map(
      (f) => f.relPath,
    );
    expect(paths).toContain("src/payweave/products.ts");
    expect(paths).not.toContain("products.ts");
  });

  it("nest still gets the root-level Prisma/Drizzle schema fragment", () => {
    const prismaPaths = planScaffold({ providers: ["stripe"], database: "prisma", framework: "nest" }).map(
      (f) => f.relPath,
    );
    expect(prismaPaths).toContain("payweave.prisma");
    const drizzlePaths = planScaffold({ providers: ["stripe"], database: "drizzle", framework: "nest" }).map(
      (f) => f.relPath,
    );
    expect(drizzlePaths).toContain("payweave-schema.ts");
  });
});

// ── 2c. NestJS app.module.ts auto-wire (pure string transform + fs discovery) ─

describe("wirePayweaveModule", () => {
  const FRESH_APP_MODULE = [
    `import { Module } from "@nestjs/common";`,
    `import { AppController } from "./app.controller";`,
    `import { AppService } from "./app.service";`,
    "",
    "@Module({",
    "  imports: [],",
    "  controllers: [AppController],",
    "  providers: [AppService],",
    "})",
    "export class AppModule {}",
    "",
  ].join("\n");

  it("adds the import and fills an empty imports array", () => {
    const result = wirePayweaveModule(FRESH_APP_MODULE, "./payweave/payweave.module");
    expect(result).toContain('import { PayweaveModule } from "./payweave/payweave.module";');
    expect(result).toContain("imports: [PayweaveModule]");
  });

  it("appends to an already-populated imports array", () => {
    const withExisting = FRESH_APP_MODULE.replace("imports: []", "imports: [ConfigModule]");
    const result = wirePayweaveModule(withExisting, "./payweave/payweave.module");
    expect(result).toContain("imports: [ConfigModule, PayweaveModule]");
  });

  it("handles a trailing comma in an existing imports array without producing a double comma", () => {
    const withTrailingComma = FRESH_APP_MODULE.replace("imports: []", "imports: [ConfigModule,]");
    const result = wirePayweaveModule(withTrailingComma, "./payweave/payweave.module");
    expect(result).toContain("imports: [ConfigModule, PayweaveModule]");
    expect(result).not.toContain(",,");
  });

  // Regression: a real run against a production NestJS app.module.ts inserted
  // PayweaveModule INSIDE ConfigModule.forRoot's `load` array instead of the
  // outer imports array, because a naive "stop at the first ]" scan hit
  // `load: [() => env]`'s closing bracket before the outer array's own.
  // ConfigModule.forRoot({ load: [...] }) (and similar `*.forRootAsync({...})`
  // calls) are extremely common inside a real imports array, so this is a
  // realistic case, not a contrived one.
  it("a nested array inside a forRoot(...) call doesn't get mistaken for the outer imports array's close", () => {
    const withNestedArray = [
      `import { Module } from "@nestjs/common";`,
      `import { ConfigModule } from "@nestjs/config";`,
      `import { DatabaseModule } from "./database/database.module";`,
      `import { env } from "./common/env";`,
      "",
      "@Module({",
      "  imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => env] }),",
      "    DatabaseModule,",
      "  ],",
      "})",
      "export class AppModule {}",
      "",
    ].join("\n");
    const result = wirePayweaveModule(withNestedArray, "./payweave/payweave.module");
    // The bug: this string showing up ANYWHERE means PayweaveModule ended up
    // inside `load`'s factory array instead of as an imports-array sibling.
    expect(result).not.toContain("load: [() => env, PayweaveModule]");
    expect(result).toContain("load: [() => env]");
    expect(result).toContain("DatabaseModule, PayweaveModule");
    assertParses(result, "app.module.ts (nested forRoot call)");
  });

  it("a nested object literal (forRootAsync-style) doesn't get mistaken for the outer imports array's close", () => {
    const withNestedObject = [
      `import { Module } from "@nestjs/common";`,
      `import { TypeOrmModule } from "@nestjs/typeorm";`,
      `import { SharedModule } from "./shared/shared.module";`,
      "",
      "@Module({",
      "  imports: [",
      "    TypeOrmModule.forRootAsync({ useFactory: () => ({ type: \"postgres\" }) }),",
      "    SharedModule,",
      "  ],",
      "})",
      "export class AppModule {}",
      "",
    ].join("\n");
    const result = wirePayweaveModule(withNestedObject, "./payweave/payweave.module");
    expect(result).toContain("SharedModule, PayweaveModule");
    expect(result).not.toContain('"postgres" }), PayweaveModule');
    assertParses(result, "app.module.ts (nested forRootAsync call)");
  });

  it("an unbalanced bracket character inside a string literal doesn't throw off the depth count", () => {
    // "weird]bracket" has a lone `]` with no matching `[` — without
    // quote-awareness this decrements depth prematurely and the scanner
    // would think the array closed at the wrong `)`.
    const withBracketInString = [
      `import { Module } from "@nestjs/common";`,
      `import { FilesModule } from "./files/files.module";`,
      "",
      "@Module({",
      '  imports: [FilesModule.register({ path: "weird]bracket" }), FilesModule],',
      "})",
      "export class AppModule {}",
      "",
    ].join("\n");
    const result = wirePayweaveModule(withBracketInString, "./payweave/payweave.module");
    expect(result).toContain('path: "weird]bracket"'); // the string literal itself is untouched
    expect(result).toContain("}), FilesModule, PayweaveModule");
    assertParses(result, "app.module.ts (bracket inside string)");
  });

  it("is idempotent — returns the input completely unchanged when PayweaveModule is already present", () => {
    const alreadyWired = wirePayweaveModule(FRESH_APP_MODULE, "./payweave/payweave.module");
    const result = wirePayweaveModule(alreadyWired, "./payweave/payweave.module");
    expect(result).toBe(alreadyWired);
  });

  it("inserts the import line immediately after the last existing import statement", () => {
    const result = wirePayweaveModule(FRESH_APP_MODULE, "./payweave/payweave.module");
    const lines = result.split("\n");
    const lastOriginalImportIndex = lines.indexOf('import { AppService } from "./app.service";');
    expect(lines[lastOriginalImportIndex + 1]).toBe('import { PayweaveModule } from "./payweave/payweave.module";');
  });

  it("still adds the import even with no imports: [] array present to update", () => {
    const noImportsArray = [
      `import { Module } from "@nestjs/common";`,
      "",
      "@Module({",
      "  controllers: [],",
      "})",
      "export class AppModule {}",
      "",
    ].join("\n");
    const result = wirePayweaveModule(noImportsArray, "./payweave/payweave.module");
    expect(result).toContain('import { PayweaveModule } from "./payweave/payweave.module";');
  });

  it("output still parses as valid TypeScript", () => {
    const result = wirePayweaveModule(FRESH_APP_MODULE, "./payweave/payweave.module");
    assertParses(result, "app.module.ts (wired)");
  });
});

describe("findAppModule", () => {
  it("finds the nest new convention: src/app.module.ts", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/app.module.ts"), "export class AppModule {}\n", "utf8");
    expect(findAppModule(dir)).toBe(join(dir, "src/app.module.ts"));
  });

  it("falls back to a recursive search when app.module.ts isn't at the conventional path", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "apps/api/src"), { recursive: true });
    writeFileSync(join(dir, "apps/api/src/app.module.ts"), "export class AppModule {}\n", "utf8");
    expect(findAppModule(dir)).toBe(join(dir, "apps/api/src/app.module.ts"));
  });

  it("ignores node_modules while walking", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "node_modules/some-dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules/some-dep/app.module.ts"), "// not the real one\n", "utf8");
    expect(findAppModule(dir)).toBeUndefined();
  });

  it("returns undefined when nothing is found", () => {
    expect(findAppModule(makeTmpDir())).toBeUndefined();
  });
});

// ── 3. runInitCommand — flags, gating, exit codes ───────────────────────────

describe("runInitCommand", () => {
  it("refuses to run without an interactive terminal when no prompts seam is injected", async () => {
    const { io, err } = capture();
    const code = await runInitCommand([], io, { cwd: makeTmpDir(), isInteractive: false });
    expect(code).toBe(1);
    expect(err()).toContain("needs an interactive terminal");
  });

  it("an injected prompts seam bypasses the interactivity guard entirely (isInteractive: false)", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts, isInteractive: false });
    expect(code).toBe(0);
    expect(existsSync(join(dir, "payweave.ts"))).toBe(true);
  });

  it("scaffolds payweave.ts, products.ts, .env.example, a webhook route, and a client file", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "sqlite" });
    const { io, out } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    for (const relPath of [
      "payweave.ts",
      "products.ts",
      ".env.example",
      "payweave-webhook-server.ts",
      "lib/payweave-client.ts",
    ]) {
      expect(existsSync(join(dir, relPath)), `${relPath} should exist`).toBe(true);
    }
    expect(out()).toContain("Framework:");
    expect(out()).toContain("file(s) written");
  });

  it("--force overwrites an existing file without ever calling confirmOverwrite", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "payweave.ts"), "// stale content\n", "utf8");
    const { prompts, confirmOverwriteCalls } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    const code = await runInitCommand(["--force", "--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(confirmOverwriteCalls).toEqual([]);
    const content = readFileSync(join(dir, "payweave.ts"), "utf8");
    expect(content).not.toContain("stale content");
    expect(content).toContain("createPayweave");
  });

  it("-f is the short alias for --force", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "payweave.ts"), "// stale\n", "utf8");
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    const code = await runInitCommand(["-f", "--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "payweave.ts"), "utf8")).not.toContain("stale");
  });

  it("default (no --force) refuses to clobber an existing payweave.ts: clear error, exit non-zero, file untouched", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "payweave.ts"), "// keep me\n", "utf8");
    const { prompts, confirmOverwriteCalls } = fakePrompts({
      providers: ["stripe"],
      database: "sqlite",
      confirmOverwrite: async () => false,
    });
    const { io, err } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(1);
    expect(confirmOverwriteCalls).toContain("payweave.ts");
    expect(err()).toContain("payweave.ts");
    expect(err()).toContain("--force");
    expect(readFileSync(join(dir, "payweave.ts"), "utf8")).toBe("// keep me\n");
    // Other, non-conflicting files still get written — only the collision blocks.
    expect(existsSync(join(dir, "products.ts"))).toBe(true);
  });

  it("confirming an overwrite interactively (seam returns true) does overwrite that one file", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "payweave.ts"), "// stale\n", "utf8");
    const { prompts } = fakePrompts({
      providers: ["stripe"],
      database: "none",
      confirmOverwrite: async () => true,
    });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "payweave.ts"), "utf8")).not.toContain("stale");
  });

  it("fails cleanly when the provider prompt throws (wizard cancelled)", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({
      selectProviders: async () => {
        throw new Error("user cancelled");
      },
    });
    const { io, err } = capture();
    const code = await runInitCommand([], io, { cwd: dir, prompts });
    expect(code).toBe(1);
    expect(err()).toContain("wizard failed");
    expect(existsSync(join(dir, "payweave.ts"))).toBe(false);
  });

  it("fails cleanly when confirmOverwrite itself throws", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "payweave.ts"), "// stale\n", "utf8");
    const { prompts } = fakePrompts({
      providers: ["stripe"],
      database: "none",
      confirmOverwrite: async () => {
        throw new Error("prompt io error");
      },
    });
    const { io, err } = capture();
    const code = await runInitCommand([], io, { cwd: dir, prompts });
    expect(code).toBe(1);
    expect(err()).toContain("wizard failed");
  });

  it("rejects zero providers even if an injected seam returns an empty array (defensive check)", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: [], database: "none" });
    const { io, err } = capture();
    const code = await runInitCommand([], io, { cwd: dir, prompts });
    expect(code).toBe(1);
    expect(err()).toContain("at least one provider is required");
  });

  it("redacts a secret-shaped string surfacing through a thrown prompt error", async () => {
    const dir = makeTmpDir();
    // Built at runtime so the live-key-shaped literal never appears in source
    // (the CI secret-scan hard-fails on any `sk_live_…` string, even a fake).
    const leaked = `sk_live_${"deadbeef".repeat(3)}`;
    const { prompts } = fakePrompts({
      selectProviders: async () => {
        throw new Error(`boom ${leaked}`);
      },
    });
    const { io, err } = capture();
    await runInitCommand([], io, { cwd: dir, prompts });
    expect(err()).not.toContain(leaked);
    expect(err()).toContain("[REDACTED]");
  });

  it("the registered initCommand wires straight into runInitCommand's non-interactive guard", async () => {
    expect(initCommand.name).toBe("init");
    const { io, err } = capture();
    // No injected prompts + no real TTY under the test runner => guard fires.
    const code = await initCommand.run([], io);
    expect(code).toBe(1);
    expect(err()).toContain("interactive terminal");
  });
});

// ── 3b. Install step — package manager detection + the injected subprocess seam ─

describe("runInitCommand: install step", () => {
  function fakeRunner(exitCode: number | null): {
    runToCompletion: RunToCompletion;
    calls: Array<{ command: string; args: readonly string[]; cwd: string }>;
  } {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    return {
      calls,
      runToCompletion: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { code: exitCode };
      },
    };
  }

  it("installs via the detected package manager by default and reports success", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "pnpm-lock.yaml"), "", "utf8");
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { runToCompletion, calls } = fakeRunner(0);
    const { io, out } = capture();
    const code = await runInitCommand([], io, { cwd: dir, prompts, runToCompletion });
    expect(code).toBe(0);
    expect(calls).toEqual([{ command: "pnpm", args: ["add", "payweave"], cwd: dir }]);
    expect(out()).toContain("Installing payweave with pnpm");
    expect(out()).toContain("payweave installed via pnpm");
  });

  it("uses npm's install-form add command when no lockfile is present", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { runToCompletion, calls } = fakeRunner(0);
    const { io } = capture();
    await runInitCommand([], io, { cwd: dir, prompts, runToCompletion });
    expect(calls).toEqual([{ command: "npm", args: ["install", "payweave"], cwd: dir }]);
  });

  it("--no-install skips the step entirely — the runner is never called", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { runToCompletion, calls } = fakeRunner(0);
    const { io, out } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts, runToCompletion });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out()).not.toContain("Installing payweave");
  });

  it("a failed install warns clearly but does not fail the overall command — the scaffold is what's promised", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { runToCompletion } = fakeRunner(1);
    const { io, err } = capture();
    const code = await runInitCommand([], io, { cwd: dir, prompts, runToCompletion });
    expect(code).toBe(0);
    expect(existsSync(join(dir, "payweave.ts"))).toBe(true);
    expect(err()).toContain("could not install payweave automatically");
    expect(err()).toContain("npm install payweave");
  });

  it("still attempts install even when a file conflict makes the overall command exit 1", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "payweave.ts"), "// keep me\n", "utf8");
    const { prompts } = fakePrompts({
      providers: ["stripe"],
      database: "none",
      confirmOverwrite: async () => false,
    });
    const { runToCompletion, calls } = fakeRunner(0);
    const { io } = capture();
    const code = await runInitCommand([], io, { cwd: dir, prompts, runToCompletion });
    expect(code).toBe(1); // the declined overwrite still fails the command...
    expect(calls).toHaveLength(1); // ...but install is orthogonal and still ran.
  });
});

// ── 3c. NestJS scaffold — end-to-end via runInitCommand ─────────────────────

describe("runInitCommand: NestJS scaffold", () => {
  const FRESH_APP_MODULE = [
    `import { Module } from "@nestjs/common";`,
    `import { AppController } from "./app.controller";`,
    `import { AppService } from "./app.service";`,
    "",
    "@Module({",
    "  imports: [],",
    "  controllers: [AppController],",
    "  providers: [AppService],",
    "})",
    "export class AppModule {}",
    "",
  ].join("\n");

  function makeNestProject(dir: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@nestjs/core": "11.0.0" } }), "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/app.module.ts"), FRESH_APP_MODULE, "utf8");
  }

  it("scaffolds the payweave module instead of the generic root files", async () => {
    const dir = makeTmpDir();
    makeNestProject(dir);
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    for (const relPath of [
      "src/payweave/payweave.service.ts",
      "src/payweave/payweave-webhook.controller.ts",
      "src/payweave/payweave.module.ts",
      "src/payweave/README.md",
      ".env.example",
    ]) {
      expect(existsSync(join(dir, relPath)), `${relPath} should exist`).toBe(true);
    }
    expect(existsSync(join(dir, "payweave.ts"))).toBe(false);
    expect(existsSync(join(dir, "lib/payweave-client.ts"))).toBe(false);
  });

  it("wires PayweaveModule into the project's own app.module.ts", async () => {
    const dir = makeTmpDir();
    makeNestProject(dir);
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io, out } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    const appModule = readFileSync(join(dir, "src/app.module.ts"), "utf8");
    expect(appModule).toContain('import { PayweaveModule } from "./payweave/payweave.module";');
    expect(appModule).toContain("imports: [PayweaveModule]");
    assertParses(appModule, "app.module.ts (wired)");
    expect(out()).toContain("added PayweaveModule to imports");
  });

  it("re-running init does not double-wire app.module.ts", async () => {
    const dir = makeTmpDir();
    makeNestProject(dir);
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    await runInitCommand(["--no-install", "--force"], capture().io, { cwd: dir, prompts });
    const { io, out } = capture();
    const code = await runInitCommand(["--no-install", "--force"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    const appModule = readFileSync(join(dir, "src/app.module.ts"), "utf8");
    expect(appModule.split("PayweaveModule").length - 1).toBe(2); // import line + array entry, once each
    expect(out()).toContain("already wired");
  });

  it("warns but does not fail the command when app.module.ts can't be found", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@nestjs/core": "11.0.0" } }), "utf8");
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io, err } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(err()).toContain("could not find app.module.ts");
  });

  it("a configured database puts products.ts inside src/payweave/, imported by payweave.service.ts", async () => {
    const dir = makeTmpDir();
    makeNestProject(dir);
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "sqlite" });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src/payweave/products.ts"))).toBe(true);
    expect(existsSync(join(dir, "products.ts"))).toBe(false);
    expect(readFileSync(join(dir, "src/payweave/payweave.service.ts"), "utf8")).toContain('from "./products"');
  });
});

// ── 3d. .env.example merge — never clobbered, appended instead ──────────────

describe("runInitCommand: .env.example merge", () => {
  it("creates .env.example fresh when it doesn't exist yet", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("STRIPE_SECRET_KEY=");
  });

  it("appends missing vars to an existing .env.example instead of overwriting it", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, ".env.example"), "# my own notes\nCUSTOM_VAR=already-here\n", "utf8");
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io, out } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    const content = readFileSync(join(dir, ".env.example"), "utf8");
    expect(content).toContain("CUSTOM_VAR=already-here");
    expect(content).toContain("STRIPE_SECRET_KEY=");
    expect(out()).toContain("appended new variables");
  });

  it("never prompts confirmOverwrite for .env.example", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, ".env.example"), "FOO=bar\n", "utf8");
    const { prompts, confirmOverwriteCalls } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(confirmOverwriteCalls).not.toContain(".env.example");
  });

  it("re-running with unchanged answers is a true no-op", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    await runInitCommand(["--no-install", "--force"], capture().io, { cwd: dir, prompts });
    const before = readFileSync(join(dir, ".env.example"), "utf8");
    const { io, out } = capture();
    await runInitCommand(["--no-install", "--force"], io, { cwd: dir, prompts });
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toBe(before);
    expect(out()).toContain("already up to date");
  });

  it("--force does not force-overwrite .env.example — it still only appends", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, ".env.example"), "CUSTOM_VAR=keep-me\n", "utf8");
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "none" });
    const { io } = capture();
    await runInitCommand(["--force", "--no-install"], io, { cwd: dir, prompts });
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("CUSTOM_VAR=keep-me");
  });
});

// ── 4. Scaffold validity ─────────────────────────────────────────────────────
//
// `postgres`/`mysql`/`mongodb`/`prisma` adapters are STILL PLACEHOLDERS as of
// this ticket — `payweave/db/{postgres,mysql,mongodb,prisma}` always throw
// `PayweaveConfigError` regardless of their argument shape (PW-704/705/709/707
// haven't landed; see each module's own doc comment). That means a real
// end-to-end `loadConfig()` round trip can't prove anything about THOSE
// combinations' argument shapes today — the placeholder throws before schema
// validation would even matter. What CAN be proven for every combination,
// and is asserted in the "template renderers" describe block above, is that
// the generated import specifier + factory-call shape matches database.md
// §1's documented examples verbatim. Only `"none"` and `"sqlite"` (the one
// SQL adapter that IS real, PW-706) get the full, real, running-client
// treatment here — plus a full semantic TypeScript typecheck against the
// actual built `dist/`.
describe("scaffold validity", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "PAYSTACK_SECRET_KEY",
    "FLUTTERWAVE_SECRET_KEY",
    "FLUTTERWAVE_WEBHOOK_SECRET",
    "DATABASE_URL",
  ] as const;

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
      delete savedEnv[key];
    }
  });

  function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  it("Next.js + Stripe + SQLite: scaffolds a config that REALLY loads (PW-1002 loadConfig) and typechecks", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["stripe"], database: "sqlite" });
    const { io } = capture();
    const framework = "next";
    // Drive the wizard with framework detection forced by placing a next
    // marker in the temp project (mirrors a real Next.js project).
    writeFileSync(join(dir, "next.config.mjs"), "export default {};\n", "utf8");
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(detectFramework(dir)).toBe(framework);

    setEnv("STRIPE_SECRET_KEY", "sk_test_init_wizard_fixture");
    setEnv("STRIPE_WEBHOOK_SECRET", "whsec_init_wizard_fixture");
    // Override the template's file-based default so this test never touches
    // a real file on disk (sqliteAdapter's better-sqlite3 driver opens
    // synchronously) — the template reads DATABASE_URL when present.
    setEnv("DATABASE_URL", ":memory:");

    const loaded = await loadConfig({ cwd: dir });
    expect(isPayweaveClientLike(loaded.client)).toBe(true);
    expect(loaded.client.providers).toEqual(["stripe"]);
    expect(loaded.client.environment).toBe("test");

    const diagnostics = typecheckFiles(
      [
        join(dir, "payweave.ts"),
        join(dir, "products.ts"),
        join(dir, "app/api/webhooks/payweave/route.ts"),
      ],
      { dom: true },
    );
    expect(diagnostics, diagnostics.join("\n")).toHaveLength(0);
    // A cold `ts.createProgram` (loading lib.es2022/lib.dom + resolving the
    // real dist/) is genuinely slow, especially under coverage instrumentation
    // and full-suite CPU contention — well past vitest's 5s default.
  }, 30_000);

  it("plain node + Paystack + Flutterwave + no database: real loadConfig round trip and typecheck", async () => {
    const dir = makeTmpDir();
    const { prompts } = fakePrompts({ providers: ["paystack", "flutterwave"], database: "none" });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(detectFramework(dir)).toBe("node");

    setEnv("PAYSTACK_SECRET_KEY", "sk_test_init_paystack_fixture");
    setEnv("FLUTTERWAVE_SECRET_KEY", "FLWSECK_TEST-init_wizard_fixture");
    setEnv("FLUTTERWAVE_WEBHOOK_SECRET", "init_wizard_flw_webhook_fixture");

    const loaded = await loadConfig({ cwd: dir });
    expect(isPayweaveClientLike(loaded.client)).toBe(true);
    expect(loaded.client.providers).toEqual(["paystack", "flutterwave"]);
    expect(loaded.client.defaultProvider).toBe("paystack");
    expect(loaded.client.environment).toBe("test");

    // No products.ts to typecheck here — database: "none" means the wizard
    // correctly omits it (nothing to define plans/features against).
    expect(existsSync(join(dir, "products.ts"))).toBe(false);
    const diagnostics = typecheckFiles([
      join(dir, "payweave.ts"),
      join(dir, "payweave-webhook-server.ts"),
    ]);
    expect(diagnostics, diagnostics.join("\n")).toHaveLength(0);
  }, 30_000);

  it("NestJS + Stripe + Paystack + SQLite: every generated file parses, end-to-end through runInitCommand", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@nestjs/core": "11.0.0" } }), "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src/app.module.ts"),
      [`import { Module } from "@nestjs/common";`, "", "@Module({ imports: [] })", "export class AppModule {}", ""].join(
        "\n",
      ),
      "utf8",
    );
    const { prompts } = fakePrompts({ providers: ["stripe", "paystack"], database: "sqlite" });
    const { io } = capture();
    const code = await runInitCommand(["--no-install"], io, { cwd: dir, prompts });
    expect(code).toBe(0);
    expect(detectFramework(dir)).toBe("nest");

    // @nestjs/common and express aren't installed in THIS monorepo (same
    // reason the Express/Fastify webhook routes above only get a syntax
    // check) — a real project would have them since that's how detection
    // found "nest" in the first place. Parse-validity + secret-shape
    // discipline is what's provable here; the createPayweave(...) call SHAPE
    // itself is covered by "every provider x database combination" below,
    // which renderNestPayweaveService reuses verbatim.
    for (const relPath of [
      "src/payweave/payweave.service.ts",
      "src/payweave/payweave-webhook.controller.ts",
      "src/payweave/payweave.module.ts",
      "src/payweave/products.ts",
      "src/app.module.ts",
    ]) {
      assertParses(readFileSync(join(dir, relPath), "utf8"), relPath);
    }
    assertNoSecretShapes(readFileSync(join(dir, "src/payweave/payweave.service.ts"), "utf8"), "payweave.service.ts");
  });

  it("every provider x database combination renders parseable, secret-free payweave.ts + products.ts", () => {
    const providerCombos: readonly (readonly ProviderId[])[] = [
      ["stripe"],
      ["paystack"],
      ["flutterwave"],
      ["stripe", "paystack"],
    ];
    const databases: readonly DatabaseChoice[] = [
      "none",
      "prisma",
      "drizzle",
      "postgres",
      "mysql",
      "sqlite",
      "mongodb",
    ];

    for (const providers of providerCombos) {
      for (const database of databases) {
        const config = renderPayweaveConfig({ providers, database, framework: "node" });
        const products = renderProducts();
        assertParses(config, `payweave.ts (${providers.join("+")} / ${database})`);
        assertParses(products, `products.ts (${providers.join("+")} / ${database})`);
        assertNoSecretShapes(config, `payweave.ts (${providers.join("+")} / ${database})`);

        expect(config).toContain("createPayweave");
        if (providers.length > 1) {
          expect(config).toContain(`defaultProvider: "${providers[0]}"`);
        } else {
          expect(config).not.toContain("defaultProvider");
        }
        if (database === "none") {
          expect(config).not.toContain("products: [free, pro]");
        } else {
          expect(config).toContain("products: [free, pro]");
        }
      }
    }
  });

  it("no scaffolded file ever contains a real-looking secret value (redaction / secrets-discipline)", () => {
    const inputs = [
      { providers: ["stripe", "paystack", "flutterwave"] as const, database: "postgres" as const, framework: "next" as const },
      { providers: ["stripe"] as const, database: "mongodb" as const, framework: "express" as const },
      { providers: ["stripe", "paystack"] as const, database: "sqlite" as const, framework: "nest" as const },
    ];
    for (const input of inputs) {
      const files = planScaffold(input);
      for (const file of files) {
        assertNoSecretShapes(file.contents, file.relPath);
      }
    }
  });
});
