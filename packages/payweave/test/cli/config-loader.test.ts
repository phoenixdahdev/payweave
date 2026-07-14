/**
 * CLI config discovery + jiti loader (docs/v1/cli.md §5).
 *
 * Fixture projects live under `test/fixtures/cli/` (committed, one per
 * discovery location + failure mode). Every fixture that does
 * `import { createPayweave } from "payweave"` resolves it via a symlink this
 * suite creates at `test/fixtures/cli/node_modules/payweave`, pointing at
 * THIS package's own root — so the bare specifier resolves through ordinary
 * upward node_modules resolution to the REAL BUILT `dist/index.js` (never a
 * source path, and never this test file's own module instance), exactly like
 * a real user's installed dependency. That directory is gitignored
 * (`node_modules` matches at any depth) and created fresh per run.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isPayweaveClientLike,
  loadConfig,
  resolveConfigPath,
} from "../../src/cli/config-loader";
import { PayweaveConfigError } from "../../src/core/errors";

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

describe("isPayweaveClientLike (PW-1002 — duck-typed export detection)", () => {
  const validBase = {
    providers: ["paystack"],
    defaultProvider: "paystack",
    environment: "test" as const,
    webhooks: {
      verify: () => true,
      verifyOrThrow: () => undefined,
      constructEvent: () => ({}) as never,
    },
    capabilities: () => ({}),
  };

  it("accepts a structurally valid client", () => {
    expect(isPayweaveClientLike(validBase)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not an object"],
    ["an array", []],
    ["a number", 42],
  ])("rejects %s", (_label, value) => {
    expect(isPayweaveClientLike(value)).toBe(false);
  });

  it("rejects a missing providers array", () => {
    const rest = Object.fromEntries(
      Object.entries(validBase).filter(([k]) => k !== "providers"),
    );
    expect(isPayweaveClientLike(rest)).toBe(false);
  });

  it("rejects a non-array providers field", () => {
    expect(isPayweaveClientLike({ ...validBase, providers: "paystack" })).toBe(false);
  });

  it("rejects a non-string defaultProvider", () => {
    expect(isPayweaveClientLike({ ...validBase, defaultProvider: 1 })).toBe(false);
  });

  it("rejects an environment outside test/live", () => {
    expect(isPayweaveClientLike({ ...validBase, environment: "staging" })).toBe(false);
  });

  it("rejects a non-function capabilities", () => {
    expect(isPayweaveClientLike({ ...validBase, capabilities: "nope" })).toBe(false);
  });

  it("rejects a missing webhooks namespace", () => {
    const rest = Object.fromEntries(
      Object.entries(validBase).filter(([k]) => k !== "webhooks"),
    );
    expect(isPayweaveClientLike(rest)).toBe(false);
  });

  it("rejects a non-object webhooks", () => {
    expect(isPayweaveClientLike({ ...validBase, webhooks: "nope" })).toBe(false);
  });

  it.each(["verify", "verifyOrThrow", "constructEvent"])(
    "rejects webhooks missing a %s function",
    (key) => {
      const webhooks = { ...validBase.webhooks, [key]: undefined };
      expect(isPayweaveClientLike({ ...validBase, webhooks })).toBe(false);
    },
  );
});

describe("resolveConfigPath (PW-1002 — cli.md §5 resolution order)", () => {
  it("resolves a root payweave.ts", () => {
    const cwd = fixture("root-ts");
    expect(resolveConfigPath({ cwd })).toBe(join(cwd, "payweave.ts"));
  });

  it("falls back to payweave.config.ts when payweave.ts is absent", () => {
    const cwd = fixture("root-config-ts");
    expect(resolveConfigPath({ cwd })).toBe(join(cwd, "payweave.config.ts"));
  });

  it("falls back to src/payweave.ts when neither root filename exists", () => {
    const cwd = fixture("src-fallback");
    expect(resolveConfigPath({ cwd })).toBe(join(cwd, "src", "payweave.ts"));
  });

  it("prefers a root payweave.ts over a sibling src/payweave.ts", () => {
    const cwd = fixture("root-beats-src");
    expect(resolveConfigPath({ cwd })).toBe(join(cwd, "payweave.ts"));
  });

  it("throws naming every searched path, in order, when nothing is found", () => {
    const cwd = fixture("no-config");
    try {
      resolveConfigPath({ cwd });
      expect.fail("expected resolveConfigPath to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayweaveConfigError);
      const message = (err as PayweaveConfigError).message;
      expect(message).toContain("no Payweave config found");
      expect(message.indexOf(join(cwd, "payweave.ts"))).toBeGreaterThan(-1);
      expect(message.indexOf(join(cwd, "payweave.config.ts"))).toBeGreaterThan(
        message.indexOf(join(cwd, "payweave.ts")),
      );
      expect(message.indexOf(join(cwd, "src", "payweave.ts"))).toBeGreaterThan(
        message.indexOf(join(cwd, "payweave.config.ts")),
      );
    }
  });

  it("throws naming both files when root config is ambiguous", () => {
    const cwd = fixture("both-root");
    try {
      resolveConfigPath({ cwd });
      expect.fail("expected resolveConfigPath to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayweaveConfigError);
      const message = (err as PayweaveConfigError).message;
      expect(message).toContain("multiple Payweave config files found");
      expect(message).toContain("payweave.ts");
      expect(message).toContain("payweave.config.ts");
    }
  });

  it("--config bypasses discovery entirely, even when a discoverable file exists", () => {
    const cwd = fixture("root-ts"); // has its own payweave.ts, but --config wins
    const explicit = join(fixture("root-config-ts"), "payweave.config.ts");
    expect(resolveConfigPath({ cwd, configPath: explicit })).toBe(explicit);
  });

  it("--config resolves a relative path against cwd", () => {
    const cwd = fixture("root-ts");
    expect(resolveConfigPath({ cwd, configPath: "payweave.ts" })).toBe(join(cwd, "payweave.ts"));
  });

  it("--config naming a nonexistent path throws — never silently falls back to discovery", () => {
    const cwd = fixture("root-ts"); // discovery WOULD succeed here if it fell through
    try {
      resolveConfigPath({ cwd, configPath: "does-not-exist.ts" });
      expect.fail("expected resolveConfigPath to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayweaveConfigError);
      const message = (err as PayweaveConfigError).message;
      expect(message).toContain("--config does-not-exist.ts does not exist");
      expect(message).toContain(join(cwd, "does-not-exist.ts"));
    }
  });

  it("defaults cwd to process.cwd() when omitted", () => {
    const prevCwd = process.cwd();
    process.chdir(fixture("root-ts"));
    try {
      expect(resolveConfigPath({})).toBe(join(fixture("root-ts"), "payweave.ts"));
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe("loadConfig (PW-1002 — jiti loading + export contract)", () => {
  it("loads a root payweave.ts that imports payweave, yielding the real client (jiti self-containment)", async () => {
    const cwd = fixture("root-ts");
    const loaded = await loadConfig({ cwd });
    expect(loaded.path).toBe(join(cwd, "payweave.ts"));
    expect(isPayweaveClientLike(loaded.client)).toBe(true);
    expect(loaded.client.providers).toEqual(["paystack"]);
    expect(loaded.client.defaultProvider).toBe("paystack");
    expect(loaded.client.environment).toBe("test");
  });

  it("accepts a named `payweave` export when there is no default export", async () => {
    const cwd = fixture("named-export");
    const loaded = await loadConfig({ cwd });
    expect(loaded.client.providers).toEqual(["paystack"]);
  });

  it("rejects a default export that is not a Payweave client, with an actionable message", async () => {
    const cwd = fixture("wrong-export");
    try {
      await loadConfig({ cwd });
      expect.fail("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayweaveConfigError);
      const message = (err as PayweaveConfigError).message;
      expect(message).toContain(join(cwd, "payweave.ts"));
      expect(message).toContain("does not export a Payweave client");
    }
  });

  it("names a total absence of default/payweave exports distinctly", async () => {
    const cwd = fixture("no-client-export");
    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      message: expect.stringContaining('no "default" or "payweave" export'),
    });
  });

  it("surfaces a PayweaveConfigError thrown by createPayweave(...) verbatim, prefixed with the file path", async () => {
    const cwd = fixture("throws-config-error");
    const path = join(cwd, "payweave.ts");
    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      constructor: PayweaveConfigError,
      message: `${path}: configure at least one provider — e.g. createPayweave({ stripe: { secretKey } })`,
    });
  });

  it("wraps an unrelated thrown error as a generic 'threw while loading' failure", async () => {
    const cwd = fixture("throws-generic-error");
    const path = join(cwd, "payweave.ts");
    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      constructor: PayweaveConfigError,
      message: `${path} threw while loading: boom from throws-generic-error fixture`,
    });
  });

  it("wraps a jiti parse/syntax error with the file path and jiti's own position info", async () => {
    const cwd = fixture("throws-syntax-error");
    const path = join(cwd, "payweave.ts");
    try {
      await loadConfig({ cwd });
      expect.fail("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayweaveConfigError);
      const message = (err as PayweaveConfigError).message;
      expect(message.startsWith(`${path} failed to parse: ParseError`)).toBe(true);
      expect(message).toContain(path); // jiti's own message repeats <file>:<line>:<col>
    }
  });

  it("propagates the 'no config found' failure from resolution (no attempt to load anything)", async () => {
    const cwd = fixture("no-config");
    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      constructor: PayweaveConfigError,
      message: expect.stringContaining("no Payweave config found"),
    });
  });

  it("--config loads the named file even when it would not be discovered by default", async () => {
    // named-export/payweave.ts has no discovery ambiguity, but drive it via
    // an explicit --config from an unrelated cwd to prove the override path.
    const target = join(fixture("named-export"), "payweave.ts");
    const loaded = await loadConfig({ cwd: fixture("no-config"), configPath: target });
    expect(loaded.path).toBe(target);
    expect(loaded.client.providers).toEqual(["paystack"]);
  });
});
