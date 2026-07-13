#!/usr/bin/env node
// CLI dep-isolation gate (PW-1001; cli.md §7, TDD §2 deviation log).
//
// The `payweave` bin ships its CLI-only devDependencies INLINED into
// `dist/cli/**` (tsup.cli.config.ts `noExternal`) so `npx payweave <cmd>`
// works in a project with zero devDependencies while the SDK's runtime
// `dependencies` stay zod-only. This script fails CI if any built file under
// dist/cli/ still references something it cannot rely on at runtime:
//
//   allowed  → `node:*` (and bare Node builtin names emitted by bundled CJS
//              deps), `zod` (+ subpaths — the one runtime dep), and relative
//              specifiers that RESOLVE WITHIN dist/cli/ (own chunks only —
//              escaping dist/cli would mean a chunk shared with library
//              entries, forbidden by cli.md §7).
//   rejected → every other bare specifier. `esbuild`/`typescript`/`tsx` get a
//              special callout: they are the jiti-rule enforcement for
//              PW-1002's config loader (cli.md §7 — no compiler may be
//              assumed present in the user's project).
//
// Marker-rot protection: before scanning the real output the script seeds a
// throwaway fixture bundle containing known violations and asserts the
// detector flags every one of them — a detector that stops detecting fails
// the build itself.
//
// Run after `pnpm build` (reads dist/cli).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const cliDistDir = resolve(pkgRoot, "dist", "cli");

const BUILTINS = new Set(builtinModules);
const FORBIDDEN_COMPILERS = /^(?:esbuild|typescript|tsx)(?:\/|$)/;

// Static import/export-from, side-effect import, dynamic import(), require() —
// checked against text immediately BEFORE a string's start (see
// `extractSpecifiers` below, which only ever evaluates this against strings
// it has confirmed are real top-level string tokens, never string CONTENT).
const KEYWORD_TAIL =
  /(?:^|[;\n(){}[\],:=!&|?+\-*%^~<>])\s*(?:import\s*\(\s*|require\s*\(\s*|import\s+(?:[\w$,{}*\s]*?from\s*)?|export\s+[\w$,{}*\s]*?from\s*)$/;

/**
 * PW-1002 finding: once jiti's babel transform is bundled into `dist/cli`,
 * its OWN source contains string/template literals that textually resemble
 * import syntax — e.g. Node's verbatim `ERR_UNSUPPORTED_DIR_IMPORT` message
 * text `"...import '%s' is not supported..."`, and a babel diagnostic's
 * example snippet `` `import { a } from "b" with ...}` ``. A plain regex
 * over raw bundle bytes (the original PW-1001 approach) cannot tell those
 * apart from a real specifier — it has no notion of "already inside a
 * string". This hand-rolled tokenizer walks the file once, tracking
 * string/template/comment/regex-literal boundaries, and only asks "is this
 * import/require/export-from?" about text that sits OUTSIDE any of those
 * (i.e. real code), so content trapped inside a string can never be mistaken
 * for a specifier. It is deliberately NOT a full JS parser — just enough
 * state to stop nested quote characters from corrupting the scan — with the
 * standard "previous significant token" heuristic to tell a regex literal
 * (`/foo/`) apart from division.
 */
function extractSpecifiers(text) {
  const specs = [];
  const n = text.length;
  let i = 0;
  let prevSignificant = ""; // last non-whitespace char outside strings/comments

  function isRegexContext() {
    if (prevSignificant === "") return true;
    return !/[\w$)\]]/.test(prevSignificant); // after identifier/number/)/] => division, else regex
  }

  function skipString(from) {
    // Advances past a string/template literal starting at `from` (which must
    // be a quote char); returns the index just after the matching close
    // quote. Template `${...}` interpolation is tracked via brace depth and
    // may itself contain nested strings/comments, hence the recursion.
    const quote = text[from];
    let j = from + 1;
    while (j < n) {
      const c = text[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (quote === "`" && c === "$" && text[j + 1] === "{") {
        j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const cc = text[j];
          if (cc === "{") {
            depth++;
            j++;
          } else if (cc === "}") {
            depth--;
            j++;
          } else if (cc === '"' || cc === "'" || cc === "`") {
            j = skipString(j);
          } else if (cc === "/" && text[j + 1] === "/") {
            const nl = text.indexOf("\n", j);
            j = nl === -1 ? n : nl;
          } else if (cc === "/" && text[j + 1] === "*") {
            const end = text.indexOf("*/", j + 2);
            j = end === -1 ? n : end + 2;
          } else {
            j++;
          }
        }
        continue;
      }
      if (c === quote) {
        j++;
        break;
      }
      j++;
    }
    return j;
  }

  while (i < n) {
    const ch = text[i];

    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "/" && isRegexContext()) {
      // Best-effort regex-literal skip (character classes `[...]` may
      // contain an unescaped `/`); bails to treating it as division on
      // anything that doesn't look like a well-formed regex literal.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(text[j])) j++;
        i = j;
        prevSignificant = "/";
        continue;
      }
      // Not a regex literal after all — fall through as plain division.
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      const end = skipString(start);
      const before = text.slice(Math.max(0, start - 60), start);
      if (KEYWORD_TAIL.test(before)) {
        specs.push(text.slice(start + 1, end - 1));
      }
      i = end;
      prevSignificant = "s"; // string result counts as an operand
      continue;
    }

    if (!/\s/.test(ch)) prevSignificant = ch;
    i++;
  }

  return specs;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const isAllowedBare = (spec) => {
  if (spec.startsWith("node:")) return true;
  // Bundled CJS deps sometimes emit bare builtin names ("tty", "fs/promises").
  if (BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0])) return true;
  if (spec === "zod" || spec.startsWith("zod/")) return true;
  return false;
};

