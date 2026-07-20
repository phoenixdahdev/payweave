---
"payweave": minor
---

Fix `require("payweave")` failing with `ERR_PACKAGE_PATH_NOT_EXPORTED` from CommonJS consumers.

The package is (and remains) ESM-only — `format: ["esm"]` in `tsup.config.ts` is unchanged, and no `.cjs` build output is added. The problem was narrower: every `package.json#exports` subpath only listed `"types"` and `"import"` conditions, so a `require()` call (which resolves against `["node", "require"]`) matched nothing and failed before Node ever got a chance to load the file — even though `engines.node` (`>=20.19`) was already chosen specifically because that's when `require(esm)` interop became available by default, per the README's own note ("native `require(esm)` interop; no CJS build is shipped").

Each subpath now also declares a `"default"` condition pointing at the *same* existing ESM build output (e.g. `"./dist/index.js"` for `.`), so a `require()` call resolves via that fallback and Node's native `require(esm)` support loads the genuine ES module directly. No new build artifact, no dual-package hazard (there's no module-level singleton state — `createPayweave()` is a pure factory), and `attw --profile esm-only` still passes cleanly (the `node16 (from CJS)` check is explicitly `(ignored)` under that profile, reporting `⚠️ ESM (dynamic import only)` rather than a failure).

Verified with an in-place `require("payweave")` smoke test against the built `dist/` output: `createPayweave`, the returned client, and nested namespaces (e.g. `client.banks.resolveAccount`) all resolve correctly.

Consumers on Node 20.19–22.11 should note `require(esm)` isn't unflagged-by-default on every patch release in that range on every OS — if you hit a `require() of ES Module ... not supported` error instead of a clean load, use `await import("payweave")` (or upgrade to Node 22.12+/23+, where this is unconditionally stable) rather than filing it as a payweave bug.
