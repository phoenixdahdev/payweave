---
"payweave": minor
---

Add the provider-keyed root config schema and resolver (`payweaveConfigSchema`, `resolvePayweaveConfig`) — the groundwork for `createPayweave` (unified-config.md §2, PW-501).

Providers are now optional top-level config keys (`stripe` / `paystack` / `flutterwave`) instead of a `provider` discriminator, with all six §2 resolution rules enforced: strict unknown-key rejection, at-least-one-provider, `defaultProvider` resolution, per-key environment inference (including Stripe `sk_test_`/`sk_live_`/`rk_test_`/`rk_live_` prefixes) with mixed-environment and explicit-environment conflict rejection, `products`-require-`database`, and the Flutterwave `version` discriminator (v3 default / v4 opt-in) kept inside its key. New exports from `payweave/core`: `payweaveConfigSchema`, `resolvePayweaveConfig`, `stripeProviderConfigSchema`, `paystackProviderConfigSchema`, `flutterwaveProviderConfigSchema`, `PAYWEAVE_PROVIDER_KEYS`, `STRIPE_BASE_URL`, and the `PayweaveConfig` / `ResolvedPayweaveConfig` / `ResolvedProviderConfig` / `PayweaveProviderKey` types. The legacy discriminated root (`sdkConfigSchema` / `resolveConfig`) is unchanged and still backs `createPaystack` / `createFlutterwave` / `PaymentSDK` until PW-502/PW-504.
