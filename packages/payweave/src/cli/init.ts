/**
 * `payweave init` — interactive setup wizard.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────
 *   1. Ask which provider(s) are configured (multiselect, ≥1 required).
 *   2. Ask which database is in use (select — includes "none" for a
 *      payments-only project).
 *   3. Detect the framework from the project's own `package.json` (+ a
 *      filesystem marker for Next.js) — never prompted; detected, not
 *      chosen.
 *   4. Plan the scaffold (`./templates`). NestJS gets its own shape (see
 *      "NestJS scaffold" below); every other framework gets `payweave.ts`,
 *      a framework-specific webhook route, an optional frontend client
 *      file, `products.ts` (skipped for a payments-only project — no
 *      database means no plans/features surface to define), and
 *      (Prisma/Drizzle only) a schema fragment. `.env.example` is common to
 *      every framework.
 *   5. Write each file, prompting per-file before clobbering an existing one;
 *      `--force` skips every such prompt and always overwrites —
 *      EXCEPT `.env.example`, which is merged, never clobbered (see below).
 *   6. NestJS only: add `PayweaveModule` to the project's own `AppModule`.
 *   7. Install `payweave` itself via the detected package manager (lockfile-based;
 *      defaults to npm) — best-effort, `--no-install` to skip.
 *
 * ── Prompt seam ───────────────────────────────────────────────────────────
 * Every interactive decision goes through {@link InitPrompts} — mirrors
 * `push.ts`'s injectable `confirm` seam. `test/cli/init.test.ts` drives the
 * wizard non-interactively by supplying its own `InitPrompts`; the real CLI
 * uses {@link defaultPrompts} (`@clack/prompts` — the bundled prompt
 * library, `tsup.cli.config.ts`'s `noExternal` list).
 *
 * ── Env var names, not values (spec-silent simplification) ───────────────
 * The wizard "collects the env var names." Read literally
 * that could mean prompting for a CUSTOM name per secret; this implementation
 * instead uses fixed, documented conventional names (`STRIPE_SECRET_KEY`,
 * ...) — "collects" as in "gathers the set of names this project needs,"
 * not "asks the user to type each one." A fixed-names scaffold is what most
 * comparable CLIs (create-next-app, create-t3-app) do, and prompting for
 * every provider's every var would multiply the wizard's prompt count and
 * test matrix without proportionate value. Flagged here per
 * the agent playbook's "record spec-silent decisions" instruction.
 *
 * ── Overwrite semantics ─────────────────────────────────────────────────
 * "It never overwrites an existing file without a confirmation
 * prompt (--force to skip)." This implementation prompts PER FILE via
 * {@link InitPrompts.confirmOverwrite} when interactive, and `--force` skips
 * every prompt and overwrites unconditionally. Additionally: if ANY existing
 * file is declined (or the wizard was invoked non-interactively with no
 * injected prompt seam, where prompting is impossible), the overall command
 * exits 1 with a clear summary — "refuses to clobber" reads as a command-level
 * outcome, not silent partial success, matching `push.ts`'s precedent that a
 * declined confirmation is a failed run.
 *
 * `.env.example` is the one exception to all of the above: it is never
 * clobbered, not even with `--force`, and its overwrite never prompts or
 * counts toward the "declined" exit-1 outcome. Teams fill in real local
 * values in this file in practice, so replacing it wholesale on a second
 * `init` run (e.g. after adding a provider) would silently discard that.
 * When it already exists, {@link templates!mergeEnvExample} appends only the
 * blocks whose vars aren't already present, and re-running with unchanged
 * answers is a true no-op.
 *
 * ── Framework detection ───────────────────────────────────────────────────
 * Targets five frameworks: Next.js App Router, Express, Fastify, NestJS, plus
 * a plain-`http` fallback. Detection is dependency-based (package.json deps +
 * filesystem markers): `dependencies`/`devDependencies`, with one
 * filesystem-marker fallback for Next.js (`next.config.{js,mjs,ts}`) for the
 * case where a project has a next config committed before `next` itself
 * lands in package.json (e.g. a very fresh scaffold). Precedence: Next.js >
 * NestJS > Express > Fastify > plain http — NestJS is checked before Express
 * because Nest's default HTTP adapter IS Express (`@nestjs/platform-express`),
 * so a Nest project very commonly also depends on `express` directly; checking
 * `@nestjs/core` first avoids misdetecting it as plain Express.
 *
 * ── NestJS scaffold ────────────────────────────────────────────────────────
 * A loose root-level `payweave.ts` / `lib/payweave-client.ts` isn't how Nest
 * projects are structured, so Nest gets a dedicated shape instead
 * (`./templates/nest.ts`): a self-contained `src/payweave/` module —
 * `payweave.service.ts` (an `@Injectable` wrapping `createPayweave(...)`),
 * `payweave-webhook.controller.ts` (DI-wired to that service), and
 * `payweave.module.ts` tying them together, plus a `README.md` documenting
 * the folder. `products.ts` (when a database is configured) lives in the
 * SAME folder rather than at the project root. After writing these files,
 * {@link findAppModule} locates the project's `app.module.ts` (the `nest new`
 * convention, `src/app.module.ts`, with a bounded recursive fallback search)
 * and {@link wirePayweaveModule} adds `PayweaveModule` to its `imports` —
 * a regex-based text patch, not a full TS-AST edit (see that function's own
 * doc comment for why). Finding no `app.module.ts` is a warning, not a
 * command failure: the generated module is still correct, and the user wires
 * it in with one line by hand.
 *
 * ── Package manager + install ─────────────────────────────────────────────
 * After the scaffold is written, `payweave` itself is installed into the
 * target project via the detected package manager (lockfile-based:
 * `pnpm-lock.yaml`/`yarn.lock`/`bun.lock(b)`/`package-lock.json`, defaulting to
 * npm when none is found) — `npx payweave init` only downloads the CLI itself
 * temporarily to run the wizard; it does not, on its own, add `payweave` as a
 * dependency of the project being scaffolded. `--no-install` skips this step.
 * A failed install is a warning, not a command failure (see `runInitCommand`'s
 * doc comment) — the generated files are still correct and usable once the
 * user installs the dependency themselves.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";

import { cancel, confirm as clackConfirm, isCancel, multiselect, select } from "@clack/prompts";
import mri from "mri";

import type { CliCommand, CliIo } from "./command";
import {
  mergeEnvExample,
  NEST_MODULE_PATH,
  planNestScaffold,
  renderClientFile,
  renderDrizzleSchema,
  renderEnvExample,
  renderPayweaveConfig,
  renderPrismaSchema,
  renderProducts,
  renderWebhookRoute,
  type DatabaseChoice,
  type FrameworkId,
  type ProviderId,
  type ScaffoldFile,
  type ScaffoldInput,
} from "./templates";
import { redact } from "../core/redact";

// ── Labels (real prompts + summary output) ──────────────────────────────────

const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = {
  stripe: "Stripe",
  paystack: "Paystack",
  flutterwave: "Flutterwave",
};

const DATABASE_LABEL: Readonly<Record<DatabaseChoice, string>> = {
  none: "None — payments only, no billing surface",
  prisma: "Prisma",
  drizzle: "Drizzle",
  postgres: "Postgres",
  mysql: "MySQL",
  sqlite: "SQLite / libSQL",
  mongodb: "MongoDB",
};

const FRAMEWORK_LABEL: Readonly<Record<FrameworkId, string>> = {
  next: "Next.js (App Router)",
  express: "Express",
  fastify: "Fastify",
  nest: "NestJS",
  node: "plain node:http (no framework detected)",
};

// ── Framework detection ──────────────────────────────────────────────────────

const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts"] as const;

function readMergedDependencies(cwd: string): Record<string, string> {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // Missing/unreadable/malformed package.json — fall back to "node" rather
    // than throwing; `init` should still work in a brand-new empty directory.
    return {};
  }
}

/**
 * Detect the project's framework (see this module's doc comment).
 * NestJS is checked before Express/Fastify: a Nest project's default HTTP
 * adapter is Express (`@nestjs/platform-express`) and it's common to also
 * depend on `express` directly for its types, so checking `@nestjs/core`
 * first avoids misdetecting a Nest project as plain Express.
 */
