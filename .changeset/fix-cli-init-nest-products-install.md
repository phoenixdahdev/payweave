---
"payweave": minor
---

Fix three `payweave init` issues:

- **NestJS was never detected** — `detectFramework` only checked for Next.js/Express/Fastify, so a Nest project silently fell through to the generic `node:http` scaffold. Added detection (checked before Express, since Nest's default HTTP adapter *is* Express) and a NestJS webhook controller template, gated on the `rawBody: true` bootstrap option Nest requires for signature verification.
- **`products.ts` was scaffolded even with no database selected** — plans/features/metered usage all require a database adapter, so a payments-only project (`database: "none"`) got a `products.ts` it had no way to use. It's now only generated when a real database is configured.
- **The dependency was never actually installed** — the wizard wrote `payweave.ts` importing from `"payweave"` but never ensured the target project actually had it as a dependency (`npx payweave init` only downloads the CLI temporarily to run the wizard). It now detects the project's package manager from its lockfile (pnpm/yarn/bun/npm, defaulting to npm) and runs the matching install command after scaffolding. `--no-install` skips this; a failed install warns with the manual command rather than failing the whole run, since the scaffold itself is still correct.
