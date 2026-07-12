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
    },
    typecheck: {
      tsconfig: "./tsconfig.json",
      include: ["test/**/*.test-d.ts"],
    },
  },
});