export function detectFramework(cwd: string): FrameworkId {
  const deps = readMergedDependencies(cwd);
  if ("next" in deps || NEXT_CONFIG_FILES.some((file) => existsSync(join(cwd, file)))) return "next";
  if ("@nestjs/core" in deps) return "nest";
  if ("express" in deps) return "express";
  if ("fastify" in deps) return "fastify";
  return "node";
}

// ── Package manager detection + install ──────────────────────────────────────

/** A package manager `payweave init` can detect and shell out to. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const PACKAGE_MANAGER_LOCKFILES: readonly (readonly [file: string, manager: PackageManager])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/** Detect the project's package manager from its lockfile. Defaults to npm when none is found. */
export function detectPackageManager(cwd: string): PackageManager {
  for (const [file, manager] of PACKAGE_MANAGER_LOCKFILES) {
    if (existsSync(join(cwd, file))) return manager;
  }
  return "npm";
}

/** The "add a dependency" invocation for each package manager — `npm install <pkg>` is npm's add form. */
function installCommand(manager: PackageManager): readonly [command: string, args: readonly string[]] {
  switch (manager) {
    case "npm":
      return ["npm", ["install", "payweave"]];
    case "pnpm":
      return ["pnpm", ["add", "payweave"]];
    case "yarn":
      return ["yarn", ["add", "payweave"]];
    case "bun":
      return ["bun", ["add", "payweave"]];
  }
}

