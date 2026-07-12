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
