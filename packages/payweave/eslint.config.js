import { config as baseConfig } from "@payweave/eslint-config/base";

/**
 * ESLint flat config for the Payweave SDK package.
 * Extends the shared repo base and adds SDK-specific rules:
 *  - no `any` in src/ (TDD §2 deviation log, §12)
 *  - ban `.js`/`.ts` extensions on relative imports (belt-and-braces with
 *    scripts/check-imports.mjs — extensionless imports are mandatory, TDD §5.3)
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  ...baseConfig,
  {
    // tsup*.config.bundled_*: ephemeral bundle-require temp files created while
    // a parallel `build` task loads tsup.config.ts / tsup.cli.config.ts — they
    // vanish mid-lint and crash ESLint with ENOENT if not ignored.
    // .tmp/: throwaway dirs used by scripts/check-cli-deps.mjs and
    // scripts/test-cli-tarball.mjs (PW-1001).
    // test/fixtures/cli/**: standalone mini "user projects" (PW-1002) loaded
    // at runtime by jiti, never linted as this package's own source — one is
    // deliberately invalid syntax (the jiti parse-error fixture), which would
    // otherwise crash ESLint's parser rather than produce a normal lint error.
    ignores: [
      "dist/**",
      "coverage/**",
      ".turbo/**",
      ".tsup/**",
      ".tmp/**",
      "**/tsup.config.bundled_*",
      "**/tsup.cli.config.bundled_*",
      "test/fixtures/cli/**",
    ],
  },
  {
    // Node build/CI scripts — give them Node globals.
    files: ["scripts/**/*.mjs", "*.config.ts"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
  },
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\.?/.*\\.(js|ts)$",
              message:
                "Use extensionless relative imports (TDD §5.3) — drop the .js/.ts suffix.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // AGENTS.md §6 — the SDK never calls console.*; use the injected logger.
      "no-console": "error",
    },
  },
  {
    // cli.md §7 — the CLI is a terminal program; console output is its job.
    // This exemption is scoped to src/cli/ ONLY.
    files: ["src/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
];