/** Injectable subprocess runner for the install step — mirrors `listen.ts`'s `SpawnLike` seam. */
export type RunToCompletion = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<{ readonly code: number | null }>;

const defaultRunToCompletion: RunToCompletion = (command, args, options) =>
  new Promise((resolve) => {
    const child = nodeSpawn(command, args, { cwd: options.cwd, stdio: "inherit" });
    child.once("exit", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: 1 })); // e.g. ENOENT — package manager binary not on PATH
  });

// ── Prompt seam ───────────────────────────────────────────────────────────────

/** Every interactive decision the wizard makes — injectable for tests (push.ts's `confirm` precedent). */
export interface InitPrompts {
  selectProviders(): Promise<readonly ProviderId[]>;
  selectDatabase(): Promise<DatabaseChoice>;
  confirmOverwrite(relPath: string): Promise<boolean>;
}

/**
 * `@clack/prompts` cancels a prompt by returning a symbol; this is the shared
 * handler. A direct `process.exit` (not the rest of this CLI's usual
 * `process.exitCode` + natural return convention, `./index`'s doc comment) is
 * the documented `@clack/prompts` pattern for this exact case: each prompt
 * function's return type is a plain `Promise<T>` (no cancellation sentinel),
 * so there is no value this helper could return that would let the caller
 * keep going — terminating immediately is the only correct response to a
 * cancelled wizard.
 */
function exitOnCancel(): never {
  cancel("payweave init: cancelled.");
  process.exit(1);
}

async function selectProvidersPrompt(): Promise<readonly ProviderId[]> {
  const result = await multiselect({
    message: "Which provider(s) are you using?",
    options: (Object.keys(PROVIDER_LABEL) as ProviderId[]).map((value) => ({
      value,
      label: PROVIDER_LABEL[value],
    })),
    required: true,
  });
  if (isCancel(result)) exitOnCancel();
  return result;
}

async function selectDatabasePrompt(): Promise<DatabaseChoice> {
  const result = await select({
    message: "Which database are you using?",
    options: (Object.keys(DATABASE_LABEL) as DatabaseChoice[]).map((value) => ({
      value,
      label: DATABASE_LABEL[value],
    })),
  });
  if (isCancel(result)) exitOnCancel();
  return result;
}

async function confirmOverwritePrompt(relPath: string): Promise<boolean> {
  const result = await clackConfirm({
    message: `${relPath} already exists — overwrite?`,
    initialValue: false,
  });
  if (isCancel(result)) exitOnCancel();
  return result;
}

/** Real interactive prompts (`@clack/prompts`, a bundled devDependency). */
export const defaultPrompts: InitPrompts = {
  selectProviders: selectProvidersPrompt,
  selectDatabase: selectDatabasePrompt,
  confirmOverwrite: confirmOverwritePrompt,
};

// ── Scaffold planning ────────────────────────────────────────────────────────

/**
 * Plan every file the wizard would write for a given set of answers (pure —
 * no filesystem I/O). NestJS gets an entirely different shape (see this
 * module's doc comment, "NestJS scaffold") via `planNestScaffold`; every
 * other framework gets the generic root-level files. `products.ts` (the
 * plan()/feature() billing surface) is skipped for `database: "none"` —
 * plans/features/metered usage all require a database adapter, so a
 * payments-only project has no use for it and `payweave.ts` never imports it
 * in that case (see `renderPayweaveConfig`). `.env.example` and the
 * Prisma/Drizzle schema fragment are common to every framework, NestJS
 * included.
 */
