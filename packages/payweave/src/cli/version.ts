/**
 * Build-time CLI version (cli.md §7/§8 — dist performs no runtime file reads).
 *
 * `tsup.cli.config.ts` injects `__PAYWEAVE_CLI_VERSION__` via esbuild `define`
 * from `package.json#version` at build time, so `dist/cli/index.js` carries the
 * version as a literal. Outside the built bundle (vitest runs the TypeScript
 * source, where no define applies) we fall back to `SDK_VERSION`, the source
 * constant that mirrors `package.json#version`.
 */
import { SDK_VERSION } from "../core/version";

declare const __PAYWEAVE_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __PAYWEAVE_CLI_VERSION__ === "string" ? __PAYWEAVE_CLI_VERSION__ : SDK_VERSION;
