#!/usr/bin/env node
// Bundle-isolation gate (PW-505; unified-config.md §7 tree-shaking bullet):
// a stripe-only import must pull no Paystack resource modules.
//
// Two complementary assertions, both anchored on markers that only occur in
// the relevant provider modules (so the check stays meaningful as EPIC 6
// mounts the real stripe resource surface):
//
//  1. DIST CHUNK CONTAINMENT — with tsup `splitting: true`, Paystack resource
//     code (shared by the `.` and `./paystack` entries) must live in its own
//     shared chunks: no built file may contain BOTH stripe markers and
//     Paystack resource markers, and the root entry `dist/index.js` (where the
//     stripe surface is composed) must not inline Paystack resource code.
//     This pins the chunk splitting §7 relies on against regression (e.g.
//     someone flipping `splitting: false` or collapsing the chunk graph).
//
//  2. SOURCE IMPORT-GRAPH CLOSURE — the transitive static (runtime) import
//     chain of every module under `src/stripe/` must never reach a module
//     under `src/paystack/` or `src/flutterwave/`. This is the module-level
//     truth behind "stripe-only pulls no Paystack": the stripe client and its
//     future resources (EPIC 6) may only depend on `core/*`. It is asserted on
//     the source graph because the composition root (`src/index.ts`, which
//     legitimately references every configured provider) shares dist chunk
//     `index.js` with the stripe shell, so chunk granularity cannot express
//     the stripe-only closure.
//
// Marker rot protection: the script FAILS if either marker set matches nothing
// — update the markers rather than letting the check silently pass.
//
// Run after `pnpm build` (the dist half reads build output).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const distDir = resolve(pkgRoot, "dist");
const srcDir = resolve(pkgRoot, "src");

// Strings that appear ONLY in Paystack resource modules (paths/URLs of the
// Paystack API surface — src/paystack/resources/*).
const PAYSTACK_RESOURCE_MARKERS = ["/transaction/initialize", "/transferrecipient"];
// Strings that appear ONLY in stripe modules (the pinned version header from
// src/stripe/http-options.ts and the Surface A shell class from
// src/stripe/client.ts).
const STRIPE_MARKERS = ["Stripe-Version", "StripeClient"];

const failures = [];

// ── helpers ──────────────────────────────────────────────────────────────────

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const rel = (file) => relative(pkgRoot, file);
const containsAny = (text, markers) => markers.some((m) => text.includes(m));

// ── 1. dist chunk containment ────────────────────────────────────────────────

if (!existsSync(resolve(distDir, "index.js"))) {
  console.error("check-bundle-isolation: dist/index.js missing — run `pnpm build` first.");
  process.exit(1);
}

const distFiles = walk(distDir, (f) => f.endsWith(".js"));
const distTexts = new Map(distFiles.map((f) => [f, readFileSync(f, "utf8")]));

const paystackChunks = distFiles.filter((f) => containsAny(distTexts.get(f), PAYSTACK_RESOURCE_MARKERS));
const stripeChunks = distFiles.filter((f) => containsAny(distTexts.get(f), STRIPE_MARKERS));

if (paystackChunks.length === 0) {
  failures.push(
    "no dist file matches the Paystack resource markers — the markers rotted; update " +
      "PAYSTACK_RESOURCE_MARKERS so this check stays meaningful.",
  );
}
if (stripeChunks.length === 0) {
  failures.push(
    "no dist file matches the stripe markers — the markers rotted; update STRIPE_MARKERS " +
      "so this check stays meaningful.",
  );
}

const mixed = stripeChunks.filter((f) => paystackChunks.includes(f));
for (const f of mixed) {
  failures.push(
    `${rel(f)} contains BOTH stripe code and Paystack resource code — provider chunks have ` +
      "collapsed (check `splitting: true` in tsup.config.ts).",
  );
}

const rootEntry = resolve(distDir, "index.js");
if (containsAny(distTexts.get(rootEntry), PAYSTACK_RESOURCE_MARKERS)) {
  failures.push(
    "dist/index.js inlines Paystack resource code — it must only IMPORT the shared paystack " +
      "chunks so consumer bundlers can drop them (unified-config.md §7).",
  );
}

// ── 2. source import-graph closure of src/stripe/** ─────────────────────────

// Match runtime import/export-from statements; type-only ones (`import type` /
// `export type ... from`) are erased by the compiler and carry no bundle
// weight, so they are excluded. Mixed named imports (`import { x, type T }`)
// still count as runtime imports.
const IMPORT_RE =
  /(?:\bimport|\bexport)\s+(type\s)?[\w${},*\s]*?from\s*["'](\.[^"']+)["']|\bimport\s*["'](\.[^"']+)["']|\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

function runtimeImportSpecs(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const typeOnly = m[1] !== undefined;
    const spec = m[2] ?? m[3] ?? m[4];
    if (spec !== undefined && !typeOnly) specs.push(spec);
  }
  return specs;
}

// Extensionless relative specifier (enforced by check-imports) -> source file.
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  failures.push(`${rel(fromFile)}: cannot resolve relative import "${spec}" to a source file.`);
  return undefined;
}

const stripeSrcDir = resolve(srcDir, "stripe");
if (!existsSync(stripeSrcDir)) {
  failures.push("src/stripe/ is gone — re-anchor this check on the stripe modules' new home.");
} else {
  const roots = walk(stripeSrcDir, (f) => f.endsWith(".ts"));
  const closure = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const spec of runtimeImportSpecs(file)) {
      const target = resolveSpec(file, spec);
      if (target !== undefined && !closure.has(target)) {
        closure.add(target);
        queue.push(target);
      }
    }
  }
  const foreign = [...closure].filter((f) => {
    const p = rel(f).replaceAll("\\", "/");
    return p.startsWith("src/paystack/") || p.startsWith("src/flutterwave/");
  });
  for (const f of foreign) {
    failures.push(
      `stripe import chain reaches ${rel(f)} — stripe modules may only depend on core/* ` +
        "(unified-config.md §7: a stripe-only app must not pull Paystack modules).",
    );
  }
  if (roots.length === 0) {
    failures.push("src/stripe/ contains no TypeScript modules — closure check is vacuous.");
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error("check-bundle-isolation: FAILED");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `check-bundle-isolation: OK — paystack resources isolated in ${paystackChunks.length} ` +
    `dedicated chunk(s) [${paystackChunks.map(rel).join(", ")}]; stripe import chain is paystack-free.`,
);
