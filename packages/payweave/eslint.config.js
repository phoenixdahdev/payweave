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
    ignores: ["dist/**", "coverage/**", ".turbo/**", ".tsup/**"],
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
    },
  },
];
