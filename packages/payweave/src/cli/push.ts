/**
 * `payweave push` — apply pending database migrations, then sync plan
 * definitions to the database and every configured billing-capable provider.
 *
 * ── Pipeline order ───────────────────────────────────────────────────────────
 * The pipeline: load config → `database.migrations.status()` → apply (SQL
 * adapters) / idempotently ensure (MongoDB) / print instructions
 * (Prisma/Drizzle) → compute content hash per plan → diff vs `pw_plans`
 * active versions → confirm → provider sync → write `pw_plans` versions.
 * Migrations apply pre-prompt; only the sync/version-write phase is prompted:
 * migrations are applied UNCONDITIONALLY and automatically, with no
 * confirmation gate of their own (there is nothing to "undo" about running a
 * forward-only, checksum-verified migration). The confirm/`-y` gate protects
 * exactly one thing: the call into `client.sync()`, which is the only phase
 * that talks to provider APIs and writes `pw_plans` version rows. This
 * command's phases, in order:
 *
 *   1. Load config.
 *   2. `database.migrations.status()` — announce what's pending (read-only,
 *      printed BEFORE anything is written) — then `database.migrations.apply()`
 *      unconditionally. Both calls go straight through the
 *      `DatabaseAdapter.migrations` contract: this command never branches on
 *      dialect itself — SQL adapters apply for real, MongoDB idempotently
 *      ensures collections/indexes, and Prisma/Drizzle return `instructions`
 *      instead of attempting DDL. No confirmation gate here.
 *   3. If no `products` are configured, there is nothing to sync — report
 *      that and exit 0 (a database-migrations-only project is a valid use of
 *      `push`; degrade-gracefully precedent: `src/cli/status.ts`).
 *   4. Compute a read-only PLAN DIFF: for each configured product, compare it
 *      against `database.plans.getActiveVersion(planId)` and classify it
 *      `create` (no active version yet) / `update` (an active version exists
 *      but its name, price, or features differ) / `unchanged`. This is a
 *      GENERIC content comparison against the stored `pw_plans` row —
 *      deliberately NOT a re-implementation of `BillingSync`'s per-provider
 *      hashing (`src/products/sync.ts`'s `planPriceHash`/`planPaystackHash`):
 *      this command orchestrates and renders, it does not re-map plans to
 *      Stripe Prices or Paystack Plans. The tradeoff is explicit: this diff
 *      can tell you a plan's content changed (and DB version will bump) and
 *      which configured billing-capable providers are in scope for a paid
 *      plan, but it CANNOT predict whether `sync()` will ultimately report
 *      `created`, `adopted`, or (for a display-name-only Stripe change)
 *      `unchanged` — only `BillingSync` itself decides that, and this command
 *      prints its real, authoritative result after the fact (phase 6).
 *   5. Confirmation gate: `-y`/`--yes` skips it. Otherwise, refuse to prompt
 *      in a non-interactive session (never hang waiting on a closed stdin)
 *      and tell the user to pass `-y`. In an interactive session, ask via the
 *      injectable {@link PushCommandOptions.confirm} seam (default: one
 *      `node:readline/promises` question over real stdin/stdout). A declined
 *      confirmation aborts BEFORE any provider call or version write — exit
 *      code 1 (spec-silent decision: a declined confirmation means the push
 *      did not happen, so a caller chaining `payweave push -y && next
 *      build`-style commands must see non-zero, not a silent success).
 *   6. `client.sync()` — `BillingSync`. This command does not reimplement ANY
 *      of its idempotency, adoption, or write semantics; it only decides
 *      WHEN to call it and renders the real, authoritative result afterward
 *      (per-plan version + per-provider `created`/`adopted`/`unchanged`, plus
 *      any `skippedProviders`). A crash mid-`sync()` is resumable by
 *      re-running `payweave push` — `BillingSync`'s `pwv_`-tagged
 *      adopt-or-create is what makes that safe, not anything in this file.
 *
 * ── Duck-typed client surface ────────────────────────────────────────────────
 * Mirrors `status.ts`'s approach exactly: this file declares its OWN minimal
 * structural types ({@link PushClientLike}, {@link PushDatabaseLike}, …)
 * rather than importing `PayweaveClient`/`DatabaseAdapter`/`ResolvedProduct`/
 * `SyncResult` from `src/index.ts` / `src/db/*` / `src/products/*`.
 * `test/cli/push.test.ts` exercises the real types end-to-end (real
 * `createPayweave`, real `sqliteAdapter`, real MSW).
 *
 * ── Secrets discipline ───────────────────────────────────────────────────────
 * Every printed line passes through the SDK's one redaction path
 * (`../core/redact`) before being written — belt-and-braces, since database/
 * provider error text is the most likely place secret material could leak
 * into this command's output.
 */
