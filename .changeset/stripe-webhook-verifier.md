---
"payweave": minor
---

Add the Stripe webhook signature verification primitive `verifyStripe` (`src/webhooks/stripe.ts`): HMAC-SHA256 over `` `${t}.${rawBody}` `` keyed with the endpoint signing secret (`whsec_*`), timing-safe comparison of EVERY `v1` candidate (secret-roll window), non-`v1` schemes ignored, ±300s replay tolerance (injectable clock / `toleranceSec` for tests), fail-closed on missing or malformed input. Also extends `payweave/testing`'s `signWebhook` with the `"stripe"` provider (`signWebhook("stripe", payload, secret, { timestamp? })`) to produce valid `stripe-signature` vectors. Dispatcher/`constructEvent` wiring lands separately with PW-503.
