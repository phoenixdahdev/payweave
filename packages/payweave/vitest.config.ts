import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      exclude: ["src/**/index.ts", "**/*.d.ts"],
      // TDD §9 coverage gates: 90% on core + webhooks, 80% overall. Branch
      // thresholds are lower than line/statement because Surface A adapters
      // carry many provider error branches exercised only in contract tests.
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 75,
        "src/core/**": { statements: 90, lines: 90 },
        "src/webhooks/**": { statements: 90, lines: 90 },
      },
    },
    typecheck: {
      tsconfig: "./tsconfig.json",
      include: ["test/**/*.test-d.ts"],
    },
  },
});
