import { defineConfig } from "tsup";

// Entry keys are the output paths (without extension) under dist/, so each one
// lines up exactly with the package.json "exports" map. `scripts/check-exports.mjs`
// enforces this 1:1 correspondence in CI.
export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "core/index": "src/core/index.ts",
    "paystack/index": "src/paystack/index.ts",
    "flutterwave/index": "src/flutterwave/index.ts",
    "unified/index": "src/unified/index.ts",
    "webhooks/index": "src/webhooks/index.ts",
    "testing/index": "src/testing/index.ts",
    "express/index": "src/adapters/express/index.ts",
    "next/index": "src/adapters/next/index.ts",
    "fastify/index": "src/adapters/fastify/index.ts",
    // PW-505 — unified-config.md §8 additions. `db/*` stubs fill in over
    // PW-703–709 (drivers as optional peerDeps, never deps).
    "products/index": "src/products/index.ts",
    "db/index": "src/db/index.ts",
    "db/prisma/index": "src/db/prisma/index.ts",
    "db/drizzle/index": "src/db/drizzle/index.ts",
    "db/postgres/index": "src/db/postgres/index.ts",
    "db/mysql/index": "src/db/mysql/index.ts",
    "db/sqlite/index": "src/db/sqlite/index.ts",
    "db/mongodb/index": "src/db/mongodb/index.ts",
    // NOTE: the CLI bin is deliberately NOT an entry here. PW-1001 builds it in
    // a separate pass (tsup.cli.config.ts) so `dist/cli` shares no chunks with
    // library entries and can inline its devDeps (cli.md §7 — bin-only).
  },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  experimentalDts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  shims: false,
  treeshake: true,
});
