# payweave

> One SDK, every provider, woven together.

Unified TypeScript SDK for **Paystack** and **Flutterwave** (v3 default, v4 opt-in) —
typed endpoint coverage, first-class webhooks, test + live environments. ESM-only,
Node ≥ 20.19, `zod` as the only runtime dependency.

> **Status:** `0.0.0` scaffold. The public API (`PaymentSDK`, `createPaystack`,
> `createFlutterwave`) is under construction — see `docs/backlog.md`.

## Install

```bash
npm install payweave
```

> ESM-only. Requires Node ≥ 20.19 (native `require(esm)` interop); no CJS build is shipped.

## Quickstart

```ts
import { VERSION } from "payweave";

console.log(VERSION); // "0.0.0"
```

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
