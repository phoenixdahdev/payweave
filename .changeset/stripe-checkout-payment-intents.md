---
"payweave": minor
---

Stripe Surface A lands its first two resource modules (PW-602): `payweave.stripe.checkout.sessions` (create, retrieve, list/iterate, expire, lineItems/iterateLineItems) and `payweave.stripe.paymentIntents` (create, retrieve, confirm, capture, cancel, list/iterate). Requests are validated with Zod before the form encoder runs and go to the wire as `application/x-www-form-urlencoded` bracket notation; responses are loose bare resources (drift is logged, never thrown). All amounts are integer minor units. Lists paginate with `starting_after`/`has_more` cursor iterators, and `create`/`confirm`/`capture` accept an `idempotencyKey` option wired to Stripe's `Idempotency-Key` header (which also makes those POSTs retry-eligible). `mapHttpError` now understands Stripe's `{ error: { type, code, message } }` envelope, maps 402 card errors to a non-retryable `PayweaveProviderError`, and picks up Stripe's `Request-Id` response header.
