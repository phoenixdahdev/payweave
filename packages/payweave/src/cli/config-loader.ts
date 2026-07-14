/**
 * CLI config discovery + loader.
 *
 * Resolution order (first hit wins):
 *   1. `--config <path>` — explicit override; a missing path is an error, it
 *      never falls back to discovery.
 *   2. `payweave.ts` OR `payweave.config.ts` at the project root. Exactly one
 *      of the two may exist — both existing at once is ambiguous (no
 *      documented tie-break) and is reported as its own failure mode.
 *   3. `src/payweave.ts`.
 *
 * The resolved file is loaded with **jiti** (`jiti/static` — the bundler-safe
 * entry that STATICALLY imports its babel transform so tsup's `noExternal`
 * bundling inlines the whole transform into `dist/cli` — no
 * `esbuild`/`typescript`/`tsx` may be assumed present in the user's
 * project). Its default export, or a named `payweave`
 * export, must be the client returned by `createPayweave(...)`.
 *
 * Export-shape detection is structural, not `instanceof`: the config file
 * resolves its OWN copy of the `payweave` package from the user's project
 * `node_modules`, which — once this loader ships inside the bundled
 * `dist/cli/index.js` — is a different module instantiation than
 * anything this file could statically import, so class identity is not
 * guaranteed to line up (the classic dual-package hazard). `src/index.ts` is
 * out of scope here, so there is no exported runtime brand to check instead;
 * this duck-types over the always-present `PayweaveClientBase` members. The
 * same reasoning applies to recognizing a `PayweaveError` thrown out of the
 * user's `createPayweave(...)` call: matched by `.name`, never `instanceof`.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createJiti } from "jiti/static";

import { PayweaveConfigError } from "../core/errors";

/** Root-level candidate filenames, checked in this order. */
const ROOT_CANDIDATES = ["payweave.ts", "payweave.config.ts"] as const;
/** `src/` fallback. */
const SRC_CANDIDATE = "src/payweave.ts";

/** Options for {@link resolveConfigPath} / {@link loadConfig}. */
export interface LoadConfigOptions {
  /** `--config <path>` as typed by the user; bypasses discovery entirely. */
  configPath?: string | undefined;
  /** Project root to search from. Defaults to `process.cwd()`. */
  cwd?: string | undefined;
}

/**
 * Minimal structural shape of a `PayweaveClient` — the
 * always-present root members, regardless of which providers are configured.
 * Used to recognize a loaded module's export as a real client; see the module
 * doc comment for why this is duck-typed rather than `instanceof`-checked.
 */
export interface PayweaveClientLike {
  readonly providers: readonly string[];
  readonly defaultProvider: string;
  readonly environment: "test" | "live";
  readonly webhooks: {
    readonly verify: (...args: never[]) => unknown;
    readonly verifyOrThrow: (...args: never[]) => unknown;
    readonly constructEvent: (...args: never[]) => unknown;
  };
  readonly capabilities: (...args: never[]) => unknown;
}

/** What {@link loadConfig} hands back to command implementations. */
export interface LoadedConfig {
  /** Absolute path to the config file that was loaded. */
  readonly path: string;
  /** The `createPayweave` client extracted from the module's export. */
  readonly client: PayweaveClientLike;
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/**
 * Structural check for a `PayweaveClient`: the root
 * props + namespaces every client has regardless of configured providers.
 * Deliberately NOT `instanceof` — see the module doc comment.
 */
export function isPayweaveClientLike(value: unknown): value is PayweaveClientLike {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.providers)) return false;
  if (typeof v.defaultProvider !== "string") return false;
  if (v.environment !== "test" && v.environment !== "live") return false;
  if (!isFunction(v.capabilities)) return false;
  const webhooks = v.webhooks;
  if (webhooks === null || typeof webhooks !== "object") return false;
  const wh = webhooks as Record<string, unknown>;
  return isFunction(wh.verify) && isFunction(wh.verifyOrThrow) && isFunction(wh.constructEvent);
}

interface Candidate {
  /** Human-readable label used in error messages (relative to the root). */
  readonly label: string;
  /** Absolute path. */
  readonly path: string;
}

function rootCandidates(cwd: string): Candidate[] {
  return ROOT_CANDIDATES.map((name) => ({ label: name, path: join(cwd, name) }));
}

function srcCandidate(cwd: string): Candidate {
  return { label: SRC_CANDIDATE, path: join(cwd, SRC_CANDIDATE) };
}

/**
 * Resolve the config file path, WITHOUT loading it. Exported
 * separately from {@link loadConfig} so callers (and tests) can distinguish
 * "which file would be used" from "load and construct the client" — the
 * latter executes arbitrary user code (`createPayweave(...)` side effects).
 *
 * Throws {@link PayweaveConfigError} for every failure mode:
 * `--config` naming a nonexistent path, both root candidates present at once
 * (ambiguous), or nothing found anywhere (message lists every searched path,
 * in order).
 */
