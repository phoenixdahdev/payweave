#!/usr/bin/env node
// Keeps `src/core/version.ts`'s SDK_VERSION in sync with package.json#version.
// Run automatically as part of the root "version" script, right after
// `changeset version` bumps package.json — SDK_VERSION is the literal value
// shipped in the User-Agent header and the public `VERSION` export, so it
// can never drift from the package's real version.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const versionPath = fileURLToPath(new URL("../src/core/version.ts", import.meta.url));

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const contents = `/** Single source of truth for the SDK version (mirrors package.json#version). */\nexport const SDK_VERSION = "${version}";\n`;

writeFileSync(versionPath, contents);
console.log(`synced SDK_VERSION -> ${version}`);
