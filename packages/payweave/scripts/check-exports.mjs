#!/usr/bin/env node
// Asserts the tsup entry map and package.json#exports stay in lockstep (TDD §5.2
// invariant). Every tsup entry key must have a matching exports subpath and vice
// versa. Exits non-zero on drift so CI fails loudly.
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

console.log(`check-exports: OK — ${expectedExports.size} entries aligned with exports.`);
