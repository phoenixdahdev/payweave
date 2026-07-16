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
 *   4. Plan the scaffold (`./templates`): `payweave.ts`, `.env.example`, a
 *      framework-specific webhook route, an optional frontend client file,
 *      `products.ts` (skipped for a payments-only project — no database means
 *      no plans/features surface to define), and (Prisma/Drizzle only) a
 *      schema fragment.
 *   5. Write each file, prompting per-file before clobbering an existing one;
 *      `--force` skips every such prompt and always overwrites.
 *   6. Install `payweave` itself via the detected package manager (lockfile-based;
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { cancel, confirm as clackConfirm, isCancel, multiselect, select } from "@clack/prompts";
import mri from "mri";

import type { CliCommand, CliIo } from "./command";
import {
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
 * no filesystem I/O). `products.ts` (the plan()/feature() billing surface)
 * is skipped for `database: "none"` — plans/features/metered usage all
 * require a database adapter, so a payments-only project has no use for it
 * and `payweave.ts` never imports it in that case (see `renderPayweaveConfig`).
 */
export function planScaffold(input: ScaffoldInput): readonly ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { relPath: "payweave.ts", contents: renderPayweaveConfig(input) },
    { relPath: ".env.example", contents: renderEnvExample(input) },
    renderWebhookRoute(input),
    renderClientFile(),
  ];
  if (input.database !== "none") files.push({ relPath: "products.ts", contents: renderProducts() });
  if (input.database === "prisma") files.push(renderPrismaSchema());
  if (input.database === "drizzle") files.push(renderDrizzleSchema());
  return files;
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
  if (database === "none") {
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
