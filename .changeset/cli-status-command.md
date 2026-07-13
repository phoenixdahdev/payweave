---
"payweave": minor
---

`payweave status` (PW-1003): validates your Payweave setup read-only — configuration validity, database connection, migration status (whether `push` is needed), per-provider API connectivity, and config/database/provider sync status (docs/v1/cli.md §4). Optional sections (database/products) are skipped, not failed, when absent — `status` on a payments-only project passes. Every printed message is secret-safe (routed through the SDK's `redact()`); provider/database failures map onto the existing error taxonomy with an actionable fix. Pass `--throw` to exit non-zero on any failed check, for CI use — the default mode is diagnostic only and always exits 0. This replaces the PW-1001 placeholder that unconditionally exited 1 naming this ticket.
