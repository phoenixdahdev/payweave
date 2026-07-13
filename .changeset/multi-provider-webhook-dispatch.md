---
"payweave": minor
---

Multi-provider webhook header dispatch for `createPayweave` clients (PW-503, unified-config.md §5).

`payweave.webhooks` (`verify` / `verifyOrThrow` / `constructEvent`) now works for ANY set of configured providers: the provider is detected from the signature header NAME only (never the body), case-insensitively, then dispatched to that provider's existing timing-safe verifier — `x-paystack-signature` → paystack, `verif-hash` → flutterwave v3, `flutterwave-signature` → flutterwave v4, `stripe-signature` → stripe.

- Fail-closed rejections, all `PayweaveWebhookVerificationError`, never falling through to another provider's verifier: a header for an unconfigured provider; more than one known signature header on one request (ambiguous/likely forged — rejected even if one signature would verify); no known header at all; a Flutterwave header for the wrong configured `version` (a client verifies only with its own version's scheme).
- Stripe webhooks verify via `verifyStripe` keyed with the stripe key's `webhookSecret` (`whsec_*`); a stripe-configured client without `webhookSecret` throws `PayweaveConfigError` at verify time (fail closed — the API secret key is never a fallback HMAC key). `verifyStripe` is now also re-exported from `payweave/webhooks`.
- Stripe events flow through `constructEvent` with `event.provider: "stripe"`, the native `type` preserved, `unifiedType: "unknown"` (the stripe mapping tables land with PW-607), and `dedupeKey` = the Stripe event id (`evt_*`).
- `WebhookEvent.provider` widens (additively) to the new `WebhookProvider` type (`"paystack" | "flutterwave" | "stripe"`).
- Single-provider `createPayweave` clients keep byte-identical behavior for their own provider's header; the §5 rejection rules simply also apply (e.g. a request with no known signature header now throws instead of returning `false`). The legacy `createPaystack` / `createFlutterwave` / `PaymentSDK` webhooks namespaces are untouched.
