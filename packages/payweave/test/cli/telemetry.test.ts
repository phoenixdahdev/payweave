/**
 * PW-1007 — anonymous CLI telemetry (docs/v1/cli.md §6).
 *
 * Four layers, mirroring the other `test/cli/*.test.ts` suites:
 *   1. `buildTelemetryPayload` — the exact anonymous field shape, and the
 *      `redact()` defense-in-depth pass (redaction snapshot).
 *   2. Kill switches (`PAYWEAVE_TELEMETRY_DISABLED`, `DO_NOT_TRACK`) +
 *      the separate automation/CI-or-test auto-disable.
 *   3. `withTelemetry` — the dispatch wrapper `./run` consumes: first-run
 *      notice persistence, fail-safe behavior (throwing sender / unwritable
 *      state file / real command errors), and that it never changes what the
 *      wrapped command itself returns or throws.
 *   4. A grep-style guard proving the SDK (`src/` outside `src/cli/`) carries
 *      zero telemetry code (cli.md §6 — "CLI only").
 *
 * The real default network sender (used when no `send` option is injected)
 * is deliberately NOT exercised against a live/mocked socket here — every
 * `withTelemetry` test below injects its own `send` (per the ticket's own
 * test recipe: "inject a throwing sender"), keeping this suite hermetic and
 * proxy/network-environment independent. Its fail-safety is proven via the
 * injected-throwing-sender tests, which exercise the exact same `finally`
 * block the real sender runs inside of.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/command";
import {
  buildTelemetryPayload,
  isAutomationEnvironment,
  isKillSwitchSet,
  isTelemetryDisabled,
  withTelemetry,
  type TelemetryPayload,
} from "../../src/cli/telemetry";
import { CLI_VERSION } from "../../src/cli/version";
import { REDACTED } from "../../src/core/redact";

// ── Shared capture/io helper (run.test.ts / status.test.ts precedent) ───────

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
};

/** A fresh, isolated temp dir for the persisted "notice shown" state file — never the real home dir. */
function freshStatePath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "payweave-telemetry-test-"));
  return { dir, path: join(dir, "telemetry-state.json") };
}

/**
 * A live-looking secret, assembled at runtime so this SOURCE FILE never
 * contains the contiguous 20+-char shape `scripts/check-no-secrets.mjs`
 * scans for (AGENTS.md §2 rule 5 / the playbook's no-secrets guardrail).
 */
function buildRuntimeSecret(): string {
  const prefix = ["sk", "test"].join("_") + "_";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let body = "";
  for (let i = 0; i < 24; i++) body += alphabet[(i * 7 + 3) % alphabet.length];
  return prefix + body;
}

// ── 1. Payload shape + redaction ─────────────────────────────────────────────