export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();

  if (options.configPath !== undefined) {
    const resolved = isAbsolute(options.configPath)
      ? options.configPath
      : join(cwd, options.configPath);
    if (!existsSync(resolved)) {
      throw new PayweaveConfigError(
        `--config ${options.configPath} does not exist (resolved to ${resolved}). Pass a path to an ` +
          "existing Payweave config file, or omit --config to use discovery (payweave.ts / " +
          "payweave.config.ts at the project root, then src/payweave.ts).",
      );
    }
    return resolved;
  }

  const root = rootCandidates(cwd);
  const rootHits = root.filter((c) => existsSync(c.path));

  if (rootHits.length > 1) {
    throw new PayweaveConfigError(
      "multiple Payweave config files found at the project root: " +
        `${rootHits.map((c) => c.label).join(", ")}. Only one of ` +
        "payweave.ts / payweave.config.ts may exist — keep only one, or pass --config <path> to disambiguate.",
    );
  }
  const rootHit = rootHits[0];
  if (rootHit !== undefined) {
    return rootHit.path;
  }

  const src = srcCandidate(cwd);
  if (existsSync(src.path)) {
    return src.path;
  }

  const searched = [...root, src];
  throw new PayweaveConfigError(
    "no Payweave config found. Searched, in order:\n" +
      searched.map((c) => `  - ${c.path}`).join("\n") +
      "\nCreate one of these files (export the result of createPayweave(...) " +
      'as the default export or a named "payweave" export), or pass --config <path>.',
  );
}

/** True when `err` looks like a `{ name, message }` error object. */
function isNamedError(err: unknown): err is { name: string; message: string; stack?: string } {
  return (
    err !== null &&
    typeof err === "object" &&
    typeof (err as Record<string, unknown>).name === "string" &&
    typeof (err as Record<string, unknown>).message === "string"
  );
}

/**
 * Turn whatever `jiti.import()` threw into an actionable, distinct
 * {@link PayweaveConfigError}:
 *
 * - A `Payweave*Error` thrown while the config file ran `createPayweave(...)`
 *   (construction-time validation) is a CONFIG problem,
 *   not a loader problem — its message is surfaced verbatim, prefixed with
 *   the file path. Matched by `.name` (see module doc comment), never
 *   `instanceof`.
 * - A parse/syntax error is jiti's transform failing on malformed TS/JS.
 *   Empirically (jiti 2.7.0), these surface as a plain `Error` whose message
 *   is prefixed `"ParseError: ..."` and already carries jiti's own
 *   `<file>:<line>:<col>` position info — not a real `SyntaxError` instance,
 *   so this is matched on the message prefix, not `instanceof SyntaxError`.
 * - Anything else that threw during evaluation (e.g. a bug in the config
 *   file unrelated to Payweave) is reported as a generic "threw while
 *   loading" error with the upstream message — never a raw stack dump by
 *   default.
 */
function wrapLoadError(path: string, err: unknown): PayweaveConfigError {
  if (isNamedError(err) && err.name.startsWith("Payweave")) {
    return new PayweaveConfigError(`${path}: ${err.message}`, { cause: err });
  }
  if (isNamedError(err) && err.message.startsWith("ParseError")) {
    return new PayweaveConfigError(`${path} failed to parse: ${err.message}`, { cause: err });
  }
  if (err instanceof Error) {
    return new PayweaveConfigError(`${path} threw while loading: ${err.message}`, { cause: err });
  }
  return new PayweaveConfigError(`${path} threw a non-Error value while loading: ${String(err)}`);
}

/** Describe what a module DID export, for the "wrong export shape" message. */
function describeExportShape(mod: Record<string, unknown>): string {
  const hasDefault = Object.prototype.hasOwnProperty.call(mod, "default");
  const hasNamed = Object.prototype.hasOwnProperty.call(mod, "payweave");
  if (!hasDefault && !hasNamed) {
    const keys = Object.keys(mod);
    return `no "default" or "payweave" export (module exports: ${keys.length > 0 ? keys.join(", ") : "none"})`;
  }
  const value = hasDefault ? mod.default : mod.payweave;
  if (value === undefined) return "the export is undefined";
  if (value === null) return "the export is null";
  if (Array.isArray(value)) return "the export is an array";
  return `the export is a ${typeof value}, not a createPayweave() client`;
}

/**
 * Resolve + load the user's Payweave config, returning the file
 * path actually used and the extracted client (export contract:
 * default export, falling back to a named `payweave` export).
 *
 * Loading is import-with-side-effects: the config file's own top-level code
 * runs, including its `createPayweave(...)` call. The `payweave` package it
 * imports resolves via ordinary Node module resolution rooted at the config
 * file's own location — i.e. the version installed in the USER's project,
 * never this loader's own (bundled) copy.
 *
 * Every failure mode throws {@link PayweaveConfigError}: not found (message
 * lists searched paths), found but wrong export shape, the file threw while
 * loading (config construction error surfaced verbatim, or a generic
 * message for unrelated errors), or a parse/syntax error from jiti.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const path = resolveConfigPath(options);
  const fileUrl = pathToFileURL(path).href;

  // A fresh Jiti instance per load: `id` anchors relative resolution (so a
  // bare `import "payweave"` inside the config resolves from the config
  // file's own directory, walking up ITS node_modules — never this loader's
  // bundled copy) and `moduleCache: false` means re-loading the same path
  // within one process (tests reusing a fixture) re-evaluates rather than
  // returning a stale result.
  const jiti = createJiti(fileUrl, { moduleCache: false });

  let mod: Record<string, unknown>;
  try {
    mod = (await jiti.import(fileUrl)) as Record<string, unknown>;
  } catch (err) {
    throw wrapLoadError(path, err);
  }

  const exported = Object.prototype.hasOwnProperty.call(mod, "default") ? mod.default : mod.payweave;
  if (!isPayweaveClientLike(exported)) {
    throw new PayweaveConfigError(
      `${path} does not export a Payweave client. Expected a default export or a named "payweave" ` +
        `export that is the return value of createPayweave(...). Found: ` +
        `${describeExportShape(mod)}.`,
    );
  }

  return { path, client: exported };
}