import { createInterface } from "node:readline/promises";

import mri from "mri";

import type { CliCommand, CliIo } from "./command";
import {
  loadConfig,
  type LoadConfigOptions,
  type LoadedConfig,
  type PayweaveClientLike,
} from "./config-loader";
import { redact } from "../core/redact";

// ── The client/database/product surface this command reads ─────────────────

/** The read-only migration surface this command drives. */
export interface PushMigrationsLike {
  status(): Promise<{ pending: readonly string[]; applied: readonly string[] }>;
  apply(): Promise<{ applied: readonly string[]; instructions?: string | undefined }>;
}

/** The `pw_plans` row shape this command reads to compute the diff. */
export interface PushPlanVersionLike {
  readonly version: number;
  readonly name: string | null;
  readonly priceMinor: number | null;
  readonly priceCurrency: string | null;
  readonly priceInterval: string | null;
  readonly features: Readonly<Record<string, unknown>>;
}

/** The minimal database surface `push` needs — a slice of `DatabaseAdapter`. */
export interface PushDatabaseLike {
  readonly dialect?: string | undefined;
  readonly migrations: PushMigrationsLike;
  readonly plans: {
    getActiveVersion(planId: string): Promise<PushPlanVersionLike | null>;
  };
}

/** One `plan()`'s resolved `includes` entry — just enough to diff. */
export interface PushFeatureInclusionLike {
  readonly featureId: string;
  readonly type: "boolean" | "metered";
  readonly limit?: number | undefined;
  readonly reset?: string | undefined;
}

/** One configured, resolved product/plan — `price` already minor units. */
export interface PushProductLike {
  readonly id: string;
  readonly name?: string | undefined;
  readonly price?: { readonly amount: number; readonly currency: string; readonly interval: string } | undefined;
  readonly includes: readonly PushFeatureInclusionLike[];
}

/** Per-provider outcome `BillingSync` actually took — the ground truth reported after `sync()` runs. */
export type PushSyncProviderAction = "created" | "adopted" | "unchanged";

/** One plan's real `sync()` outcome (mirrors `src/products/sync.ts`'s `SyncPlanResult`, duck-typed). */
export interface PushSyncPlanResult {
  readonly planId: string;
  readonly version: number;
  readonly versionChanged: boolean;
  readonly providers: Readonly<Record<string, PushSyncProviderAction>>;
}

/** `client.sync()`'s result (mirrors `src/products/sync.ts`'s `SyncResult`, duck-typed). */
export interface PushSyncResult {
  readonly plans: readonly PushSyncPlanResult[];
  readonly skippedProviders: readonly string[];
}

/**
 * The extended client shape `push` reads from (superset of
 * {@link PayweaveClientLike}, same pattern as `status.ts`'s `StatusClientLike`).
 */
