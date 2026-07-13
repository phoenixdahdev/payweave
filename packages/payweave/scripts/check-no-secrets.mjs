#!/usr/bin/env node
// Secret-regex CI gate (PW-609; AGENTS.md §2.5, docs/v1/implementation/briefs
// /epic-06-stripe.md). Hard-fails the build if a REAL-shaped secret has been
// committed anywhere in the repo: a live Stripe key, a test-mode Stripe key,
// a Stripe webhook signing secret, a Flutterwave secret key, or a raw
// `Authorization:` header value. AGENTS.md §2 rule 5 names this gate as
// `sk_live`, `sk_test`, `FLWSECK`, `Authorization:` — read literally that
// would fail on every PROSE mention of those words (this file's own doc
// comment, AGENTS.md itself, provider docs, JSDoc, changelog entries — see
// the tuning note below), so this script implements the INTENT: a
// key-SHAPED value, not the bare category name.
//
// ## Tuning (documented per the ticket's instruction — don't just add
// patterns, explain why each one is shaped the way it is)
//
// Every pattern below requires the "real key" part — a long run of
// characters immediately after the provider's own prefix/marker — before it
// counts as a hit. This is deliberate: the codebase is FULL of legitimate,
// committed strings that merely LOOK like the category name:
//
//   - Prose: AGENTS.md, the epic briefs, and provider-reference.md all write
//     out `sk_live`, `sk_test`, `FLWSECK`, `Authorization:` as plain words
//     describing the gate itself or the auth scheme — no key material
//     follows.
//   - Test placeholders: dozens of unit tests construct a client with
//     `secretKey: "sk_test_root_ts"`, `"FLWSECK_TEST-harness"`,
//     `"sk_test_stripe_dispatch"`, etc. — descriptive, human-readable,
//     deliberately fake. These stay SHORT and word-separated (underscores/
//     hyphens breaking up the "random" part) because nobody hand-writes a
//     32-character random-looking suffix for a test fixture name.
//   - `redact()`'s OWN unit tests (test/core/redact.test.ts) intentionally
//     contain secret-shaped strings (`"sk_live_abcdef123456"`,
//     `"Authorization: Bearer sk_live_zzz"`) to prove the redaction logic
//     scrubs them — by design, these must look enough like a secret to be a
//     meaningful test, while staying short/fake.
//
// A REAL Stripe secret/restricted key or webhook secret is a long run of
// alphanumeric characters with no human word-separators — high entropy,
// unbroken. Requiring 20+ CONTIGUOUS alphanumeric characters right after the
// prefix catches that shape while passing every placeholder above (verified
// against the current tree — see the ALLOWLIST note below for the one
// pre-existing exception). Flutterwave's `FLWSECK` keys additionally allow a
// literal `-` before the random blob (`FLWSECK-` / `FLWSECK_TEST-`) — the
// 20+ threshold is anchored to what follows THAT hyphen, not the whole
// string, so `FLWSECK_TEST-harness` (7 chars after the hyphen) stays clear
// while `FLWSECK_TEST-<32 hex chars>` would not.
//
// `Authorization:` is treated the same way: a hit requires an actual
// `Bearer`/`Basic` VALUE of real-key length after it, not just the header
// name appearing in a comment, JSDoc, or docs table.
//
// ## Allowlist
// A tiny, exact-value allowlist (never a path-based exclusion — a real
// secret landing in the same file would still be caught) for pre-existing,
// reviewed, intentionally-secret-shaped test fixtures that happen to clear
// the 20-char bar. Every entry below MUST carry a justification. Anything
// not an exact match to an allowlisted string is a hit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/payweave/scripts -> packages/payweave -> packages -> repo root.
const repoRoot = resolve(here, "..", "..", "..");

/** @type {{ name: string, pattern: RegExp }[]} */
const PATTERNS = [
  {
    name: "Stripe live secret/restricted key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "Stripe test secret/restricted key",
    pattern: /\b(?:sk|rk)_test_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "Stripe webhook signing secret",
    pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "Flutterwave secret key",
    pattern: /\bFLWSECK[A-Za-z0-9_]*-[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "raw Authorization header value",
    pattern: /authorization:\s*(?:bearer|basic)\s+[A-Za-z0-9._-]{20,}/gi,
  },
];

// Exact matched substrings that are known-safe: reviewed, intentionally
// secret-shaped test fixtures, not real credentials. Keyed by the EXACT text
// the pattern matched (not by file), so a genuine leak elsewhere — even in
// the same file — is still caught.
const ALLOWLIST = new Map([
  [
    "sk_test_51ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    "test/cli/status.test.ts — asserts `payweave status` redacts a key LEAKED " +
      "back in a mocked 401 error body. Sequential alphabet + ascending digits " +
      "(not random entropy), never sent over the network, predates this gate.",
  ],
]);

// File extensions not worth scanning as text (binary, or large generated
// artifacts with no realistic path to hand-typed secret material).
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".gz",
  ".map",
]);

function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line.length > 0);
}

function shouldSkip(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SKIP_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** @type {{ file: string, line: number, pattern: string, match: string }[]} */
const findings = [];

for (const relPath of trackedFiles()) {
  if (shouldSkip(relPath)) continue;
  const absPath = resolve(repoRoot, relPath);
  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    continue; // unreadable / binary / deleted-but-still-listed race — skip.
  }
  // Binary files often decode with the Unicode replacement character —
  // cheap heuristic to skip them without a full binary-detection pass.
  if (content.includes("�")) continue;

  const lines = content.split("\n");
  for (const { name, pattern } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line))) {
        const matched = m[0];
        const allowedReason = ALLOWLIST.get(matched);
        if (allowedReason === undefined) {
          findings.push({
            file: relPath,
            line: i + 1,
            pattern: name,
            match: matched,
          });
        }
        // A zero-length match would spin forever — every pattern here always
        // consumes ≥20 chars, but guard defensively anyway.
        if (m[0].length === 0) pattern.lastIndex++;
      }
    }
  }
}

if (findings.length > 0) {
  console.error("check-no-secrets: FAILED — secret-shaped value(s) found in committed files:");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} [${f.pattern}] ${f.match}`);
  }
  console.error("");
  console.error(
    "If this is a genuine credential: rotate it immediately, remove it from history, and " +
      "report as a security incident. If this is a legitimate test placeholder that merely " +
      "clears the length heuristic, add it to the ALLOWLIST in scripts/check-no-secrets.mjs " +
      "with a one-line justification (exact-value match only — never a path-based exclusion).",
  );
  process.exit(1);
}

console.log("check-no-secrets: OK — no secret-shaped values found in committed files.");