/** Scan every built file under `dir`; returns human-readable violations. */
function scanCliDist(dir) {
  const violations = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const spec of extractSpecifiers(text)) {
      const at = `${relative(pkgRoot, file)}: "${spec}"`;
      if (spec.startsWith(".")) {
        // Relative chunks are fine ONLY while they stay inside dist/cli —
        // escaping means a chunk shared with library entries (cli.md §7).
        const target = resolve(dirname(file), spec);
        if (!(target === dir || target.startsWith(dir + "/"))) {
          violations.push(`${at} — relative import escapes dist/cli/ (shared chunk with library entries).`);
        }
        continue;
      }
      if (isAllowedBare(spec)) continue;
      if (FORBIDDEN_COMPILERS.test(spec)) {
        violations.push(
          `${at} — compiler loaders are FORBIDDEN in the CLI bundle (cli.md §7 jiti rule: ` +
            "no runtime resolution of esbuild/typescript/tsx).",
        );
        continue;
      }
      violations.push(
        `${at} — bare import survived bundling; CLI deps must be devDependencies inlined via ` +
          "tsup.cli.config.ts noExternal (cli.md §7; only node:* + zod + relative chunks may remain).",
      );
    }
  }
  return violations;
}

// ── self-test: the detector must flag a seeded violation ─────────────────────

function selfTest() {
  const tmpBase = resolve(pkgRoot, ".tmp");
  mkdirSync(tmpBase, { recursive: true });
  const tmp = mkdtempSync(join(tmpBase, "check-cli-deps-selftest-"));
  try {
    const fixture = join(tmp, "cli");
    mkdirSync(fixture, { recursive: true });
    // Clean bundle: everything here is allowed.
    writeFileSync(
      join(fixture, "clean.js"),
      'import { readFileSync } from "node:fs";\nimport os from "os";\nimport { z } from "zod";\n' +
        'import { helper } from "./chunk-OK.js";\nexport { helper };\nconsole.log(readFileSync, os, z);\n',
    );
    writeFileSync(join(fixture, "chunk-OK.js"), "export const helper = 1;\n");
    if (scanCliDist(fixture).length !== 0) {
      return "self-test failed: detector flagged an all-allowed fixture bundle.";
    }
    // Dirty bundle: three distinct violation classes, all must be flagged.
    writeFileSync(
      join(fixture, "dirty.js"),
      'import { build } from "esbuild";\nimport prompts from "@clack/prompts";\n' +
        'import { shared } from "../chunk-LIB.js";\nconsole.log(build, prompts, shared);\n',
    );
    const flagged = scanCliDist(fixture);
    const wants = ['"esbuild"', '"@clack/prompts"', '"../chunk-LIB.js"'];
    const missed = wants.filter((w) => !flagged.some((v) => v.includes(w)));
    if (missed.length > 0) {
      return `self-test failed: detector missed seeded violation(s): ${missed.join(", ")}.`;
    }
    return undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    try {
      rmdirSync(tmpBase); // only succeeds when empty — leave concurrent users alone
    } catch {
      /* other .tmp users still active */
    }
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

const selfTestFailure = selfTest();
if (selfTestFailure) {
  console.error(`check-cli-deps: FAILED — ${selfTestFailure}`);
  process.exit(1);
}

if (!existsSync(join(cliDistDir, "index.js"))) {
  console.error("check-cli-deps: dist/cli/index.js missing — run `pnpm build` first.");
  process.exit(1);
}

const violations = scanCliDist(cliDistDir);
if (violations.length > 0) {
  console.error("check-cli-deps: FAILED — dist/cli is not self-contained (cli.md §7):");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

const files = walk(cliDistDir).map((f) => relative(pkgRoot, f));
console.log(
  `check-cli-deps: OK — self-test passed; ${files.length} file(s) [${files.join(", ")}] ` +
    "reference only node:* builtins, zod, and intra-dist/cli chunks.",
);
