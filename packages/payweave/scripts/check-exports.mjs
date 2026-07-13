#!/usr/bin/env node
// Asserts the tsup entry map and package.json#exports stay in lockstep (TDD §5.2
// invariant). Every tsup entry key must have a matching exports subpath and vice
// versa. Exits non-zero on drift so CI fails loudly.
// PW-1001 carve-out: the CLI is bin-only (cli.md §7) — `cli/index` lives in
// tsup.cli.config.ts, is exposed via package.json#bin, and must appear in
// NEITHER the library entry map NOR the exports map; asserted below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
const tsupSrc = readFileSync(resolve(pkgRoot, "tsup.config.ts"), "utf8");

// Pull entry keys out of the tsup config's `entry: { ... }` block.
const entryBlock = tsupSrc.match(/entry:\s*\{([\s\S]*?)\}/);
if (!entryBlock) {
  console.error("check-exports: could not locate `entry` block in tsup.config.ts");
  process.exit(1);
}
// Strip // line and /* block */ comments first so a commented-out entry
// (e.g. `// "core/index": ...`) isn't counted as an active key.
const entryContent = entryBlock[1].replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
// Match both quoted ("core/index":) and bare-identifier (index:) object keys.
const entryKeys = [
  ...entryContent.matchAll(/(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:/g),
].map((m) => m[1] ?? m[2]);

// Map a tsup entry key to its expected exports subpath:
//   "index"        -> "."
//   "core/index"   -> "./core"
//   "express/index"-> "./express"
const entryKeyToExport = (key) => {
  const base = key.replace(/\/?index$/, "");
  return base === "" ? "." : `./${base}`;
};

const expectedExports = new Set(entryKeys.map(entryKeyToExport));
// package.json#exports minus the static ./package.json passthrough (no build entry).
const actualExports = new Set(
  Object.keys(pkg.exports ?? {}).filter((k) => k !== "./package.json"),
);

const missingInExports = [...expectedExports].filter((k) => !actualExports.has(k));
const missingInEntries = [...actualExports].filter((k) => !expectedExports.has(k));

let ok = true;

// ── bin-only CLI invariants (cli.md §7; PW-1001) ─────────────────────────────
// `cli/index` is exempt from the entry==exports invariant: it is built by a
// SEPARATE tsup pass (tsup.cli.config.ts) and exposed ONLY through
// package.json#bin — never as an exports subpath, never as a library entry.
const binFailures = [];

if (pkg.bin?.payweave !== "./dist/cli/index.js") {
  binFailures.push(
    `package.json#bin.payweave must be "./dist/cli/index.js" (cli.md §7), got: ` +
      JSON.stringify(pkg.bin ?? null),
  );
}
if (actualExports.has("./cli")) {
  binFailures.push(
    'package.json#exports must NOT expose "./cli" — the CLI is bin-only (cli.md §7: ' +
      "unreachable from library imports; the bin field is the only doorway).",
  );
}
if (entryKeys.includes("cli/index")) {
  binFailures.push(
    'tsup.config.ts (library pass) must not contain a "cli/index" entry — the CLI builds in ' +
      "tsup.cli.config.ts so it shares no chunks with library entries (cli.md §7).",
  );
}
const cliTsupSrc = readFileSync(resolve(pkgRoot, "tsup.cli.config.ts"), "utf8");
if (!/["']cli\/index["']\s*:\s*["']src\/cli\/index\.ts["']/.test(cliTsupSrc)) {
  binFailures.push(
    'tsup.cli.config.ts must build entry "cli/index": "src/cli/index.ts" — otherwise the bin ' +
      "target dist/cli/index.js is never produced.",
  );
}

if (binFailures.length) {
  ok = false;
  console.error("check-exports: bin-only CLI invariants violated (cli.md §7):");
  for (const f of binFailures) console.error(`  - ${f}`);
}
if (missingInExports.length) {
  ok = false;
  console.error("check-exports: tsup entries with no matching package.json#exports:");
  for (const k of missingInExports) console.error(`  - ${k}`);
}
if (missingInEntries.length) {
  ok = false;
  console.error("check-exports: package.json#exports with no matching tsup entry:");
  for (const k of missingInEntries) console.error(`  - ${k}`);
}

if (!ok) {
  console.error("\ncheck-exports: FAILED — tsup entry map and exports drifted.");
  process.exit(1);
}

console.log(
  `check-exports: OK — ${expectedExports.size} entries aligned with exports; ` +
    "cli/index is bin-only (bin field set, no ./cli subpath).",
);
