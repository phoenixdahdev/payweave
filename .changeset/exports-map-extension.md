---
"payweave": minor
---

Extend the exports map with the unified-config §8 subpaths (PW-505): `payweave/products` (period math — real, from PW-901), `payweave/db` (the `DatabaseAdapter` contract + row schemas — real, from PW-701), and stub entries for `payweave/db/prisma`, `payweave/db/drizzle`, `payweave/db/postgres`, `payweave/db/mysql`, `payweave/db/sqlite`, `payweave/db/mongodb`, and `payweave/cli`. The db adapter and cli subpaths are placeholders: they resolve and typecheck today, but their factories throw a `PayweaveConfigError` naming the ticket that ships the real implementation (PW-704–709 for the adapters, PW-1001 for the CLI). No new runtime dependencies — drivers arrive later as optional peerDependencies.
