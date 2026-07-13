#!/usr/bin/env node
/**
 * `payweave` bin entry (docs/v1/cli.md §7; PW-1001 — replaces the PW-505
 * throwing stub).
 *
 * Built by the second tsup pass (`tsup.cli.config.ts`) into
 * `dist/cli/index.js` with every CLI-only devDependency inlined
 * (`noExternal`); only `node:*` builtins and `zod` may remain as bare imports
 * — `scripts/check-cli-deps.mjs` enforces that in CI. tsup preserves this
 * shebang from the entry source and marks the output executable;
 * `package.json#bin` points npm/npx at it.
 *
 * Bin-only surface: `./cli` is deliberately NOT an exports subpath
 * (cli.md §7), so this module is unreachable from library imports and shares
 * no chunks with library entries. All logic lives in `./run` so tests can
 * import the dispatcher without executing it.
 */
import { run } from "./run";

// PW-1002 — re-export the config loader from the CLI's own entry. Subcommand
// bodies (PW-1003+) import `./config-loader` directly (each command owns its
// own arg parsing, per `./run`'s dispatch comment) — this line changes no
// dispatch behavior. Its purpose is packaging: tsup/esbuild always retains an
// entry's own exports, so this is what keeps `loadConfig` (and therefore the
// bundled `jiti` transform it pulls in) reachable from `dist/cli/index.js`
// TODAY, rather than only once a command starts calling it — proving the
// jiti self-containment fix (tsup.cli.config.ts's `require` banner) against
// the real build now instead of leaving it for the next ticket to discover.
export { loadConfig, resolveConfigPath } from "./config-loader";
export type { LoadConfigOptions, LoadedConfig, PayweaveClientLike } from "./config-loader";

process.exitCode = await run(process.argv.slice(2));
