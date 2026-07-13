import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// PW-1001 — second build pass for the `payweave` bin (docs/v1/cli.md §7).
//
// Runs AFTER the library pass (`package.json#build`: `tsup && tsup --config
// tsup.cli.config.ts`) and must never clean its output, hence `clean: false`.
// Why a separate pass instead of one more entry in tsup.config.ts:
//   - the CLI inlines its devDependencies (`noExternal`), the library must not;
//   - `splitting: false` yields ONE self-contained dist/cli/index.js — the CLI
//     shares no chunks with library entries (cli.md §7);
//   - bin-only surface: no dts, no exports subpath; `package.json#bin` is the
//     only doorway (scripts/check-exports.mjs asserts that shape).
// `scripts/check-cli-deps.mjs` verifies the built output references nothing
// beyond `node:*` + `zod` + intra-dist/cli relative specifiers.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: false, // the library pass owns dist/ cleaning
  splitting: false, // single file — no shared chunks with library entries
  dts: false, // bin-only: nothing imports "payweave/cli" (cli.md §7)
  sourcemap: false, // keep the published tarball lean; bin has no map consumers
  shims: false,
  treeshake: true,
  // Build-time --version injection (cli.md §8 — dist reads no files at runtime).
  define: {
    __PAYWEAVE_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  // CLI-only devDependencies inlined into the bundle (cli.md §7; TDD §2
  // deviation log). zod stays external — it is the SDK's one runtime dep.
  // `@clack/prompts` (PW-1005, `init`'s wizard) pulls in its own small
  // dependency chain — `@clack/core`, `sisteransi`, and (as of
  // @clack/prompts@1.7.0) `fast-wrap-ansi` -> `fast-string-width` ->
  // `fast-string-truncated-width` — every one pure JS/ESM, no native
  // binaries, verified against the installed tree at build time. `picocolors`
  // is kept in the list even though @clack/prompts@1.7.0 no longer imports it
  // directly (an earlier version did) — harmless if unmatched, and cheap
  // insurance against a future @clack/prompts bump reintroducing it.
  // `jiti` (PW-1002, cli.md §5/§7) — the TS config loader. Matched via
  // `jiti(\/.*)?` because the loader imports the `jiti/static` subpath
  // specifically: it STATICALLY imports jiti's babel transform (instead of
  // jiti's default entry, which lazily `require()`s it relative to jiti's
  // OWN installed location — a path that no longer resolves once jiti is
  // flattened into this single-file bundle), so esbuild can trace and inline
  // the whole transform rather than leaving a runtime file read behind.
  noExternal: [
    /^mri$/,
    /^@clack\//,
    /^picocolors$/,
    /^sisteransi$/,
    /^fast-wrap-ansi$/,
    /^fast-string-width$/,
    /^fast-string-truncated-width$/,
    /^jiti(\/.*)?$/,
  ],
  external: ["zod"],
  // jiti's bundled transform (`jiti/static`) is itself a webpack-built CJS
  // bundle full of nested `require("<node builtin>")` calls (e.g. "os",
  // "path" without a `node:` prefix). esbuild's default ESM interop for
  // those falls back to a stub that throws "Dynamic require ... is not
  // supported" because no real `require` exists at the top of an ESM module.
  // This banner defines one via `createRequire(import.meta.url)` before any
  // bundled code runs, so those nested requires resolve to Node's real
  // builtins at runtime — verified against dist/cli/index.js (PW-1002).
  banner: {
    js: "import { createRequire as __payweaveCreateRequire } from 'node:module'; const require = __payweaveCreateRequire(import.meta.url);",
  },
});