export function planScaffold(input: ScaffoldInput): readonly ScaffoldFile[] {
  const { database, framework } = input;

  const files: ScaffoldFile[] =
    framework === "nest"
      ? [...planNestScaffold(input), { relPath: ".env.example", contents: renderEnvExample(input) }]
      : [
          { relPath: "payweave.ts", contents: renderPayweaveConfig(input) },
          { relPath: ".env.example", contents: renderEnvExample(input) },
          renderWebhookRoute(framework),
          renderClientFile(),
        ];

  if (framework !== "nest" && database !== "none") {
    files.push({ relPath: "products.ts", contents: renderProducts() });
  }
  if (database === "prisma") files.push(renderPrismaSchema());
  if (database === "drizzle") files.push(renderDrizzleSchema());
  return files;
}

// ── NestJS: locate + patch the project's own app.module.ts ─────────────────

const APP_MODULE_FILENAME = "app.module.ts";
const APP_MODULE_WALK_IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".turbo", "coverage"]);
const APP_MODULE_WALK_MAX_DEPTH = 4;

function walkForAppModule(dir: string, depth: number): string | undefined {
  if (depth > APP_MODULE_WALK_MAX_DEPTH) return undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === APP_MODULE_FILENAME) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !APP_MODULE_WALK_IGNORED_DIRS.has(entry.name)) {
      const found = walkForAppModule(join(dir, entry.name), depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Locate a Nest project's `app.module.ts` — tries the `nest new` convention
 * (`src/app.module.ts`) first, then falls back to a bounded, ignore-list-aware
 * recursive search for a file with that exact name (depth 4, skipping
 * `node_modules`/build output/VCS dirs). Returns `undefined` rather than
 * throwing when nothing is found; `runInitCommand` treats that as "warn, the
 * user wires PayweaveModule in by hand" rather than a command failure.
 */
export function findAppModule(cwd: string): string | undefined {
  const conventional = join(cwd, "src", APP_MODULE_FILENAME);
  if (existsSync(conventional)) return conventional;
  return walkForAppModule(cwd, 0);
}

/** The relative import specifier from `fromFile` back to `toFile`, extension stripped, always `./`- or `../`-prefixed. */
function relativeImportSpecifier(fromFile: string, toFile: string): string {
  const rel = relative(dirname(fromFile), toFile)
    .replace(/\\/g, "/")
    .replace(/\.ts$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Scan forward from `openIndex` (which MUST point at a `[`, `{`, or `(`) and
 * return the index of ITS matching closing bracket — tracking combined
 * `[]`/`{}`/`()` depth (not just `[]`) so a NESTED structure of any kind
 * doesn't get mistaken for the outer one's close, and skipping over
 * string/template-literal contents (so a stray bracket character inside a
 * quoted string is never counted). Returns `undefined` on unbalanced input.
 *
 * This is the fix for a real bug: `imports: [ConfigModule.forRoot({ load:
 * [() => env] }), DatabaseModule, ...]` has a NESTED `[]` (the `load` array)
 * that closes before the outer `imports` array does — a naive
 * `[^\]]*` regex stops at that first `]` and inserts `PayweaveModule` INSIDE
 * `load`, not as an imports-array sibling. `ConfigModule.forRoot({ load:
 * [...] })` (and similar `SomeModule.forRootAsync({...})` calls) are an
 * extremely common sight inside a real `imports` array, so this isn't an
 * edge case to shrug off.
 */
function findMatchingBracketEnd(contents: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIndex; i < contents.length; i++) {
    const ch = contents[i];
    if (quote !== undefined) {
      if (ch === "\\") i++; // skip the escaped character, whatever it is
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "[" || ch === "{" || ch === "(") {
      depth++;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * Insert `import { PayweaveModule } from "<importSpecifier>";` plus
 * `PayweaveModule` into the `@Module({ imports: [...] })` array of an
 * existing `app.module.ts`'s contents. A pure string transform — no fs I/O
 * (`runInitCommand` reads/writes the file around this call). Idempotent:
 * returns `contents` completely unchanged if `PayweaveModule` already
 * appears anywhere in the file, so re-running `payweave init` never
 * double-wires it.
 *
 * Regex-based (for locating the `imports:` KEY) plus a bracket-depth scan
 * (for finding where its array actually ENDS, see
 * {@link findMatchingBracketEnd}) — not a real TS parser. A full TS AST
 * library would be a heavy dependency for a best-effort convenience step
 * (same spirit as the install step: correct in the common/realistic case,
 * and the generated module still works if the user has to wire it in by
 * hand instead) — but the array boundary MUST be bracket-depth-aware, not a
 * naive "stop at the first `]`", or a nested array/object literal inside
 * `imports` silently corrupts the file (see `findMatchingBracketEnd`'s doc
 * comment).
 */
export function wirePayweaveModule(contents: string, importSpecifier: string): string {
  if (contents.includes("PayweaveModule")) return contents;

  const importLine = `import { PayweaveModule } from "${importSpecifier}";`;
  const importStatements = [...contents.matchAll(/^import .+;$/gm)];
  const withImport =
    importStatements.length > 0
      ? (() => {
          const last = importStatements[importStatements.length - 1]!;
          const insertAt = last.index! + last[0].length;
          return `${contents.slice(0, insertAt)}\n${importLine}${contents.slice(insertAt)}`;
        })()
      : `${importLine}\n${contents}`;

  const keyMatch = withImport.match(/imports\s*:\s*\[/);
  if (keyMatch === null || keyMatch.index === undefined) return withImport;

  const openBracket = keyMatch.index + keyMatch[0].length - 1;
  const closeBracket = findMatchingBracketEnd(withImport, openBracket);
  if (closeBracket === undefined) return withImport; // unbalanced brackets — bail rather than risk corrupting the file

  const inner = withImport.slice(openBracket + 1, closeBracket).replace(/,\s*$/, "").trim();
  const newInner = inner.length === 0 ? "PayweaveModule" : `${inner}, PayweaveModule`;
  return `${withImport.slice(0, openBracket + 1)}${newInner}${withImport.slice(closeBracket)}`;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Route a string through the SDK's one redaction path before it is ever printed. */
function redactLine(line: string): string {
  const scrubbed = redact(line);
  return typeof scrubbed === "string" ? scrubbed : line;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/** Options accepted by {@link runInitCommand} beyond the CLI flags themselves. */
export interface InitCommandOptions {
  /** Project root to scaffold into. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injectable prompt seam for tests — bypasses the non-interactive guard entirely (see doc comment). */
  prompts?: InitPrompts;
  /** Injectable interactivity signal for the guard when `prompts` is NOT supplied. Defaults to `process.stdin.isTTY === true`. */
  isInteractive?: boolean;
  /** Injectable subprocess runner for the install step. Defaults to the real `node:child_process` spawn. */
  runToCompletion?: RunToCompletion;
}

/**
 * `payweave init`'s `run` body (see this module's doc comment for
 * the full flow, prompt-seam, overwrite-semantics, and framework-detection
 * reasoning). Parses its own flags: `--force`/`-f` (skip every overwrite
 * prompt, always write) and `--no-install` (skip the automatic
 * `<package manager> install payweave` step — on by default, mirroring
 * `create-next-app`/`create-t3-app`).
 *
 * Exit codes: 0 — every planned file was written (created or, with
 * `--force`, overwritten) with no conflicts left unresolved; 1 — the wizard
 * could not run (non-interactive with no injected prompts, a cancelled/failed
 * prompt, or zero providers selected), OR at least one existing file was
 * declined and left untouched. A failed install does NOT affect the exit
 * code — the scaffold itself is what this command promises; installing the
 * dependency is a best-effort courtesy on top (a clear message tells the user
 * how to run it themselves if it fails).
 */
export async function runInitCommand(
  argv: readonly string[],
  io: CliIo,
  options: InitCommandOptions = {},
): Promise<number> {
  const args = mri([...argv], {
    boolean: ["force", "install"],
    alias: { f: "force" },
    default: { install: true },
  });
  const cwd = options.cwd ?? process.cwd();
  const force = args["force"] === true;
  const shouldInstall = args["install"] !== false;
  const runToCompletion = options.runToCompletion ?? defaultRunToCompletion;

  if (options.prompts === undefined) {
    const interactive = options.isInteractive ?? process.stdin.isTTY === true;
    if (!interactive) {
      io.err(
        "payweave init: needs an interactive terminal to run the setup wizard — run `npx payweave " +
          "init` directly in a terminal.",
      );
      return 1;
    }
  }
  const prompts = options.prompts ?? defaultPrompts;

  io.out("Payweave init — interactive setup wizard");
  io.out("");

  let providers: readonly ProviderId[];
  let database: DatabaseChoice;
  try {
    providers = await prompts.selectProviders();
    database = await prompts.selectDatabase();
  } catch (err) {
    io.err(`payweave init: wizard failed — ${redactLine(errorMessage(err))}`);
    return 1;
  }

  // Defensive — the real prompt enforces `required: true`, but an injected
  // test seam (or a future prompt-less flag mode) could still hand back [].
  if (providers.length === 0) {
    io.err("payweave init: at least one provider is required.");
    return 1;
  }

  const framework = detectFramework(cwd);
  io.out(redactLine(`Framework:   ${FRAMEWORK_LABEL[framework]}`));
  io.out(redactLine(`Provider(s): ${providers.map((provider) => PROVIDER_LABEL[provider]).join(", ")}`));
  io.out(redactLine(`Database:    ${DATABASE_LABEL[database]}`));
  io.out("");

  const files = planScaffold({ providers, database, framework });

  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const abs = join(cwd, file.relPath);
    const existedBefore = existsSync(abs);

    // `.env.example` is never clobbered — merged instead (see this module's
    // doc comment, "Overwrite semantics"). Never prompts, never counts
    // toward `skipped`/the exit-1 outcome, and ignores --force.
    if (file.relPath === ".env.example" && existedBefore) {
      const merged = mergeEnvExample({ providers, database, framework }, readFileSync(abs, "utf8"));
      if (merged === undefined) {
        io.out(redactLine(`  skip       ${file.relPath} (already up to date)`));
      } else {
        writeFileSync(abs, merged, "utf8");
        written.push(file.relPath);
        io.out(redactLine(`  update     ${file.relPath} (appended new variables)`));
      }
      continue;
    }

    if (existedBefore && !force) {
      let overwrite: boolean;
      try {
        overwrite = await prompts.confirmOverwrite(file.relPath);
      } catch (err) {
        io.err(`payweave init: wizard failed — ${redactLine(errorMessage(err))}`);
        return 1;
      }
      if (!overwrite) {
        skipped.push(file.relPath);
        io.out(redactLine(`  skip       ${file.relPath} (already exists)`));
        continue;
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents, "utf8");
    written.push(file.relPath);
    io.out(redactLine(`  ${existedBefore ? "overwrite" : "create"}    ${file.relPath}`));
  }

  io.out("");
  io.out(`payweave init: ${written.length} file(s) written, ${skipped.length} skipped.`);

  if (framework === "nest") {
    const appModulePath = findAppModule(cwd);
    if (appModulePath === undefined) {
      io.err(
        "payweave init: could not find app.module.ts — add `PayweaveModule` to your root module's " +
          "imports yourself (see src/payweave/payweave.module.ts).",
      );
    } else {
      const before = readFileSync(appModulePath, "utf8");
      const importSpecifier = relativeImportSpecifier(appModulePath, join(cwd, NEST_MODULE_PATH));
      const after = wirePayweaveModule(before, importSpecifier);
      const relAppModule = relative(cwd, appModulePath);
      if (after === before) {
        io.out(redactLine(`  skip       ${relAppModule} (PayweaveModule already wired)`));
      } else {
        writeFileSync(appModulePath, after, "utf8");
        io.out(redactLine(`  update     ${relAppModule} (added PayweaveModule to imports)`));
      }
    }
  }

  if (shouldInstall) {
    const manager = detectPackageManager(cwd);
    const [command, cmdArgs] = installCommand(manager);
    io.out("");
    io.out(`Installing payweave with ${manager}...`);
    const { code } = await runToCompletion(command, cmdArgs, { cwd });
    if (code === 0) {
      io.out(`payweave installed via ${manager}.`);
    } else {
      io.err(
        `payweave init: could not install payweave automatically (${command} exited with code ${code}) — ` +
          `run \`${command} ${cmdArgs.join(" ")}\` yourself.`,
      );
    }
  }

  if (skipped.length > 0) {
    io.err(
      redactLine(
        `payweave init: ${skipped.length} file(s) already existed and were not overwritten: ` +
          `${skipped.join(", ")} — re-run with --force to overwrite, or remove them first.`,
      ),
    );
    return 1;
  }

  io.out("");
  io.out("Next steps:");
  io.out("  1. Fill in real values in .env.example, then copy it to .env (or your framework's env file).");
  if (framework === "nest") {
    io.out("  2. See src/payweave/README.md for what's in the module and what's left to configure.");
  } else if (database === "none") {
    io.out("  2. Review payweave.ts, then start your server and try the generated webhook route.");
  } else {
    io.out("  2. Review payweave.ts and products.ts, then run `npx payweave push`.");
  }
  return 0;
}

export const initCommand: CliCommand = {
  name: "init",
  summary: "Interactive setup wizard: scaffold config, products, and a webhook route",
  run: (argv, io) => runInitCommand(argv, io),
};
