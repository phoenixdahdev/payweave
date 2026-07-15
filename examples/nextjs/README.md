# Payweave — Next.js (App Router) example

A minimal, working integration of the [`payweave`](https://www.npmjs.com/package/payweave) payments
SDK in a Next.js App Router app, using Stripe as the provider. Clone this folder as a starting
point for your own app.

## What's here

- `lib/payweave.ts` — the singleton `payweave` client, configured from env vars.
- `app/page.tsx` — a landing page with a plain HTML form that starts checkout (no client JS).
- `app/api/checkout/route.ts` — creates a Payweave checkout session and redirects the customer
  to it.
- `app/checkout/callback/route.ts` — where the checkout's `redirectUrl` sends the customer back;
  verifies the payment with `payweave.verify()` and redirects to a result page.
- `app/checkout/success/page.tsx`, `app/checkout/failed/page.tsx` — trivial result pages.
- `app/api/webhooks/route.ts` — the Stripe webhook endpoint.

## Setup

1. From the repo root, install dependencies:

   ```bash
   pnpm install
   ```

2. Copy the env file and fill in your Stripe **test** keys:

   ```bash
   cp examples/nextjs/.env.example examples/nextjs/.env.local
   ```

   - `STRIPE_SECRET_KEY` — Stripe Dashboard → Developers → API keys.
   - `STRIPE_WEBHOOK_SECRET` — see step 4 below.

3. Run the dev server (from the repo root):

   ```bash
   pnpm --filter payweave-example-nextjs dev
   ```

   The app runs at http://localhost:3000.

4. In a second terminal, forward Stripe webhooks to your local server with the
   [Stripe CLI](https://docs.stripe.com/stripe-cli):

   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks
   ```

   `stripe listen` prints its own `whsec_...` signing secret — put that in `STRIPE_WEBHOOK_SECRET`
   in `.env.local` (it's different from a dashboard endpoint's secret).

5. Visit http://localhost:3000, submit the form with an email, and complete checkout with a
   [Stripe test card](https://docs.stripe.com/testing) (e.g. `4242 4242 4242 4242`, any future
   expiry, any CVC).

## Adding or swapping providers

Everything provider-specific lives in one place: the `createPayweave({ ... })` config in
`lib/payweave.ts`. Swap Stripe for another provider, or add a second one alongside it, by adding
its keys there — the rest of the app (`checkout.create`, `verify`, `webhooks`) is provider-agnostic
and doesn't change.

## Building for production

`lib/payweave.ts` builds the `payweave` client once, at module load — so `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` must be set wherever you run `next build`, not just at runtime (Next.js
imports every route while collecting page data at build time). Configure both as build-time
environment variables on your host (e.g. a Vercel project's Environment Variables, set for all
environments), or make sure `.env.local` exists locally before running `pnpm build`.
