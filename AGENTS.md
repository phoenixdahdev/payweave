<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->


---

# AGENTS.md — Payweave Agent Operating Manual

Repo: `https://github.com/phoenixdahdev/payweave` (default branch `main`) — a **Turborepo + pnpm monorepo**; the SDK lives at `packages/payweave/`, the payweave.dev site at `apps/web/`. This file lives at the repo root BELOW the managed `<!-- BEGIN:nextjs-agent-rules -->` block (that block governs `apps/web` Next.js work — obey it there; never edit or remove it). This is the first thing any coding agent reads. The other governing docs live at `docs/prd.md`, `docs/technical-design.md` (TDD), `docs/provider-reference.md`, `docs/backlog.md`, and — for the v1 pivot (unified `createPayweave` config, Stripe, database layer, plans & features, metered usage, CLI) — `docs/v1/` (start at `docs/v1/overview.md`). Post-v1 direction (market research, differentiators, rollout-to-default roadmap, epics PW-12xx+) lives in `docs/strategy/` — strategy docs guide WHAT comes next but never override a v1 spec mid-build. It governs HOW you work; the PRD (`payweave-prd.md`) governs WHAT to build; the Technical Design Doc (`payweave-technical-design.md`, "TDD") governs HOW the system is designed. On conflict: `docs/v1/*` > TDD > PRD > this file > your judgment. If a conflict exists, fix the losing doc in the same PR.

## 1. Project one-liner
Payweave (`npm: payweave`) — open-source TypeScript SDK unifying Paystack and Flutterwave (v3 default + v4 opt-in via `version`), test + live environments, full typed endpoint coverage, first-class webhooks. Turborepo monorepo; the SDK is the workspace package `packages/payweave` (the ONLY published package) with Arcie-standard internals: tsup, ESM-only, Node ≥ 20.19.

