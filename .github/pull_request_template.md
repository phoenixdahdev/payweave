<!-- PR title MUST carry the ticket ID, e.g. `feat(paystack): transactions [PW-102]` -->

## Ticket

Closes #<!-- issue number --> · PW-<!-- ticket id -->

## What & why

<!-- One paragraph: what this changes and why. Link the provider doc page(s) used. -->

## Endpoint / resource checklist (TDD §9, delete if N/A)

- [ ] Request Zod schema sourced from official docs (parsed before send)
- [ ] Response Zod schema (loose object; unknown fields pass through)
- [ ] JSDoc with docs link + runnable `@example`
- [ ] MSW unit tests: outgoing method/path/headers/body **and** parsed result; ≥1 error path
- [ ] Sanitized fixture committed under `test/fixtures/<provider>/<resource>/`
- [ ] Pagination iterator if the endpoint lists

## Gates

- [ ] `lint typecheck build test test:types` green
- [ ] `check-exports` + `check-imports` pass
- [ ] Extensionless relative imports; no `any` in `src/`
- [ ] `zod` remains the only runtime dependency of `packages/payweave`
- [ ] Changeset added if public API/behavior changed
