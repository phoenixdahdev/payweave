---
"payweave": minor
---

Initial Payweave SDK — a unified, fully-typed TypeScript SDK for Paystack and Flutterwave.

- **Two surfaces:** provider-native Surface A (every P0 endpoint, 1:1 with each provider's fields, compile-time narrowed on `provider`) and a normalized Surface B unified layer (`checkout`, `verify`, `refunds`, `transfers`, `banks`) with always-minor-unit Money and a `raw` escape hatch.
- **Paystack P0:** transactions, refunds, customers, transfers (+recipients), verification/misc (banks, resolve account), plans + subscriptions — each with pagination iterators.
- **Flutterwave v3 P0:** payments, transactions, refunds, transfers (+beneficiaries), banks/misc, charges including 3DES card encryption.
- **Webhooks (security-critical):** timing-safe verification for Paystack (HMAC-SHA512), Flutterwave v3 (`verif-hash`) and v4 (HMAC-SHA256), plus `constructEvent` that normalizes to unified event types with dedupe keys.
- **Core:** typed error taxonomy, injectable HTTP client with GET-only-plus-idempotency-key retry, ISO-4217 Money, secret redaction, config env-inference. ESM-only, Node ≥ 20.19, `zod` as the only runtime dependency.
