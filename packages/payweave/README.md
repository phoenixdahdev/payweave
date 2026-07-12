# payweave

> One SDK, every provider, woven together.

Unified TypeScript SDK for **Paystack** and **Flutterwave** (v3 default, v4 opt-in) —
typed endpoint coverage, first-class webhooks, test + live environments. ESM-only,
Node ≥ 20.19, `zod` as the only runtime dependency.

> **Status:** pre-release. Paystack P0, Flutterwave v3 P0, webhooks, and the
> unified layer are implemented and tested; Flutterwave v4 and the framework
> adapters are in progress — see `docs/backlog.md`.

## Install

```bash
npm install payweave
```

> ESM-only. Requires Node ≥ 20.19 (native `require(esm)` interop); no CJS build is shipped.

## Quickstart

### 1. Initialize — provider is narrowed at compile time

```ts
import { createPaystack, createFlutterwave } from "payweave";

const paystack = createPaystack({ secretKey: process.env.PAYSTACK_SECRET_KEY! });
const flutterwave = createFlutterwave({ secretKey: process.env.FLW_SECRET_KEY! }); // v3 by default

paystack.environment; // "test" | "live" — inferred from the key prefix
// paystack.flutterwave; // ❌ compile-time error: property does not exist
```

### 2. Provider-native (Surface A) — every endpoint, the provider's own fields

```ts
const { authorization_url, reference } = await paystack.paystack.transactions.initialize({
  email: "ada@example.com",
  amount: 500_000, // kobo — Paystack's native minor units
  currency: "NGN",
});
```

### 3. Unified (Surface B) — identical across providers, always minor units

```ts
const sdk = createPaystack({ secretKey: process.env.PAYSTACK_SECRET_KEY! });

const checkout = await sdk.unified.checkout.create({
  amount: { value: 500_000, currency: "NGN" }, // ALWAYS minor units; adapters convert
  customer: { email: "ada@example.com" },
  reference: "order_8123", // → Paystack `reference` / Flutterwave `tx_ref`
  redirectUrl: "https://app.example.com/pay/callback",
});
// { checkoutUrl, reference, providerRef, raw }

const result = await sdk.unified.verify({ reference: "order_8123" });
// { status: "success" | "failed" | "pending" | ..., amount: { value, currency }, customer, raw }
```

### 4. Webhooks — verified, typed, normalized (raw bytes only)

```ts
// Express: capture the RAW body — never re-serialize JSON before verifying.
app.post("/webhooks", express.raw({ type: "*/*" }), (req, res) => {
  const event = sdk.webhooks.constructEvent({ rawBody: req.body, headers: req.headers });
  res.sendStatus(200); // ack fast, then process async
  // event.unifiedType: "payment.succeeded" | ...; event.dedupeKey for idempotency
});
```

> Never give value from a webhook alone — re-`verify({ reference })` and check amount + status.

## Subpath exports

| Import | Contents |
| --- | --- |
| `payweave` | Facade: `PaymentSDK`, `createPaystack`, `createFlutterwave` |
| `payweave/core` | HttpClient, errors, Money, config, retry, redact |
| `payweave/paystack` | Paystack adapter |
| `payweave/flutterwave` | Flutterwave adapter (v3 + v4) |
| `payweave/unified` | Normalized cross-provider layer |
| `payweave/webhooks` | Signature verification + `constructEvent` |
| `payweave/testing` | `signWebhook`, fixtures, MSW helpers |
| `payweave/express`, `payweave/next`, `payweave/fastify` | Framework adapters |

## Development

This package lives in the Payweave Turborepo. Run everything from the repo root:

```bash
pnpm install
pnpm turbo build --filter=payweave
pnpm --filter payweave test
```

See the root `AGENTS.md` and `docs/technical-design.md` for the full contribution rules.

## License

MIT
