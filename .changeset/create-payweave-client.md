---
"payweave": minor
---

Introduce `createPayweave` + `PayweaveClient` — the v1 unified entry point (PW-502).

Providers are now optional top-level config keys (`stripe` / `paystack` / `flutterwave`) instead of separate factories or a `provider` discriminator:

```ts
const payweave = createPayweave({
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY! },
  flutterwave: { secretKey: process.env.FLW_SECRET_KEY! },
  defaultProvider: "paystack",
});

await payweave.checkout.create({ amount: { value: 500_000, currency: "NGN" }, customer: { email } });
await payweave.banks.list({ provider: "flutterwave", country: "NG" }); // per-call override
payweave.paystack.transactions.initialize({ ... });                    // Surface A
```

- Unified ops (Surface B) move to the client **root** and route to `defaultProvider` unless overridden per call; `payweave.unified` remains as a deprecated alias for the same functions until v1.0.0.
- Surface A namespaces exist **only** for configured keys — compile time (conditional types, `const` generic so no `as const` is needed) and runtime. `flutterwave: { version: "v4" }` narrows `payweave.flutterwave` to the v4 surface.
- `defaultProvider` and per-call `provider` overrides are typed to the configured keys only.
- One `HttpClient` per configured provider, constructed up front (no lazy init); root props `providers`, `defaultProvider`, `environment`.
- A configured `stripe` key constructs (new `StripeClient` shell holding its transport); Stripe resources arrive with EPIC 6 and unified calls routed to stripe throw a typed `PayweaveError` until PW-607.
- `payweave.webhooks` binds the existing single-provider verifier namespace when exactly one provider is configured; multi-provider header dispatch lands with PW-503 (until then those calls fail closed with a typed error).
- New exports: `createPayweave`, `PayweaveClient`, `PayweaveClientBase`, `PayweaveUnifiedOps`, `ProviderOverride`, `ConfiguredProvider`, `StripeClient`, `FlutterwaveV3Client`, `FlutterwaveV4Client`, plus the keyed config types (`PayweaveConfig`, `PayweaveProviderKey`, `StripeProviderConfig`, `PaystackProviderConfig`, `FlutterwaveProviderConfig`, `ResolvedPayweaveConfig`, `ResolvedProviderConfig`). Existing factories (`createPaystack`, `createFlutterwave`, `PaymentSDK`) are unchanged.
