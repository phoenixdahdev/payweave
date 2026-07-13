/**
 * `payweave status` — validate the whole setup, read-only (docs/v1/cli.md §4,
 * PW-1003). Loads the user's config through PW-1002's loader, then runs the
 * five checks §4 documents, in order:
 *
 *   1. Configuration file validity (providers, products, database) — reported
 *      from the already-constructed client (loading it is itself proof it's
 *      valid; PW-1002 owns that validation, this command never re-validates).
 *   2. Database connection.
 *   3. Migration status ("does `push` need to run?").
 *   4. Provider API connectivity — one harmless, read-only call per configured
 *      provider (never a mutation; golden rule 4 — no bare-POST retries, and
 *      this never POSTs at all).
 *   5. Sync status between config, database, and provider(s).
 *
 * Every check ALWAYS runs, even after an earlier one fails — a diagnostic
 * that stops at the first failure is useless (cli.md §4 contract notes).
 * Checks 2/3/5 need a configured database (and, for #5, products too); when
 * that section is absent they are SKIPPED, not failed — `status` on a
 * payments-only project must still pass.
 *
 * `--throw` turns a failed check into a non-zero exit for CI use (contract.yml
 * gates the e2e suites behind it); the default mode always exits 0 — it's a
 * diagnostic, not an assertion (cli.md §4).
 *
 * Secrets discipline (cli.md §7/§8): every printed message that could carry
 * secret material — provider error text, database connection failures — is
 * routed through the SAME `redact()` the SDK uses. This command never prints
 * a raw secret key: the constructed `PayweaveClient` doesn't expose one in the
 * first place (it's closed over inside each provider's `HttpClient` auth
 * strategy), so there is nothing here TO leak by construction; `redact()` is
 * the belt-and-braces second layer for whatever provider/database error text
 * echoes back.
 *
 * NOTE for whoever lands PW-609 (`contract.yml`): cli.md §8/§9 asks for
 * `payweave status --throw` to run before the e2e suites. That workflow file
 * is PW-609's to create — this ticket does not touch `.github/workflows/*`.
 * Wire it as: `node dist/cli/index.js status --throw` (or the packed bin)
 * against a real fixture project.
 *
 * Two SDK surfaces this command depends on for its full check set are still
 * in flight: PW-802 (products config) and PW-803 (billing sync) have not yet
 * wired `database`/`products` onto the object `createPayweave` returns in
 * `src/index.ts` (today they're validated by `resolvePayweaveConfig` but
 * never attached to the client — see `core/config.ts`). This command is
 * written to *degrade gracefully* rather than assume that shape: it duck-types
 * optional `database`/`products` fields on the loaded client
 * ({@link StatusClientLike}) and reports "not configured" whenever they're
 * absent — exactly the same code path a real payments-only project takes.
 * Once PW-802/803 attach those fields, this command picks them up with no
 * changes needed here.
 */
import mri from "mri";

import type { CliCommand, CliIo } from "./command";
import {
  loadConfig,
  type LoadConfigOptions,
  type LoadedConfig,
  type PayweaveClientLike,
} from "./config-loader";
import { redact } from "../core/redact";

// ── Result shape ─────────────────────────────────────────────────────────────

/** One check's outcome. `skip` means "not applicable", never a failure. */
export type StatusCheckStatus = "pass" | "fail" | "skip";

/** A single reported line of `payweave status` output. */
export interface StatusCheck {
  /** Stable, machine-greppable identifier (e.g. `"provider:stripe"`). */
  readonly name: string;
  readonly status: StatusCheckStatus;
  /** Human-readable detail — secret-safe (already passed through `redact()`). */
  readonly message: string;
}

/** The full result of running every check once. */
export interface StatusResult {
  readonly checks: readonly StatusCheck[];
  /** `true` iff no check reports `"fail"` (skips don't count against this). */
  readonly ok: boolean;
}

// ── The client shape status introspects ──────────────────────────────────────

/**
 * Minimal structural shape of the read-only calls this command makes against
 * a configured database adapter — deliberately NOT the full
 * `payweave/db` `DatabaseAdapter` contract (this command is forbidden from
 * touching `src/db/*` internals; it only ever calls the one read-only method
 * every adapter implements, database.md §3/§4).
 */
export interface StatusDatabaseLike {
  readonly dialect?: string | undefined;
  readonly migrations: {
    status(): Promise<{ pending: readonly string[]; applied: readonly string[] }>;
  };
}

/** The subset of a provider's Surface A this command calls for connectivity. */
export interface StatusStripeLike {
  readonly products: { list(query?: unknown): Promise<unknown> };
}
export interface StatusPaystackLike {
  readonly transfers: { balance(): Promise<unknown> };
}
export interface StatusFlutterwaveLike {
  readonly banks: { list(country: string): Promise<unknown> };
}

/**
 * The extended client shape `status` reads from (superset of PW-1002's
 * {@link PayweaveClientLike}). Every added field is OPTIONAL and duck-typed —
 * see the module doc comment on why `database`/`products` don't exist on
 * today's real client yet, and why that's fine.
 */
