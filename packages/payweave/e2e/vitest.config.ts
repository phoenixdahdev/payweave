import { defineConfig } from "vitest/config";

/**
 * Vitest project for CONTRACT (e2e) tests (PW-609, docs/v1/providers.md §6 /
 * docs/technical-design.md §13 "Contract (e2e)" row). Separate from the root
 * `vitest.config.ts` on purpose:
 *
 * - Different file convention (`*.e2e.ts`, not `*.test.ts`) so `pnpm turbo
 *   test --filter=payweave` (the normal gate) NEVER picks these up — they
 *   need live provider credentials the local/CI-PR gate must not require.
 * - No coverage collection — contract tests exercise real network calls
 *   against provider test-mode APIs, not `src/` in isolation; TDD §13/§16
 *   excludes e2e from the coverage gate.
 * - A longer default test timeout — real HTTP round trips to `api.stripe.com`
 *   (and, eventually, Paystack/Flutterwave) are slower than MSW-mocked unit
 *   tests and the quickstart chains several sequential calls per spec.
 *
 * Run via `pnpm --filter payweave test:e2e` (AGENTS.md §3). Every spec file
 * under `e2e/` is individually guarded to SKIP (not fail) when its provider's
 * test-secret env var is absent — see `e2e/stripe-quickstart.e2e.ts`'s module
 * doc for the Stripe leg. `.github/workflows/contract.yml` is the only place
 * these normally run for real (nightly + manual dispatch, secrets from repo
 * settings) — this config just needs to exist so the already-correct
 * `package.json#test:e2e` script (`vitest run --config e2e/vitest.config.ts`)
 * has a target; that file was missing entirely before this ticket.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // No `coverage` block — intentionally excluded from the coverage gate.
  },
});
