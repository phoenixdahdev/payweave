---
"payweave": minor
---

Stripe groundwork (PW-601): complete `StripeProviderConfig` (adds Connect `accountId`; env inference for `sk_`/`rk_` prefixes landed in PW-501), pin `Stripe-Version` via the new `STRIPE_API_VERSION` constant (`2026-06-24.dahlia`), and add a `bodyEncoder` hook to `HttpClientOptions` (JSON default, byte-identical; encoded once per request so retries re-send identical bytes). New `src/stripe/` pieces: `encodeStripeForm` — a deterministic `application/x-www-form-urlencoded` serializer with Stripe bracket notation (insertion-order keys, indexed arrays, null/undefined omitted) — plus `stripeAuth`/`stripeHttpOptions` so the PW-602 Stripe client sends `Authorization: Bearer`, `Stripe-Version`, optional `Stripe-Account`, and form-encoded bodies — no JSON body ever leaves the Stripe client.