export interface StatusClientLike extends PayweaveClientLike {
  readonly stripe?: StatusStripeLike | undefined;
  readonly paystack?: StatusPaystackLike | undefined;
  readonly flutterwave?: StatusFlutterwaveLike | undefined;
  readonly database?: StatusDatabaseLike | undefined;
  readonly products?: readonly unknown[] | undefined;
}

type KnownProvider = "stripe" | "paystack" | "flutterwave";

function isKnownProvider(id: string): id is KnownProvider {
  return id === "stripe" || id === "paystack" || id === "flutterwave";
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const pass = (name: string, message: string): StatusCheck => ({ name, status: "pass", message });
const fail = (name: string, message: string): StatusCheck => ({ name, status: "fail", message });
const skip = (name: string, message: string): StatusCheck => ({ name, status: "skip", message });

/** Extract a printable message from anything a `catch` might hand us. */
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

/**
 * Route a string through the SDK's one redaction path (cli.md §7/§8). Every
 * message this module prints that could have come from a provider/database
 * error passes through here first.
 */
function redactMessage(message: string): string {
  const scrubbed = redact(message);
  return typeof scrubbed === "string" ? scrubbed : message;
}

/** Actionable fix per error-taxonomy class (cli.md §8's format). `undefined` = no specific fix known. */
function actionableFix(name: string): string | undefined {
  switch (name) {
    case "PayweaveAuthError":
      return "check the configured secret key is valid, unrevoked, and matches the intended environment";
    case "PayweaveNetworkError":
      return "check network connectivity / DNS / firewall rules to the provider's API";
    case "PayweaveRateLimitError":
      return "the provider is rate-limiting this key — retry later";
    case "PayweaveConfigError":
      return "fix the configuration named above";
    case "PayweaveValidationError":
      return "the request Payweave sent was rejected — this points at a Payweave bug, please report it";
    default:
      return undefined;
  }
}

/** Build a `<ErrorClass>: <message> — <fix>` line per cli.md §8's taxonomy-mapped format. */
function describeFailure(err: unknown): string {
  const name = errorName(err);
  const message = redactMessage(errorMessage(err));
  const fix = name !== undefined ? actionableFix(name) : undefined;
  const prefix = name !== undefined ? `${name}: ` : "";
  return `${prefix}${message}${fix !== undefined ? ` — ${fix}` : ""}`;
}

// ── Individual checks ─────────────────────────────────────────────────────────

/** Defensive summary of `capabilities()` — tolerates any shape (its type is duck-typed `unknown`). */
function summarizeCapabilities(client: StatusClientLike): string {
  let raw: unknown;
  try {
    raw = client.capabilities();
  } catch {
    return "unavailable";
  }
  if (raw === null || typeof raw !== "object") return "unavailable";
  const parts: string[] = [];
  for (const provider of client.providers) {
    const ops = (raw as Record<string, unknown>)[provider];
    if (ops === null || typeof ops !== "object") continue;
    const entries = Object.values(ops as Record<string, unknown>);
    const supported = entries.filter(
      (v) => v !== null && typeof v === "object" && (v as { supported?: unknown }).supported === true,
    ).length;
    parts.push(`${provider} ${supported}/${entries.length}`);
  }
  return parts.length > 0 ? `${parts.join(", ")} unified ops supported` : "unavailable";
}

/** Check 1 — config validity. Always `pass`: getting here means `loadConfig` already proved it parses. */
function checkConfig(client: StatusClientLike): StatusCheck {
  const database = client.database !== undefined ? "configured" : "not configured";
  const products =
    client.products !== undefined ? `${client.products.length} loaded` : "not configured";
  return pass(
    "config",
    `providers: ${client.providers.join(", ") || "none"} | environment: ${client.environment} | ` +
      `database: ${database} | products: ${products} | capabilities: ${summarizeCapabilities(client)}`,
  );
}

/** Checks 2+3 — database connection + migration status, sharing one read-only call. */
async function checkDatabase(
  client: StatusClientLike,
): Promise<{ connection: StatusCheck; migrations: StatusCheck }> {
  const database = client.database;
  if (database === undefined) {
    return {
      connection: skip("database", "no database configured — payments-only project, nothing to check"),
      migrations: skip("migrations", "no database configured"),
    };
  }
  try {
    const status = await database.migrations.status();
    const connection = pass("database", `reachable${database.dialect ? ` (${database.dialect})` : ""}`);
    const migrations =
      status.pending.length === 0
        ? pass("migrations", "up to date — no pending migrations")
        : fail(
            "migrations",
            `${status.pending.length} pending migration(s): ${status.pending.join(", ")} — run \`payweave push\``,
          );
    return { connection, migrations };
  } catch (err) {
    return {
      connection: fail("database", `unreachable — ${describeFailure(err)}`),
      migrations: skip("migrations", "skipped — database connection failed"),
    };
  }
}

/** Check 4 — one harmless read per configured provider (never a mutation). */
async function checkProviderConnectivity(
  client: StatusClientLike,
  provider: KnownProvider,
): Promise<StatusCheck> {
  const name = `provider:${provider}`;
  try {
    if (provider === "stripe") {
      if (client.stripe === undefined) return skip(name, "stripe namespace not mounted on this client");
      // Products.list — a plain, always-available read (providers.md §3.2).
      await client.stripe.products.list({ limit: 1 });
    } else if (provider === "paystack") {
      if (client.paystack === undefined) return skip(name, "paystack namespace not mounted on this client");
      // Transfers balance — a harmless account-level read (Paystack docs:
      // https://paystack.com/docs/api/transfer/#balance).
      await client.paystack.transfers.balance();
    } else {
      if (client.flutterwave === undefined) {
        return skip(name, "flutterwave namespace not mounted on this client");
      }
      // Banks-by-country — a harmless read with no customer data (Flutterwave
      // v3 docs: https://developer.flutterwave.com/v3.0.0/reference/get-all-banks).
      // "NG" is Flutterwave's primary market; this is a connectivity probe,
      // not a real bank lookup, so the specific country is inconsequential.
      await client.flutterwave.banks.list("NG");
    }
    return pass(name, `connected — ${client.environment}-mode key is valid`);
  } catch (err) {
    return fail(name, describeFailure(err));
  }
}

/** Check 5 — config↔database↔provider sync status. */
function checkSyncStatus(client: StatusClientLike): StatusCheck {
  if (client.database === undefined || client.products === undefined) {
    return skip("sync", "no database/products configured — nothing to sync");
  }
  // PW-803 (billing sync) hasn't landed a sync-state read surface on the
  // client yet — see the module doc comment. Once it does, this branch reads
  // it instead of always skipping.
  return skip(
    "sync",
    "sync-state introspection requires PW-803 (billing sync) — not available on this client yet",
  );
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Run every §4 check once, in doc order, against an already-loaded client.
 * Never throws — check failures are reported as `"fail"` entries, not thrown
 * errors; only a bug in this function itself would throw.
 */
export async function runStatusChecks(client: StatusClientLike): Promise<StatusResult> {
  const checks: StatusCheck[] = [checkConfig(client)];

  const db = await checkDatabase(client);
  checks.push(db.connection, db.migrations);

  for (const provider of client.providers) {
    if (!isKnownProvider(provider)) {
      checks.push(skip(`provider:${provider}`, `no connectivity check implemented for provider "${provider}"`));
      continue;
    }
    checks.push(await checkProviderConnectivity(client, provider));
  }

  checks.push(checkSyncStatus(client));

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

const STATUS_LABEL: Record<StatusCheckStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

/** Render one check as a terminal line. Exported so tests can assert on exact formatting. */
export function formatCheckLine(check: StatusCheck): string {
  return `[${STATUS_LABEL[check.status].padEnd(4)}] ${check.name.padEnd(18)} ${check.message}`;
}

/** Options accepted by {@link runStatusCommand} beyond the CLI flags themselves. */
export interface StatusCommandOptions {
  /** Injectable for tests; defaults to the real PW-1002 loader. */
  loadConfig?: (options: LoadConfigOptions) => Promise<LoadedConfig>;
  /** Project root `loadConfig` searches from (passed through to it). */
  cwd?: string;
}

/**
 * `payweave status`'s `run` body (cli.md §4). Parses its own flags (per
 * `./run`'s dispatch contract — the global dispatcher hands subcommands their
 * raw argv): `--config <path>` (config discovery override) and `--throw`
 * (CI gate).
 *
 * Exit codes: config failed to load → 1, unconditionally (nothing to
 * diagnose without a client). Otherwise: `--throw` → 1 iff any check failed,
 * 0 if all passed/skipped; without `--throw` → always 0 (cli.md §4: default
 * mode is a diagnostic, never a gate).
 */
export async function runStatusCommand(
  argv: readonly string[],
  io: CliIo,
  options: StatusCommandOptions = {},
): Promise<number> {
  const args = mri([...argv], { boolean: ["throw"], string: ["config"] });
  const loader = options.loadConfig ?? loadConfig;

  let loaded: LoadedConfig;
  try {
    loaded = await loader({
      configPath: typeof args["config"] === "string" ? args["config"] : undefined,
      cwd: options.cwd,
    });
  } catch (err) {
    io.err(`payweave status: failed to load config — ${describeFailure(err)}`);
    return 1;
  }

  const result = await runStatusChecks(loaded.client as StatusClientLike);

  io.out(`Payweave status — config: ${loaded.path}`);
  io.out("");
  for (const check of result.checks) {
    io.out(formatCheckLine(check));
  }
  io.out("");
  const passed = result.checks.filter((c) => c.status === "pass").length;
  const failed = result.checks.filter((c) => c.status === "fail").length;
  const skipped = result.checks.filter((c) => c.status === "skip").length;
  io.out(`${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (args["throw"] === true && !result.ok) {
    io.err("payweave status --throw: one or more checks failed (see FAIL lines above)");
    return 1;
  }
  return 0;
}

export const statusCommand: CliCommand = {
  name: "status",
  summary: "Validate config, database, migrations, and provider connectivity (cli.md §4)",
  ticket: "PW-1003",
  run: (argv, io) => runStatusCommand(argv, io),
};
