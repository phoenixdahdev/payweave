# payweave

> **One SDK, every provider — woven together.**

A unified, fully-typed TypeScript SDK for **Stripe**, **Paystack**, and **Flutterwave**,
with a database layer, plans/features, metered usage, and a CLI built in. One config,
one client, full endpoint coverage, and webhook verification done correctly out of the box.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)
![Module: ESM only](https://img.shields.io/badge/module-ESM--only-f7df1e.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520.19-339933.svg)

> **Status:** pre-release.

---

## Why Payweave

- **One config, any provider.** Pass the provider(s) you want as keys on the config object and get a fully-typed client back.
- **Compile-time provider narrowing.** Namespaces exist only for the providers you configured — enforced by the type system.
- **Two surfaces, no lock-in.** Provider-native calls when you want full control; a normalized unified layer when you want portability. Every response carries `raw`, so the abstraction never traps you.
- **Webhooks as a first-class, security-critical citizen.** Correct signature scheme per provider, raw-body verification, constant-time comparison, fail-closed, auto-detected across every configured provider.
- **Money that can't drift.** Always integer minor units in the unified layer; the adapters convert so you never fat-finger a decimal.
- **Typed errors that tell you whose fault it is** — yours (validation/auth), the customer's (declined), or transient (network/5xx).
- **Billing built in, optional.** Plans, features, metered usage, and a database layer (SQLite, Postgres, MySQL, MongoDB, Drizzle, Prisma) for when you need more than a payment call.
- **Tiny footprint.** ESM-only, `zod` as the *only* runtime dependency, Node ≥ 20.19.

## Install

```bash
npm install payweave
# or: pnpm add payweave / yarn add payweave / bun add payweave
```

> ESM-only. Requires Node ≥ 20.19 (native `require(esm)` interop); no CJS build is shipped.

## Quickstart

### 1. Initialize — providers are config keys, narrowed at compile time

```ts
import { createPayweave } from "payweave";

const payweave = createPayweave({
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY! },
  flutterwave: { secretKey: process.env.FLW_SECRET_KEY! }, // v3 by default
  defaultProvider: "paystack",
});

payweave.providers;       // ["paystack", "flutterwave"]
payweave.environment;     // "test" | "live" — inferred from the key prefixes
// payweave.stripe;       // ❌ compile-time error: not configured
```

Test vs live is a **config change, not a code change** — it's inferred from the key prefix
(`sk_test_` / `sk_live_` for Paystack, `FLWSECK_TEST-` / `FLWSECK-` for Flutterwave v3,
`sk_test_` / `sk_live_` for Stripe).

### 2. Surface A — provider-native, every endpoint 1:1

```ts
// Paystack — amounts in kobo (its native minor units)
const tx = await payweave.paystack.transactions.initialize({
  email: "ada@example.com",
  amount: 500_000, // ₦5,000
  currency: "NGN",
});
console.log(tx.authorization_url);

// Flutterwave v3 — amounts in naira (its native major units)
const link = await payweave.flutterwave.payments.create({
  tx_ref: "order_8123",
  amount: 5000, // ₦5,000
  currency: "NGN",
  redirect_url: "https://app.example.com/pay/callback",
  customer: { email: "ada@example.com" },
});
```

Pagination endpoints expose an async iterator:

```ts
for await (const t of payweave.paystack.transactions.iterate({ perPage: 100 })) {
  // ...
}
```

### 3. Surface B — the unified layer (portable, always minor units)

```ts
const checkout = await payweave.checkout.create({
  amount: { value: 500_000, currency: "NGN" }, // ALWAYS minor units; the adapter converts
  customer: { email: "ada@example.com" },
  reference: "order_8123",                      // → Paystack `reference` / Flutterwave `tx_ref`
  redirectUrl: "https://app.example.com/pay/callback",
  provider: "flutterwave",                       // optional per-call override of defaultProvider
});
// → { checkoutUrl, reference, providerRef, raw }

const result = await payweave.verify({ reference: "order_8123" });
// → { status: "success" | "failed" | "pending" | "abandoned" | "reversed",
//     amount: { value, currency }, customer, paidAt, channel, raw }

await payweave.banks.list({ country: "NG" });
await payweave.banks.resolveAccount({ accountNumber: "0123456789", bankCode: "058" });
```

`payweave.capabilities()` tells you which unified ops each configured provider supports
(e.g. Stripe doesn't support `transfers`/`banks` — calling them throws a typed error
before any request is sent).

### 4. Webhooks — verified, typed, normalized, multi-provider

Verification **must** run on the exact raw bytes — never parse-then-re-stringify. One
handler works for every configured provider — the provider is auto-detected from the
signature header.

```ts
import express from "express";

const app = express();

// Capture the RAW body for the webhook route only.
app.post("/webhooks/payments", express.raw({ type: "*/*" }), (req, res) => {
  let event;
  try {
    event = payweave.webhooks.constructEvent({ rawBody: req.body, headers: req.headers });
  } catch (err) {
    return res.sendStatus(400); // bad signature → PayweaveWebhookVerificationError
  }

  res.sendStatus(200); // ack fast, then process asynchronously

  // event.type        → provider-native name, e.g. "charge.success"
  // event.unifiedType → normalized, e.g. "payment.succeeded"
  // event.dedupeKey   → stable idempotency key (providers redeliver)
  switch (event.unifiedType) {
    case "payment.succeeded":
      // Never grant value from the webhook alone — re-verify first:
      // await payweave.verify({ reference }) and check amount + currency + status.
      break;
  }
});
```

Signature schemes handled for you: Paystack `HMAC-SHA512` (`x-paystack-signature`),
Flutterwave v3 `verif-hash`, Flutterwave v4 `HMAC-SHA256` (`flutterwave-signature`),
Stripe `HMAC-SHA256` (`stripe-signature`). The Flutterwave dashboard **secret hash** is
not your API key — pass it as `webhookSecret`.

## Error handling

Every failure is a typed subclass of `PayweaveError`, so you can branch on cause:

```ts
import {
  PayweaveValidationError, // 400/422 or local Zod validation (your fault)
  PayweaveAuthError,       // 401/403 (bad key)
  PayweaveNotFoundError,   // 404 (unknown reference/recipient)
  PayweaveRateLimitError,  // 429 (exposes retryAfterMs)
  PayweaveProviderError,   // 5xx / provider processing failure
  PayweaveNetworkError,    // timeout/DNS/reset (isRetryable = true)
} from "payweave";

try {
  await payweave.verify({ reference: "unknown" });
} catch (err) {
  if (err instanceof PayweaveNotFoundError) {
    // handle a genuinely missing transaction
  }
}
```

`error.toJSON()` is always safe to log — secret keys, `Authorization`, PANs, CVV and
PINs are redacted. Bare `POST`s are **never** auto-retried (a charge is never silently
re-sent); GETs and idempotency-keyed requests retry with jittered backoff and honor
`Retry-After`.

## Plans, features & metered usage (optional)

Configure a `database` adapter and a `products` array to get subscriptions and usage
tracking without hand-rolling billing state:

```ts
import { createPayweave, feature, plan } from "payweave";
import { sqliteAdapter } from "payweave/db/sqlite";

const payweave = createPayweave({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY! },
  database: sqliteAdapter({ url: "file:./payweave.db" }),
  products: [
    plan("free", { includes: [feature("seats", { type: "boolean" })] }),
    plan("pro", {
      price: { amount: 29, currency: "USD", interval: "month" },
      includes: [
        feature("seats", { type: "boolean" }),
        feature("api-calls", { type: "metered", limit: 10_000, resetInterval: "month" }),
      ],
    }),
  ],
});

await payweave.sync();                                       // push plans/prices to Stripe
await payweave.subscribe({ customerId: "user_1", planId: "pro" });
await payweave.check({ customerId: "user_1", featureId: "api-calls", consume: true });
```

Webhooks keep billing state in sync automatically via `event.apply()` inside
`constructEvent`. See `payweave/products` and `payweave/db/*` for the full surface.

## Testing without the network

```ts
import { signWebhook } from "payweave/testing";

// Produce a validly-signed body+headers pair for your handler tests:
const { rawBody, headers } = signWebhook("paystack", payload, webhookSecret);
```

`payweave/testing` also ships fixture loaders and an MSW server helper so you can test
your integration entirely offline.

## CLI

```bash
npx payweave init     # scaffold a payweave.ts config for your framework
npx payweave push     # run migrations, then sync products/plans to your providers
npx payweave status   # validate config, database connectivity, migration status
npx payweave listen   # relay webhooks to your local dev server
```

## Subpath exports

| Import | Contents |
| --- | --- |
| `payweave` | Facade: `createPayweave`, `feature`, `plan`, error classes |
| `payweave/core` | `HttpClient`, errors, `Money`, config, retry, redaction |
| `payweave/paystack` | Paystack Surface A adapter |
| `payweave/flutterwave` | Flutterwave Surface A adapter (v3 + v4) |
| `payweave/unified` | Normalized cross-provider layer + event/status mappings |
| `payweave/webhooks` | Signature verification + `constructEvent` |
| `payweave/products` | `feature`, `plan`, period math, billing types |
| `payweave/db`, `payweave/db/{sqlite,postgres,mysql,mongodb,drizzle,prisma}` | Database adapters |
| `payweave/testing` | `signWebhook`, fixtures, MSW helpers |
| `payweave/express`, `payweave/next`, `payweave/fastify` | Framework adapters (in progress) |

Every subpath is independently tree-shakeable — importing `payweave/webhooks` in an edge
function does not pull in the resource modules or any database driver.

## Development

This package lives in the Payweave Turborepo. Run everything from the repo root:

```bash
pnpm install
pnpm turbo build --filter=payweave
pnpm --filter payweave test        # vitest + coverage
pnpm --filter payweave test:types  # compile-time type assertions
```

See the root [`AGENTS.md`](../../AGENTS.md) for contribution rules.

## Security

Webhook verification is timing-safe and fails closed. Secrets never appear in logs, errors,
or fixtures. Found a vulnerability? Please disclose it privately rather than opening a public
issue.

## License

[MIT](./LICENSE)
