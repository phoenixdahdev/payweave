---
"payweave": minor
---

Land the `DatabaseAdapter` contract (database.md §3, PW-701): the full adapter interface (customers/plans/subscriptions/balances/webhookEvents/migrations stores + `transaction`), Zod row schemas for every `pw_*` table with `z.infer` row types, and storage constants (`PW_TABLES`, `DEFAULT_STALE_CLAIM_AFTER_MS`, `PW_ACTIVE_SUBSCRIPTION_STATUSES`). The `database` key of the provider-keyed config is now typed and structurally validated as a real `DatabaseAdapter` (the loose `DatabaseAdapterLike` placeholder is gone); `products` without `database` still throws the exact spec message. The `payweave/db` subpath itself ships later (PW-505) — adapters follow in PW-704+.
