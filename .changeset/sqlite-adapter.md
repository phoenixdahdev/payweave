---
"payweave": minor
---

Land the SQLite/libSQL `DatabaseAdapter` (database.md §4, PW-706) at `payweave/db/sqlite` — the first adapter to turn PW-702's conformance suite green. `sqliteAdapter(...)` accepts `{ url }` (routed by scheme to `better-sqlite3` for `:memory:`/`file:`/bare paths or `@libsql/client` for `libsql://`/`wss://`/`https://`/`http://`), or an already-constructed `better-sqlite3` `Database`/`@libsql/client` `Client` instance. Both drivers are optional peerDependencies (+ devDependencies) — `payweave`'s runtime `dependencies` stay zod-only, and neither driver is imported until the adapter's first query. `balances.consume` and `webhookEvents.claim` are atomic under the §5 concurrency race (N=50 parallel calls, zero lost updates); `migrations.status()`/`apply()` delegate to PW-703's engine. `payweave/db/sqlite` no longer throws the PW-505 placeholder error.