export interface PushClientLike extends PayweaveClientLike {
  readonly database?: PushDatabaseLike | undefined;
  readonly products?: readonly PushProductLike[] | undefined;
  sync(): Promise<PushSyncResult>;
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Extract a printable message from anything a `catch` might hand us (status.ts precedent). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** `.name` off a thrown value, duck-typed — never `instanceof` (config-loader.ts precedent). */
function errorName(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return undefined;
}

/** Route a string through the SDK's one redaction path before it is ever printed. */
function redactLine(line: string): string {
  const scrubbed = redact(line);
  return typeof scrubbed === "string" ? scrubbed : line;
}

/** `<ErrorClass>: <redacted message>` when a name is available, else just the redacted message. */
function describeFailure(err: unknown): string {
  const name = errorName(err);
  const message = redactLine(errorMessage(err));
  return name !== undefined ? `${name}: ${message}` : message;
}

// ── Plan diff (read-only, printed BEFORE the confirm gate) ─────────────────

/** Stable (sorted-key) JSON for order-independent structural comparison — generic, NOT provider hashing. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A resolved product's `includes`, shaped like the `pw_plans.features` column. */
function featuresRecordFor(product: PushProductLike): Record<string, { type: string; limit?: number; reset?: string }> {
  const out: Record<string, { type: string; limit?: number; reset?: string }> = {};
  for (const inclusion of product.includes) {
    out[inclusion.featureId] =
      inclusion.type === "boolean"
        ? { type: "boolean" }
        : { type: "metered", limit: inclusion.limit as number, reset: inclusion.reset as string };
  }
  return out;
}

/** One plan's predicted diff action, and which billing-capable providers it's in scope for. */
export type PushPlanDiffAction = "create" | "update" | "unchanged";

/** One row of the pre-confirm plan diff summary. */
export interface PushPlanDiffEntry {
  readonly planId: string;
  readonly action: PushPlanDiffAction;
  /** `false` for a free/default plan — never touches a provider. */
  readonly paid: boolean;
  /** Configured, billing-capable providers this plan is in scope for; always `[]` when `paid` is `false`. */
  readonly providers: readonly string[];
}

/**
 * Providers with a working plan-sync mapping in `BillingSync` today.
 * Re-declared here (mirrors the same re-declaration `src/products/sync.ts`
 * itself does for its private `isBillingCapableProvider`) rather than
 * imported from `src/products/subscribe.ts`. Used ONLY to render which
 * providers a paid plan is in scope for; the real outcome always comes from
 * `client.sync()` itself (see this module's doc comment).
 */
const BILLING_CAPABLE_PROVIDERS = ["stripe", "paystack"] as const;

/**
 * Classify one plan against its current active `pw_plans` version: `create`
 * (none yet), `update` (name, price, or features differ), or `unchanged`.
 * A generic content comparison — see the module doc comment for why this is
 * deliberately NOT `BillingSync`'s provider-specific hash.
 */
export function resolvePlanDiffAction(
  product: PushProductLike,
  existing: PushPlanVersionLike | null,
): PushPlanDiffAction {
  if (existing === null) return "create";
  const nameChanged = (existing.name ?? null) !== (product.name ?? null);
  const priceChanged =
    (existing.priceMinor ?? null) !== (product.price?.amount ?? null) ||
    (existing.priceCurrency ?? null) !== (product.price?.currency ?? null) ||
    (existing.priceInterval ?? null) !== (product.price?.interval ?? null);
  const featuresChanged =
    stableStringify(existing.features) !== stableStringify(featuresRecordFor(product));
  return nameChanged || priceChanged || featuresChanged ? "update" : "unchanged";
}

/** Compute the full, read-only plan diff (phase 4) — one `getActiveVersion` read per product. */
export async function computePlanDiff(
  database: PushDatabaseLike,
  products: readonly PushProductLike[],
  configuredProviders: readonly string[],
): Promise<readonly PushPlanDiffEntry[]> {
  const billingProviders = configuredProviders.filter((provider) =>
    (BILLING_CAPABLE_PROVIDERS as readonly string[]).includes(provider),
  );
  // Look up each plan's active version in parallel — the diff is read-only and
  // order-preserving (`Promise.all` keeps `products` order), so there's no
  // reason to serialize the round trips.
  return Promise.all(
    products.map(async (product) => {
      const existing = await database.plans.getActiveVersion(product.id);
      const paid = product.price !== undefined;
      return {
        planId: product.id,
        action: resolvePlanDiffAction(product, existing),
        paid,
        providers: paid ? billingProviders : [],
      };
    }),
  );
}

const DIFF_ACTION_LABEL: Record<PushPlanDiffAction, string> = {
  create: "CREATE",
  update: "UPDATE",
  unchanged: "UNCHANGED",
};

/** Render one {@link PushPlanDiffEntry} as a terminal line. Exported so tests assert exact formatting. */
export function formatPlanDiffLine(entry: PushPlanDiffEntry): string {
  const target = !entry.paid
    ? "free plan — database only, no provider sync"
    : entry.providers.length > 0
      ? `providers: ${entry.providers.join(", ")}`
      : "no billing-capable provider configured";
  return `  [${DIFF_ACTION_LABEL[entry.action].padEnd(9)}] ${entry.planId.padEnd(24)} ${target}`;
}

// ── Migrations phase rendering (phase 2) ────────────────────────────────────

/** Rendered BEFORE `migrations.apply()` runs — the "what will change" half of the diff summary. */
export function formatMigrationsPending(status: { pending: readonly string[] }): string {
  return status.pending.length > 0
    ? `Migrations: ${status.pending.length} pending — ${status.pending.join(", ")}`
    : "Migrations: up to date — no pending migrations";
}

/**
 * Rendered AFTER `migrations.apply()` runs. `undefined` means nothing new to
 * report (the "up to date" line above already said everything).
 */
export function formatMigrationsApplied(result: {
  readonly applied: readonly string[];
  readonly instructions?: string | undefined;
}): string | undefined {
  if (result.instructions !== undefined) return `Migrations: ${result.instructions}`;
  if (result.applied.length > 0) {
    return `Migrations: applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`;
  }
  return undefined;
}

// ── Real sync() result rendering (phase 6 — authoritative, post-write) ─────

/** Render one real {@link PushSyncPlanResult} row. Exported so tests assert exact formatting. */
export function formatSyncResultLine(plan: PushSyncPlanResult): string {
  const providerParts = Object.entries(plan.providers).map(([provider, action]) => `${provider}: ${action}`);
  const providerText = providerParts.length > 0 ? providerParts.join(", ") : "no provider sync (free plan)";
  const versionText = `version ${plan.version} (${plan.versionChanged ? "new" : "unchanged"})`;
  return `  ${plan.planId.padEnd(24)} ${versionText.padEnd(24)} ${providerText}`;
}

// ── Confirmation seam (phase 5) ──────────────────────────────────────────────

/**
 * Default interactive confirm: one `node:readline/promises` question over
 * REAL stdin/stdout. Deliberately not `@clack/prompts` — that bundled
 * devDependency belongs to `init`; a plain y/n line prompt needs nothing
 * beyond Node's own `readline`, so `push` doesn't need to pull it in early.
 */
async function defaultConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/** Options accepted by {@link runPushCommand} beyond the CLI flags themselves. */
export interface PushCommandOptions {
  /** Injectable for tests; defaults to the real config loader. */
  loadConfig?: (options: LoadConfigOptions) => Promise<LoadedConfig>;
  /** Project root `loadConfig` searches from (passed through to it). */
  cwd?: string;
  /** Injectable confirmation prompt seam — tests inject this instead of touching real stdin. */
  confirm?: (message: string) => Promise<boolean>;
  /** Injectable interactivity signal. Defaults to `process.stdin.isTTY === true`. */
  isInteractive?: boolean;
}

/**
 * `payweave push`'s `run` body (see this module's doc comment for the full
 * pipeline-order + confirm-gate reasoning). Parses its own flags:
 * `--config <path>` (discovery override) and `-y`/`--yes` (skip confirmation).
 *
 * Exit codes: 0 success (including the "nothing configured to sync" no-op);
 * 1 on any failure — config load, missing database, migrations, plan-state
 * read, a declined or refused confirmation, or `sync()` itself.
 */
export async function runPushCommand(
  argv: readonly string[],
  io: CliIo,
  options: PushCommandOptions = {},
): Promise<number> {
  const args = mri([...argv], { boolean: ["yes"], alias: { y: "yes" }, string: ["config"] });
  const loader = options.loadConfig ?? loadConfig;

  let loaded: LoadedConfig;
  try {
    loaded = await loader({
      configPath: typeof args["config"] === "string" ? args["config"] : undefined,
      cwd: options.cwd,
    });
  } catch (err) {
    io.err(`payweave push: failed to load config — ${describeFailure(err)}`);
    return 1;
  }

  const client = loaded.client as PushClientLike;
  io.out(`Payweave push — config: ${loaded.path}`);
  io.out("");

  const database = client.database;
  if (database === undefined) {
    io.err(
      "payweave push: no database configured — push has nothing to migrate or sync. Add a " +
        "`database` adapter to your payweave.ts.",
    );
    return 1;
  }
  io.out(redactLine(`Database: ${database.dialect ?? "configured"}`));

  // ── Phase 2: migrations — announce pending, then apply unconditionally.
  // No confirmation gate (see this module's doc comment). ──
  let statusResult: { pending: readonly string[]; applied: readonly string[] };
  try {
    statusResult = await database.migrations.status();
  } catch (err) {
    io.err(`payweave push: could not read migration status — ${describeFailure(err)}`);
    return 1;
  }
  io.out(redactLine(formatMigrationsPending(statusResult)));

  let applyResult: { applied: readonly string[]; instructions?: string | undefined };
  try {
    applyResult = await database.migrations.apply();
  } catch (err) {
    io.err(`payweave push: migrations failed — ${describeFailure(err)}`);
    return 1;
  }
  const appliedLine = formatMigrationsApplied(applyResult);
  if (appliedLine !== undefined) {
    io.out(redactLine(appliedLine));
  }
  io.out("");

  // ── Phase 3: nothing to sync without products (degrade gracefully — a
  // migrations-only project is a valid use of `push`). ──
  const products = client.products;
  if (products === undefined || products.length === 0) {
    io.out(
      "Plans: no products configured — nothing to sync (add `products` to payweave.ts, " +
        "run `payweave push` after adding one).",
    );
    return 0;
  }

  // ── Phase 4: read-only plan diff, printed BEFORE the confirm gate. ──
  let diff: readonly PushPlanDiffEntry[];
  try {
    diff = await computePlanDiff(database, products, client.providers);
  } catch (err) {
    io.err(`payweave push: failed to read plan state — ${describeFailure(err)}`);
    return 1;
  }

  io.out("Plans:");
  for (const entry of diff) {
    io.out(redactLine(formatPlanDiffLine(entry)));
  }
  io.out("");

  // ── Phase 5: confirmation gate — the ONLY gated phase (see doc comment). ──
  const yes = args["yes"] === true;
  if (!yes) {
    const interactive = options.isInteractive ?? process.stdin.isTTY === true;
    if (!interactive) {
      io.err(
        "payweave push: refusing to prompt in a non-interactive session — re-run with -y/--yes to " +
          "confirm and proceed.",
      );
      return 1;
    }
    const confirm = options.confirm ?? defaultConfirm;
    const proceed = await confirm(
      "Proceed? This calls your configured provider(s) and writes pw_plans version rows.",
    );
    if (!proceed) {
      io.err("payweave push: aborted — no changes were made.");
      return 1;
    }
  }

  // ── Phase 6: the actual, mutating call — entirely BillingSync's job. ──
  let result: PushSyncResult;
  try {
    result = await client.sync();
  } catch (err) {
    io.err(`payweave push: sync failed — ${describeFailure(err)}`);
    io.err(
      "no partial pw_plans row was written for any plan not yet reported below — re-running " +
        "`payweave push` is safe (crash-resume adoption).",
    );
    return 1;
  }

  io.out("Synced:");
  for (const plan of result.plans) {
    io.out(redactLine(formatSyncResultLine(plan)));
  }
  if (result.skippedProviders.length > 0) {
    io.out(
      redactLine(`Skipped providers (not billing-capable yet): ${result.skippedProviders.join(", ")}`),
    );
  }
  io.out("");
  io.out("payweave push: done.");
  return 0;
}

export const pushCommand: CliCommand = {
  name: "push",
  summary: "Apply pending database migrations and sync plans to your provider(s)",
  run: (argv, io) => runPushCommand(argv, io),
};
