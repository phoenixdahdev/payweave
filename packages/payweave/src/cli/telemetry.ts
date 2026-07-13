/**
 * Anonymous CLI usage telemetry (docs/v1/cli.md §6; PW-1007).
 *
 * Collects exactly: which command ran, whether it succeeded, how long it
 * took, and two coarse platform facts (the CLI's own version, Node's major
 * version) — {@link TelemetryPayload} is the exhaustive field list. Never
 * keys, plan/config content, file paths, argument values, error message
 * text, or a user/machine identifier of any kind (cli.md §6 — "never keys,
 * plan contents, or identifiers"; the PW-1007 brief is explicit that this
 * means NO install id either: "resist adding an install id without a spec
 * change — §6 says counts only"). Every payload additionally passes through
 * the SDK's one {@link redact} path before being returned/serialized —
 * defense in depth, even though none of these fields are ever secret-shaped
 * by construction (see `buildTelemetryPayload`'s doc comment).
 *
 * Two independent kill switches — either alone disables telemetry entirely
 * (cli.md §6):
 *   - `PAYWEAVE_TELEMETRY_DISABLED=1`
 *   - `DO_NOT_TRACK=1` (the community convention, https://do-not-track.dev)
 *
 * This module also treats automated/non-interactive environments (this
 * package's own `vitest` suite, or any consumer's CI runner) as disabled by
 * default — see {@link isAutomationEnvironment}'s doc comment for why that's
 * a deliberate, separate axis from the two documented variables above, not a
 * spec requirement in itself.
 *
 * Fail-safe by construction: the disabled check runs before ANY network or
 * state-file activity (brief's contract note — "env-var check happens before
 * any network or state-file activity"); a disabled run is a complete no-op,
 * indistinguishable from a build with no telemetry code at all. When
 * enabled, both the first-run notice and the outbound send are wrapped so
 * nothing they do — a read-only home directory, an unreachable endpoint, a
 * slow network — can throw, block, or change a command's exit code. The send
 * itself carries a short timeout and its socket is `unref()`d so the process
 * can exit the instant the real command is done, never waiting on telemetry
 * (brief: "telemetry must never delay exit, fail a command, or print network
 * errors").
 *
 * SDK scope: nothing under `src/` outside `src/cli/` imports this module, or
 * duplicates any of its logic (cli.md §6 — "No telemetry is collected from
 * the SDK itself — CLI only"); `test/cli/telemetry.test.ts` greps the source
 * tree to prove that.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as https from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { redact } from "../core/redact";
import type { CliIo } from "./command";
import { CLI_VERSION } from "./version";

// ── Payload shape ────────────────────────────────────────────────────────────

/** The exact, exhaustive set of fields ever sent (cli.md §6). Nothing else is ever added. */
export interface TelemetryPayload {
  readonly event: "cli_command";
  readonly command: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly cliVersion: string;
  readonly nodeMajor: number;
  /** Taxonomy CLASS only (e.g. `"PayweaveAuthError"`) — never `.message`. Present only on failure. */
  readonly errorClass?: string;
}

function nodeMajorVersion(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
}

/**
 * Duck-typed error taxonomy class — `.name` only, NEVER `.message` (brief:
 * "Failure telemetry must not embed error messages verbatim (they can
 * contain paths/URLs)"). Never `instanceof` (config-loader.ts precedent —
 * bundled copies of the SDK break identity checks); any thrown value without
 * a string `.name` reports as `"Unknown"` rather than risk stringifying
 * arbitrary (possibly sensitive) content.
 */
function errorTaxonomyClass(error: unknown): string {
  if (error !== null && typeof error === "object" && typeof (error as { name?: unknown }).name === "string") {
    return (error as { name: string }).name;
  }
  return "Unknown";
}

/**
 * Assemble one payload. The final `redact()` pass is defense-in-depth over
 * the WHOLE object (brief: "every outbound payload passes through redact()
 * before serialization ... even though fields are already non-sensitive") —
 * none of these keys ever match `redact()`'s sensitive-key patterns
 * (`authorization`/`secret`/`key`/`token`/... — see `core/redact.ts`), so
 * this is a no-op for a well-behaved caller. It only matters if a future bug
 * lets secret-shaped text reach `errorClass` (e.g. a third-party error whose
 * `.name` was itself set to something sensitive) — `redact()`'s value-scrub
 * still catches that shape and masks it.
 */
export function buildTelemetryPayload(input: {
  readonly command: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly error?: unknown;
}): TelemetryPayload {
  const payload: TelemetryPayload = {
    event: "cli_command",
    command: input.command,
    success: input.success,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    cliVersion: CLI_VERSION,
    nodeMajor: nodeMajorVersion(),
    ...(input.success ? {} : { errorClass: errorTaxonomyClass(input.error) }),
  };
  return redact(payload) as TelemetryPayload;
}

// ── Kill switches + automation auto-disable ─────────────────────────────────

/** Either variable disables telemetry outright, independently (cli.md §6). */
const KILL_SWITCH_ENV_VARS = ["PAYWEAVE_TELEMETRY_DISABLED", "DO_NOT_TRACK"] as const;

function isTruthyEnvValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** True iff either of the two documented kill-switch variables is set (cli.md §6). */
export function isKillSwitchSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return KILL_SWITCH_ENV_VARS.some((name) => isTruthyEnvValue(env[name]));
}

