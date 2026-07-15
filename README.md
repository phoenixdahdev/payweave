# Payweave

> **One SDK, every provider — woven together.**

Open-source, fully-typed **TypeScript SDK** unifying **Stripe**, **Paystack**, and **Flutterwave** — one client, any provider, with subscriptions, metered usage, a database layer, and a CLI built in.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)
![Module: ESM only](https://img.shields.io/badge/module-ESM--only-f7df1e.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520.19-339933.svg)

> **Status:** pre-release, [`payweave@0.1.0`](https://www.npmjs.com/package/payweave) on npm. Stripe, Paystack, and Flutterwave v3 (provider-native + webhooks), the unified layer, the database layer (sqlite, Postgres, MongoDB, Drizzle), plans/features/metered usage, and the CLI are implemented and tested. Still landing: the MySQL and Prisma database adapters, Flutterwave v4's resource surface, and live provider contract tests.

---

## What's inside

This is a [Turborepo](https://turborepo.com) + [pnpm](https://pnpm.io) monorepo.

```
apps/
  web/                 # payweave.dev — Next.js 16 landing page + Fumadocs /docs
packages/
  payweave/            # ★ THE SDK — the only published package (npm: "payweave")
  ui/                  # @payweave/ui — shared shadcn components for apps/web
  eslint-config/       # @payweave/eslint-config — shared lint config
  typescript-config/   # @payweave/typescript-config — shared tsconfig
```

- **The SDK** lives in [`packages/payweave/`](./packages/payweave) — ESM-only, Node ≥ 20.19, with `zod` as its only runtime dependency. See its [README](./packages/payweave/README.md) for the full API and quickstart.
- **The site** lives in [`apps/web/`](./apps/web) — the payweave.dev marketing page and the Fumadocs-powered documentation ([`apps/web/content/docs`](./apps/web/content/docs)).

## SDK at a glance

```bash
npm install payweave
```

```ts
import { createPayweave } from "payweave";

const payweave = createPayweave({
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY! },
});

// Unified layer — provider-portable, always minor-unit Money:
const checkout = await payweave.checkout.create({
  amount: { value: 500_000, currency: "NGN" },
  customer: { email: "ada@example.com" },
  reference: "order_8123",
  redirectUrl: "https://app.example.com/pay/callback",
});
// → { checkoutUrl, reference, providerRef, raw }
```

Configure Stripe, Paystack, and/or Flutterwave on one client. Highlights: two API surfaces (provider-native **Surface A** + a normalized **unified Surface B**, gated by a capability matrix so you always know what's portable), a database layer backing subscriptions and metered usage (`plan()`/`feature()`, `subscribe()`, `check()`/`report()`), first-class timing-safe webhooks across every configured provider, integer-minor-unit Money, a typed error taxonomy, and a CLI (`payweave init|push|listen|status`). Full details in the [package README](./packages/payweave/README.md) and the docs site.

## Development

Everything runs from the repo root through Turbo:

```bash
pnpm install

# SDK
pnpm turbo build --filter=payweave
pnpm turbo test --filter=payweave          # vitest + coverage
pnpm turbo test:types --filter=payweave    # compile-time type assertions

# Docs site (payweave.dev)
pnpm turbo dev --filter=web                 # local dev server
pnpm turbo build --filter=web
```

Requirements: Node ≥ 20.19, pnpm 10+. Conventional commits; only `payweave` is publishable (via Changesets, released through GitHub Actions with npm trusted publishing — never published from a local machine). See [`AGENTS.md`](./AGENTS.md) for the full contribution rules.

## License

[MIT](./LICENSE). The documentation site's design system is adapted from [EvilCharts](https://github.com/legions-developer/evilcharts) (MIT); see [`apps/web/THIRD-PARTY-NOTICES.md`](./apps/web/THIRD-PARTY-NOTICES.md).
