#!/usr/bin/env node
// Tarball acceptance for the payweave bin (PW-1001; cli.md §9).
//
// Proves the packaging end-to-end on the CURRENT node version:
//   npm pack → install the tarball into a clean fixture project →
//   `npx payweave --help` and `npx payweave --version` both succeed, and the
//   installed package's runtime dependencies are still zod-only.
//
// The Node 20/22/24 matrix lives in .github/workflows/ci.yml (job
// `cli-tarball`), which runs this same script once per node version — the
// script itself is version-agnostic and reports the node it ran under.
//
// Temp dirs are created under the package's own `.tmp/` (never the system
// tmpdir) and removed afterwards, success or failure.
//
// Run after `pnpm build`. Requires registry access (the fixture install
// resolves the `zod` runtime dep).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

function fail(message) {
  console.error(`test-cli-tarball: FAILED — ${message}`);
  process.exit(1);
}

function runCmd(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.error) fail(`could not spawn \`${cmd}\`: ${res.error.message}`);
  return res;
}

if (!existsSync(join(pkgRoot, "dist", "cli", "index.js"))) {
  fail("dist/cli/index.js missing — run `pnpm build` first.");
}

const tmpBase = resolve(pkgRoot, ".tmp");
mkdirSync(tmpBase, { recursive: true });
const tmp = mkdtempSync(join(tmpBase, "tarball-"));

try {
  // 1. npm pack the built package.
  const packRes = runCmd("npm", ["pack", "--json", "--pack-destination", tmp], pkgRoot);
  if (packRes.status !== 0) fail(`npm pack exited ${packRes.status}:\n${packRes.stderr}`);
  const packed = JSON.parse(packRes.stdout);
  const tarball = join(tmp, packed[0].filename);
  if (!existsSync(tarball)) fail(`packed tarball not found at ${tarball}`);

  // 2. Clean fixture project (its own package.json — npm stays out of the
  //    monorepo since the workspace roots declare no npm "workspaces").
  const fixture = join(tmp, "fixture");
  mkdirSync(fixture);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ name: "payweave-tarball-fixture", private: true, type: "module" }, null, 2),
  );

  // 3. Install the tarball (pulls zod from the registry — the one runtime dep).
  const installRes = runCmd(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball],
    fixture,
  );
  if (installRes.status !== 0) fail(`npm install exited ${installRes.status}:\n${installRes.stderr}`);

  // 4. bin resolves (cli.md §9) — npm must have linked node_modules/.bin/payweave.
  if (!existsSync(join(fixture, "node_modules", ".bin", "payweave"))) {
    fail("node_modules/.bin/payweave missing — bin field did not resolve on install.");
  }

  // 5. Runtime dependencies still zod-only (cli.md §9; AGENTS.md golden rule 3).
  const installedPkg = JSON.parse(
    readFileSync(join(fixture, "node_modules", "payweave", "package.json"), "utf8"),
  );
  const deps = Object.keys(installedPkg.dependencies ?? {});
  if (deps.length !== 1 || deps[0] !== "zod") {
    fail(`installed runtime dependencies are not zod-only: [${deps.join(", ")}]`);
  }

  // 6. npx payweave --help from the fixture.
  const helpRes = runCmd("npx", ["payweave", "--help"], fixture);
  if (helpRes.status !== 0) fail(`\`npx payweave --help\` exited ${helpRes.status}:\n${helpRes.stderr}`);
  for (const needle of ["Usage", "payweave <command>", "init", "push", "listen", "status"]) {
    if (!helpRes.stdout.includes(needle)) {
      fail(`--help output is missing "${needle}":\n${helpRes.stdout}`);
    }
  }

  // 7. npx payweave --version — must be the build-time injected version.
  const versionRes = runCmd("npx", ["payweave", "--version"], fixture);
  if (versionRes.status !== 0) {
    fail(`\`npx payweave --version\` exited ${versionRes.status}:\n${versionRes.stderr}`);
  }
  if (versionRes.stdout.trim() !== pkg.version) {
    fail(`--version printed "${versionRes.stdout.trim()}", expected "${pkg.version}".`);
  }

  console.log(
    `test-cli-tarball: OK — ${packed[0].filename} installs clean on node ${process.version}; ` +
      "bin resolves, --help and --version work, runtime deps zod-only.",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
  try {
    rmdirSync(tmpBase); // only succeeds when empty — leave concurrent users alone
  } catch {
    /* other .tmp users still active */
  }
}
