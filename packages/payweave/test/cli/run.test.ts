/**
 * PW-1001 — `payweave` CLI dispatch (docs/v1/cli.md §7; replaces the PW-505
 * stub test). The bin entry itself (src/cli/index.ts, shebang + process
 * wiring) is exercised end-to-end by scripts/test-cli-tarball.mjs; these tests
 * cover the dispatch table via the injectable io.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/command";
import { run, COMMANDS } from "../../src/cli/run";
import { CLI_VERSION } from "../../src/cli/version";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
};

describe("payweave CLI dispatch (PW-1001)", () => {
  describe("--help", () => {
    it.each([["--help"], ["-h"]])("%s prints usage listing every command and exits 0", async (flag) => {
      const c = capture();
      await expect(run([flag], c.io)).resolves.toBe(0);
      expect(c.out()).toContain("Usage");
      expect(c.out()).toContain("payweave <command>");
      for (const name of ["init", "push", "listen", "status"]) {
        expect(c.out()).toContain(name);
      }
      expect(c.err()).toBe("");
    });

    it("bare `payweave` prints the same usage and exits 0", async () => {
      const c = capture();
      await expect(run([], c.io)).resolves.toBe(0);
      expect(c.out()).toContain("Usage");
      expect(c.err()).toBe("");
    });

    it("global --help wins even when a command is present", async () => {
      const c = capture();
      await expect(run(["push", "--help"], c.io)).resolves.toBe(0);
      expect(c.out()).toContain("Usage");
    });

    it("marks unshipped commands with their owning ticket", async () => {
      const c = capture();
      await run(["--help"], c.io);
      // `status` (PW-1003), `push` (PW-1004), `init` (PW-1005), and `listen`
      // (PW-1006, this ticket) shipped — none are "coming with" anymore.
      expect(c.out()).not.toContain("coming with PW-1003");
      expect(c.out()).not.toContain("coming with PW-1004");
      expect(c.out()).not.toContain("coming with PW-1005");
      expect(c.out()).not.toContain("coming with PW-1006");
    });
  });

  describe("--version", () => {
    it.each([["--version"], ["-v"]])("%s prints only the version and exits 0", async (flag) => {
      const c = capture();
      await expect(run([flag], c.io)).resolves.toBe(0);
      expect(c.out()).toBe(CLI_VERSION);
      expect(c.err()).toBe("");
    });

    it("CLI_VERSION mirrors package.json#version (build-time injection contract)", () => {
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(CLI_VERSION).toBe(pkg.version);
    });
  });

  describe("dispatch table", () => {
    it("registers exactly the four documented commands, in docs order (cli.md §1–§4)", () => {
      expect(COMMANDS.map((c) => c.name)).toEqual(["init", "push", "listen", "status"]);
    });

    it("`payweave listen` is implemented (PW-1006): exits non-zero on a load failure, not the placeholder message", async () => {
      const c = capture();
      // No payweave config discoverable from the repo root test cwd — a real
      // "failed to load config" error, never the PW-1001 placeholder text.
      await expect(run(["listen"], c.io)).resolves.toBe(1);
      expect(c.err()).not.toContain("is not available yet");
      expect(c.err()).toContain("payweave listen: failed to load config");
    });

    it("`payweave init` is implemented (PW-1005): exits non-zero needing a terminal, not the placeholder message", async () => {
      const c = capture();
      // No TTY and no injected prompts under the test runner — the real
      // non-interactive guard fires, never the PW-1001 placeholder text.
      await expect(run(["init"], c.io)).resolves.toBe(1);
      expect(c.err()).not.toContain("is not available yet");
      expect(c.err()).toContain("payweave init: needs an interactive terminal");
    });

    it("`payweave status` is implemented (PW-1003): exits non-zero on a load failure, not the placeholder message", async () => {
      const c = capture();
      // No payweave config discoverable from the repo root test cwd — a real
      // "failed to load config" error, never the PW-1001 placeholder text.
      await expect(run(["status"], c.io)).resolves.toBe(1);
      expect(c.err()).not.toContain("is not available yet");
      expect(c.err()).toContain("payweave status: failed to load config");
    });

    it("`payweave push` is implemented (PW-1004): exits non-zero on a load failure, not the placeholder message", async () => {
      const c = capture();
      // No payweave config discoverable from the repo root test cwd — a real
      // "failed to load config" error, never the PW-1001 placeholder text.
      await expect(run(["push"], c.io)).resolves.toBe(1);
      expect(c.err()).not.toContain("is not available yet");
      expect(c.err()).toContain("payweave push: failed to load config");
    });

    it("unknown command exits 2 with usage on stderr (brief: non-zero + usage)", async () => {
      const c = capture();
      await expect(run(["frobnicate"], c.io)).resolves.toBe(2);
      expect(c.err()).toContain('unknown command "frobnicate"');
      expect(c.err()).toContain("Usage");
      expect(c.out()).toBe("");
    });

    it("does not hijack -v for subcommands (free for e.g. --verbose later)", async () => {
      const c = capture();
      await expect(run(["push", "-v"], c.io)).resolves.toBe(1);
      expect(c.out()).toBe("");
      // `push` never saw a `-v`/`--version` shortcut of its own — it ran its
      // real body (config discovery) and failed for that reason, not because
      // the global dispatcher swallowed the flag.
      expect(c.err()).toContain("payweave push: failed to load config");
    });
  });
});
