import { nextJsConfig } from "@payweave/eslint-config/next-js"

/** @type {import("eslint").Linter.Config} */
export default [
  // Never lint generated or build output.
  {
    ignores: [".source/**", ".next/**", "next-env.d.ts"],
  },
  ...nextJsConfig,
  // Pin the React version: eslint-plugin-react's "detect" path is incompatible
  // with ESLint 10 (it calls the removed context.getFilename()), so we set it
  // explicitly to match the installed react.
  {
    settings: {
      react: {
        version: "19.2.7",
      },
    },
  },
]
