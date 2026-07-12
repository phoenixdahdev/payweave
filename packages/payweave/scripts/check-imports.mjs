#!/usr/bin/env node
// Enforces extensionless relative imports (TDD §5.3). Fails if any file under
// src/ or test/ has a relative import/export specifier ending in .js or .ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const roots = ["src", "test"];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(full);
  }
  return out;
}

// Matches: from "../foo.js" | from './bar.ts' | import("../x.ts")
// | side-effect import "./foo.ts" (the `import\s+"..."` branch — TDD §5.3).
const badImport = /(?:from\s+|import\s+|import\s*\(\s*)["'](\.[^"']*\.(?:js|ts))["']/g;

const offenders = [];
for (const root of roots) {
  for (const file of walk(resolve(pkgRoot, root))) {
    const src = readFileSync(file, "utf8");
    let m;
    while ((m = badImport.exec(src))) {
      offenders.push({ file: relative(pkgRoot, file), spec: m[1] });
    }
  }
}

if (offenders.length) {
  console.error("check-imports: FAILED — relative imports must be extensionless (TDD §5.3):");
  for (const o of offenders) console.error(`  ${o.file}: "${o.spec}"`);
  process.exit(1);
}

console.log("check-imports: OK — no .js/.ts extensions in relative imports.");