/**
 * Automated/non-interactive runs this module treats as disabled by default:
 * this package's own `vitest` suite (`VITEST`/`NODE_ENV=test`) and any CI
 * runner (`CI`, the near-universal convention GitHub Actions/etc. set).
 * Deliberately separate from {@link isKillSwitchSet} — this is an
 * implementation safeguard against inflating "usage" with ephemeral
 * automated invocations (precedent: Next.js/Turborepo telemetry both
 * auto-disable under CI), not one of cli.md §6's two named variables. A real
 * user's interactive terminal is never affected by it.
 */
export function isAutomationEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.CI) || isTruthyEnvValue(env.VITEST) || env.NODE_ENV === "test";
}

/** True if telemetry must not run at all — checked before any network or state-file activity. */
export function isTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isKillSwitchSet(env) || isAutomationEnvironment(env);
}

// ── First-run notice ─────────────────────────────────────────────────────────

const NOTICE_LINES: readonly string[] = [
  "payweave: collects anonymous CLI usage telemetry (command name, duration, success/failure — never keys, config, or identifiers).",
  "  Disable anytime with PAYWEAVE_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. This notice is shown once.",
];

interface TelemetryState {
  readonly noticeShown?: boolean;
}

/**
 * User-scoped (never project-scoped — brief: "persist ... in a small
 * user-scoped state file ... never inside the user's project") state file
 * location. `XDG_CONFIG_HOME` is honored where set (Linux convention);
 * otherwise `~/.config` — good enough across the platforms this ticket needs
 * to support without adding a dependency for OS-specific config-dir lookup.
 */
function defaultStateFilePath(env: NodeJS.ProcessEnv): string {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "payweave", "telemetry-state.json");
}

function readState(path: string): TelemetryState {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return raw !== null && typeof raw === "object" ? (raw as TelemetryState) : {};
  } catch {
    return {};
  }
}

/**
 * Print the one-time notice if it hasn't been shown before, then persist that
 * fact. Every filesystem operation here is wrapped: a read-only home
 * directory (some CI/sandboxed containers) must never crash a command over
 * telemetry bookkeeping (brief: "the state file write can fail ... degrade
 * silently; never crash a command over telemetry bookkeeping") — worst case,
 * the notice repeats on a future run.
 */
function printFirstRunNoticeOnce(io: CliIo, statePath: string): void {
  try {
    if (readState(statePath).noticeShown === true) return;
    for (const line of NOTICE_LINES) io.err(line);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ noticeShown: true }), "utf8");
  } catch {
    // Degrade silently — see doc comment above.
  }
}

// ── Fire-and-forget send ─────────────────────────────────────────────────────

/**
 * Client-side contract only (PW-1007 scope, per the brief's file list — the
 * ingestion service itself is not part of this ticket). Kept as a named
 * constant so a real endpoint can replace it in one place once that service
 * exists.
 */
const DEFAULT_ENDPOINT = "https://telemetry.payweave.dev/v1/cli-events";
const SEND_TIMEOUT_MS = 300;

export type TelemetrySender = (payload: TelemetryPayload) => void;

/**
 * POST the payload and forget about it: every failure mode (bad host, closed
 * network, slow server) is swallowed, and the request's socket is `unref()`d
 * so it can never keep the process alive waiting on a reply.
 */
const defaultSender: TelemetrySender = (payload) => {
  try {
    const body = JSON.stringify(payload);
    const url = new URL(DEFAULT_ENDPOINT);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        protocol: url.protocol,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: SEND_TIMEOUT_MS,
      },
      (res) => {
        res.resume(); // drain + discard — this module never reads a response
      },
    );
    req.on("error", () => {
      /* fail-safe: never surface a network error (brief) */
    });
    req.on("timeout", () => req.destroy());
    req.on("socket", (socket) => socket.unref());
    req.end(body);
  } catch {
    /* fail-safe: never throw building/sending the request */
  }
};

// ── Dispatch wrapper (consumed by ./run) ─────────────────────────────────────

/** Injectable seams for tests — every field defaults to the real thing. */
export interface TelemetryRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly send?: TelemetrySender;
  readonly statePath?: string;
  readonly now?: () => number;
}

/**
 * Wrap one command invocation with telemetry (cli.md §6). This is the single
 * seam `./run`'s dispatch calls — kept in its own module/function precisely
 * so PW-1006's `listen` registration touches a different region of `run.ts`
 * and the two changes merge without conflict.
 *
 * Always resolves to (or rethrows) exactly what `invoke()` does — telemetry
 * only OBSERVES the outcome, it never changes it. Reporting itself never
 * awaits the network send on the hot path: the send fires and the function
 * returns as soon as `invoke()` settles.
 */
export async function withTelemetry(
  commandName: string,
  invoke: () => number | Promise<number>,
  io: CliIo,
  options: TelemetryRuntimeOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  if (isTelemetryDisabled(env)) {
    return invoke();
  }

  printFirstRunNoticeOnce(io, options.statePath ?? defaultStateFilePath(env));

  const now = options.now ?? Date.now;
  const send = options.send ?? defaultSender;
  const start = now();
  let thrown: unknown;
  let exitCode = 1;
  try {
    exitCode = await invoke();
    return exitCode;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      const payload = buildTelemetryPayload({
        command: commandName,
        success: thrown === undefined && exitCode === 0,
        durationMs: now() - start,
        error: thrown,
      });
      send(payload);
    } catch {
      // fail-safe: telemetry construction/send never affects the command (brief).
    }
  }
}