describe("buildTelemetryPayload (cli.md §6 — anonymous fields only)", () => {
  it("emits only the documented fields for a successful command", () => {
    const payload = buildTelemetryPayload({ command: "status", success: true, durationMs: 42 });
    expect(payload).toEqual({
      event: "cli_command",
      command: "status",
      success: true,
      durationMs: 42,
      cliVersion: CLI_VERSION,
      nodeMajor: expect.any(Number),
    });
    expect(Object.keys(payload).sort()).toEqual(
      ["cliVersion", "command", "durationMs", "event", "nodeMajor", "success"].sort(),
    );
  });

  it("adds only a taxonomy errorClass (never the error message) on failure", () => {
    const err = Object.assign(new Error("some message with /Users/jane/secret-project/payweave.ts in it"), {
      name: "PayweaveConfigError",
    });
    const payload = buildTelemetryPayload({ command: "push", success: false, durationMs: 7, error: err });
    expect(payload).toEqual({
      event: "cli_command",
      command: "push",
      success: false,
      durationMs: 7,
      cliVersion: CLI_VERSION,
      nodeMajor: expect.any(Number),
      errorClass: "PayweaveConfigError",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("/Users/jane/secret-project");
    expect(serialized).not.toContain("some message");
  });

  it("falls back to a generic taxonomy class for an unnamed thrown value", () => {
    const payload = buildTelemetryPayload({ command: "init", success: false, durationMs: 1, error: "just a string" });
    expect(payload.errorClass).toBe("Unknown");
  });

  it("never carries argument values, file paths, or config content — only the fixed field set (snapshot)", () => {
    const err = Object.assign(new Error("ignored"), { name: "PayweaveAuthError" });
    const payload = buildTelemetryPayload({ command: "status", success: false, durationMs: 123, error: err });
    expect(payload).toMatchSnapshot({
      cliVersion: expect.any(String),
      nodeMajor: expect.any(Number),
    });
  });

  it("redaction defense-in-depth: scrubs secret-shaped text even if it reached errorClass", () => {
    // Simulates a hypothetical future bug (or a third-party error whose
    // `.name` was itself set to something sensitive) — buildTelemetryPayload
    // never reads `.message`, but this proves the belt-and-braces redact()
    // pass over the WHOLE payload still catches a secret-shaped `.name`.
    const secret = buildRuntimeSecret();
    const forged = new Error("forged for the redaction test");
    forged.name = secret;

    const payload = buildTelemetryPayload({ command: "status", success: false, durationMs: 10, error: forged });

    expect(payload.errorClass).toBe(REDACTED);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(secret);
  });
});

// ── 2. Kill switches + automation auto-disable ──────────────────────────────

describe("kill switches (cli.md §6 — either alone disables telemetry)", () => {
  it("PAYWEAVE_TELEMETRY_DISABLED=1 alone disables", () => {
    expect(isKillSwitchSet({ PAYWEAVE_TELEMETRY_DISABLED: "1" })).toBe(true);
    expect(isTelemetryDisabled({ PAYWEAVE_TELEMETRY_DISABLED: "1" })).toBe(true);
  });

  it("DO_NOT_TRACK=1 alone disables", () => {
    expect(isKillSwitchSet({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isTelemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
  });

  it("either variable set to a non-falsy string still disables (not just \"1\")", () => {
    expect(isKillSwitchSet({ PAYWEAVE_TELEMETRY_DISABLED: "true" })).toBe(true);
    expect(isKillSwitchSet({ DO_NOT_TRACK: "yes" })).toBe(true);
  });

  it.each(["0", "false", "", undefined])("falsy value %p does NOT disable either variable", (value) => {
    const env = value === undefined ? {} : { PAYWEAVE_TELEMETRY_DISABLED: value, DO_NOT_TRACK: value };
    expect(isKillSwitchSet(env)).toBe(false);
  });

  it("neither variable set, no automation markers => telemetry stays enabled", () => {
    expect(isTelemetryDisabled({})).toBe(false);
  });
});

describe("automation environment auto-disable (implementation safeguard, separate from the two kill switches)", () => {
  it("CI=true is treated as disabled by default", () => {
    expect(isAutomationEnvironment({ CI: "true" })).toBe(true);
    expect(isTelemetryDisabled({ CI: "true" })).toBe(true);
  });

  it("VITEST=true is treated as disabled by default", () => {
    expect(isAutomationEnvironment({ VITEST: "true" })).toBe(true);
  });

  it("NODE_ENV=test is treated as disabled by default", () => {
    expect(isAutomationEnvironment({ NODE_ENV: "test" })).toBe(true);
  });

  it("a plain env with none of these markers is not auto-disabled", () => {
    expect(isAutomationEnvironment({})).toBe(false);
  });

  it("this package's OWN real test process environment is disabled by default", () => {
    // No override at all — the actual process.env vitest runs under.
    expect(isTelemetryDisabled()).toBe(true);
  });
});

// ── 3. withTelemetry — the dispatch wrapper ──────────────────────────────────

describe("withTelemetry (the seam ./run wraps every dispatched command with)", () => {
  it("disabled via PAYWEAVE_TELEMETRY_DISABLED: no send, no notice, no state file — returns the command's own result", async () => {
    const { dir, path } = freshStatePath();
    try {
      const sent: TelemetryPayload[] = [];
      const c = capture();
      const exit = await withTelemetry("status", () => 0, c.io, {
        env: { PAYWEAVE_TELEMETRY_DISABLED: "1" },
        send: (p) => sent.push(p),
        statePath: path,
      });
      expect(exit).toBe(0);
      expect(sent).toEqual([]);
      expect(c.err()).toBe("");
      expect(c.out()).toBe("");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disabled via DO_NOT_TRACK: no send, no notice, no state file", async () => {
    const { dir, path } = freshStatePath();
    try {
      const sent: TelemetryPayload[] = [];
      const c = capture();
      const exit = await withTelemetry("push", () => 1, c.io, {
        env: { DO_NOT_TRACK: "1" },
        send: (p) => sent.push(p),
        statePath: path,
      });
      expect(exit).toBe(1);
      expect(sent).toEqual([]);
      expect(c.err()).toBe("");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the first-run notice exactly once (persisted flag), naming both kill switches", async () => {
    const { dir, path } = freshStatePath();
    try {
      const env = {}; // no kill switches, no automation markers => enabled
      const sent: TelemetryPayload[] = [];

      const first = capture();
      await withTelemetry("status", () => 0, first.io, { env, send: (p) => sent.push(p), statePath: path });
      expect(first.err()).toContain("PAYWEAVE_TELEMETRY_DISABLED");
      expect(first.err()).toContain("DO_NOT_TRACK");
      expect(existsSync(path)).toBe(true);

      const second = capture();
      await withTelemetry("push", () => 0, second.io, { env, send: (p) => sent.push(p), statePath: path });
      expect(second.err()).toBe(""); // not shown again
      // Telemetry itself (the anonymous count) still fires both times — only
      // the human-readable NOTICE is one-time.
      expect(sent).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throwing sender never fails or blocks a successful command (fail-safe)", async () => {
    const { dir, path } = freshStatePath();
    try {
      const c = capture();
      const throwingSend = () => {
        throw new Error("network unreachable");
      };
      const exit = await withTelemetry("status", () => 0, c.io, { env: {}, send: throwingSend, statePath: path });
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throwing sender never masks a command's own non-zero exit code", async () => {
    const { dir, path } = freshStatePath();
    try {
      const c = capture();
      const throwingSend = () => {
        throw new Error("network unreachable");
      };
      const exit = await withTelemetry("push", () => 1, c.io, { env: {}, send: throwingSend, statePath: path });
      expect(exit).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unwritable state file degrades silently — never crashes the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payweave-telemetry-test-"));
    try {
      // A FILE where a directory is expected: mkdirSync(dirname(statePath))
      // throws ENOTDIR — proves the write failure is swallowed (brief:
      // "the state file write can fail ... degrade silently").
      const blocker = join(dir, "blocker-file");
      writeFileSync(blocker, "not a directory");
      const badStatePath = join(blocker, "nested", "telemetry-state.json");

      const c = capture();
      const exit = await withTelemetry("status", () => 0, c.io, { env: {}, send: () => {}, statePath: badStatePath });
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates the command's own thrown error unchanged (telemetry only observes)", async () => {
    const { dir, path } = freshStatePath();
    try {
      const sent: TelemetryPayload[] = [];
      const c = capture();
      await expect(
        withTelemetry(
          "push",
          () => {
            throw new Error("boom");
          },
          c.io,
          { env: {}, send: (p) => sent.push(p), statePath: path },
        ),
      ).rejects.toThrow("boom");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.success).toBe(false);
      expect(sent[0]?.errorClass).toBe("Error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports command name, success, and duration for a real invocation", async () => {
    const { dir, path } = freshStatePath();
    try {
      let clock = 100;
      const sent: TelemetryPayload[] = [];
      const c = capture();
      const exit = await withTelemetry("push", () => 0, c.io, {
        env: {},
        send: (p) => sent.push(p),
        statePath: path,
        now: () => (clock += 5),
      });
      expect(exit).toBe(0);
      expect(sent).toEqual([
        {
          event: "cli_command",
          command: "push",
          success: true,
          durationMs: 5,
          cliVersion: CLI_VERSION,
          nodeMajor: expect.any(Number),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports an async command body and still resolves to its exit code", async () => {
    const { dir, path } = freshStatePath();
    try {
      const c = capture();
      const exit = await withTelemetry(
        "listen",
        () => new Promise<number>((r) => setTimeout(() => r(0), 1)),
        c.io,
        { env: { PAYWEAVE_TELEMETRY_DISABLED: "1" }, statePath: path },
      );
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op by default in this package's own test run (real process.env, real sender, real state path)", async () => {
    const c = capture();
    // No overrides at all: real process.env (VITEST/NODE_ENV=test => disabled
    // per the automation guard above), real default sender, real state-file
    // path resolution. Must be fast, silent, and side-effect free.
    const exit = await withTelemetry("status", () => 0, c.io);
    expect(exit).toBe(0);
    expect(c.err()).toBe("");
    expect(c.out()).toBe("");
  });

  it("resolves the default state-file path under XDG_CONFIG_HOME when no statePath is injected", async () => {
    const xdgHome = mkdtempSync(join(tmpdir(), "payweave-telemetry-xdg-"));
    try {
      const c = capture();
      const exit = await withTelemetry("status", () => 0, c.io, {
        env: { XDG_CONFIG_HOME: xdgHome },
        send: () => {},
        // No `statePath` override — exercises the real default resolution.
      });
      expect(exit).toBe(0);
      expect(c.err()).toContain("PAYWEAVE_TELEMETRY_DISABLED");
      const expectedPath = join(xdgHome, "payweave", "telemetry-state.json");
      expect(existsSync(expectedPath)).toBe(true);
      expect(JSON.parse(readFileSync(expectedPath, "utf8"))).toEqual({ noticeShown: true });
    } finally {
      rmSync(xdgHome, { recursive: true, force: true });
    }
  });
});

// ── 4. No SDK telemetry guard ─────────────────────────────────────────────────

describe("SDK scope guard (cli.md §6 — \"No telemetry is collected from the SDK itself — CLI only\")", () => {
  it("nothing under src/ outside src/cli/ mentions telemetry or its env vars", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = resolve(here, "../..");
    const srcRoot = join(pkgRoot, "src");
    const cliRoot = join(srcRoot, "cli") + sep;

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        if (full.startsWith(cliRoot)) continue;
        const content = readFileSync(full, "utf8");
        if (/telemetry|do_not_track|payweave_telemetry_disabled/i.test(content)) {
          offenders.push(full);
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});