## 2. Golden rules (non-negotiable)
1. **Never invent API fields.** Every schema field comes from official docs: Paystack (`paystack.com/docs/api`), Flutterwave (`developer.flutterwave.com` — PIN the version selector to the version you're implementing, v3.0.0 or v4.0.0; use their `llms.txt` / OpenAPI index), or the official Postman collections. Link the doc page in the JSDoc of every method.
2. **Extensionless imports.** `from "../../core/http"` — never `.js`/`.ts`. CI fails otherwise.
3. **`zod` is the only runtime dependency of `packages/payweave`.** Monorepo siblings (`@payweave/ui`, Next.js, icons) must NEVER appear in the SDK's dependencies; shared `@payweave/eslint-config` / `@payweave/typescript-config` are allowed as devDeps only. Adding any other requires a written justification in the PR description and maintainer approval.
4. **Never auto-retry a bare POST.** Charges must never be silently re-sent (TDD §6.2).
5. **Secrets never appear** in code, fixtures, tests, logs, or error output. Run the fixture sanitizer; the CI regex gate (`sk_live`, `sk_test`, `FLWSECK`, `Authorization:`) is a hard fail.
6. **Webhook verification is security-critical.** Raw bytes only, timing-safe comparison, fail closed. Any change to `src/webhooks/` requires the full negative-test suite to pass and a second review.
7. **Money is integer minor units.** No floats, ever (TDD §6.4).
8. **Don't break the exports map.** tsup entry keys == `package.json#exports` keys; `check-exports` + `attw --pack` must pass.
9. **Response schemas log drift, never throw.** Request schemas throw `PayweaveValidationError`.
10. **Public API changes = changeset.** Run `pnpm changeset` in every PR that touches exported types or behavior; classify semver honestly (TDD §14).

## 3. Commands
```bash
pnpm install                                   # from repo root, frozen lockfile in CI
pnpm turbo build --filter=payweave             # build just the SDK (or `pnpm build` for everything)
pnpm turbo test --filter=payweave              # vitest run --coverage (SDK)
pnpm turbo test:types --filter=payweave        # compile-time type tests
pnpm turbo lint typecheck --filter=payweave    # eslint + tsc
pnpm --filter payweave dev                     # tsup --watch inside the package
pnpm --filter payweave test:e2e                # contract tests (needs provider test keys)
pnpm --filter payweave exec node scripts/check-exports.mjs
pnpm turbo dev --filter=web                    # run apps/web (payweave.dev) — obey the nextjs-agent-rules block
```
Turbo caches aggressively — if results look stale, `pnpm turbo build --filter=payweave --force`. Working dir for SDK tasks is `packages/payweave/`; governing docs are at `docs/` from the root.
Env vars for e2e/fixture recording: `PAYSTACK_TEST_SECRET`, `FLW_TEST_SECRET`, `FLW_TEST_ENCRYPTION_KEY`, `FLW_TEST_WEBHOOK_SECRET`, `FLW_V4_CLIENT_ID`, `FLW_V4_CLIENT_SECRET`, `STRIPE_TEST_SECRET` (PW-609 — a `sk_test_`/`rk_test_` key; `e2e/stripe-quickstart.e2e.ts` and `.github/workflows/contract.yml`'s `stripe-quickstart` job both refuse to run against anything else). Never commit them; never print them.

## 4. Workflow per task
0. FIRST RUN ONLY: if ticket PW-000 (repo reconciliation) is open, do it before anything else — the tree must match TDD §3 before feature work starts.
1. Read the ticket in `docs/backlog.md` and its mirrored GitHub Issue on phoenixdahdev/payweave; read the linked provider doc page(s) FIRST.
2. Branch: `feat/<area>-<short>` (e.g. `feat/paystack-transactions`), conventional commits.
3. Implement following the resource template (TDD §9): schema → resource method → JSDoc + docs link + example → MSW unit tests (happy path + ≥1 error path) → fixture(s).
4. Self-check against the **Definition of Done** (§5) and the ticket's acceptance criteria.
5. Run the full local gate: `lint && typecheck && build && test && test:types && check-exports && check-imports`.
6. Open PR against `main` on phoenixdahdev/payweave with the ticket ID in the title (e.g. `feat(paystack): transactions [PW-102]`); fill the endpoint checklist; add a changeset (`pnpm changeset` at root — only `payweave` is versioned); link the issue with `Closes #<n>`.
7. One resource (or one coherent core concern) per PR. Do not batch.

## 5. Definition of Done (per endpoint)
- [ ] Request Zod schema (`z.input` accepted, parsed before send) sourced from official docs
- [ ] Response Zod schema (loose object; unknown fields pass through)
- [ ] Typed method on the resource class; JSDoc with doc link + runnable `@example`
- [ ] Unit tests via MSW: asserts outgoing method/path/headers/body AND parsed result; ≥1 error mapping case
- [ ] Sanitized fixture committed under `test/fixtures/<provider>/<resource>/`
- [ ] Pagination iterator if the endpoint lists
- [ ] Exported from the provider's `index.ts`; docs page stub added under `docs/`
- [ ] Changeset added; all CI gates green

## 6. Code conventions
- TS strict; no `any` in `src/` (Biome errors); `unknown` + narrowing instead.
- Types come from `z.infer` — hand-written interfaces for API shapes are forbidden.
- Files/dirs: kebab-case; classes PascalCase; the brand is `Payweave` in prose, `payweave` in all identifiers.
- Errors: only throw `PayweaveError` subclasses from public methods; map HTTP via `mapHttpError` — never per-resource ad-hoc mapping.
- No `console.*` in `packages/payweave/src/` — use the injected `logger` hook.
- SDK code never imports from `apps/` or `packages/ui`; web-app code consumes the SDK only via `"payweave": "workspace:*"`.
- Comments explain WHY (provider quirks, doc discrepancies), not what. Doc discrepancies also get a GitHub issue labeled `provider-drift`.

## 7. Testing rules
- Mock at the network edge with MSW. Never stub `HttpClient` or `fetch` directly in resource tests.
- Webhook tests must include: valid vector, tampered body, wrong secret, missing header, case-variant header names.
- Use `payweave/testing`'s `signWebhook` — don't hand-roll signatures in tests.
- Fake timers for retry/backoff tests; assert `Retry-After` handling.
- Coverage gates: 90% `src/core` + `src/webhooks`, 80% overall. Don't game coverage with trivial assertions.

## 8. When docs conflict or you're unsure
- Postman vs web docs disagree → web API reference wins; leave a `// NOTE(drift):` comment + issue.
- Provider behavior differs from docs (discovered via contract tests) → match REALITY, document the delta, open issue.
- Genuinely ambiguous product decision → do NOT guess; open a `question` issue referencing PRD section, pick the most conservative implementation, flag it in the PR.

## 9. Things you must never do
- Publish to npm from a local machine (CI-only, provenance).
- Commit `pnpm-lock.yaml` changes unrelated to your ticket.
- Edit `unified/mappings.ts` semantics without a `major`/`minor` changeset discussion — it's a public contract.
- Add CJS output, change `format: ["esm"]`, or re-enable import extensions.
- Log, snapshot, or fixture raw card data (PAN/CVV/PIN) even in test mode.

11. **Version isolation (Flutterwave).** v3 and v4 are separate surfaces under `src/flutterwave/v3|v4` — never share schemas between them without proving the payloads are identical against both doc versions. `version` defaults to `"v3"`; a client verifies webhooks ONLY with its own version's scheme.
