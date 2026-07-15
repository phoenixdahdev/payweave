# Payweave — NestJS example

A minimal, working integration of the [`payweave`](https://www.npmjs.com/package/payweave) payments
SDK in a NestJS app (default Express platform), using Flutterwave (v3) as the provider. Clone this
folder as a starting point for your own app.

## What's here

- `src/payweave/payweave.module.ts` + `src/payweave/payweave.service.ts` — an injectable
  `PayweaveService` that builds the singleton `payweave` client from env vars once, and exports it
  so any other module can inject it.
- `src/checkout/checkout.module.ts` + `src/checkout/checkout.controller.ts`:
  - `GET /` — a landing page with a plain HTML form that starts checkout (no client JS, no view
    engine).
  - `POST /checkout` — creates a Payweave checkout session for a fixed demo amount and redirects
    the customer to it.
  - `GET /checkout/callback` — where Flutterwave's `redirect_url` sends the customer back; verifies
    the payment with `payweave.verify()` and renders a success/failure page.
- `src/webhooks/webhooks.module.ts` + `src/webhooks/webhooks.controller.ts` — the Flutterwave
  webhook endpoint (`POST /webhooks`), verified against the raw request body (see "Raw body for
  webhooks" below).
- `src/app.module.ts` — the root module, wiring `PayweaveModule`, `CheckoutModule`, and
  `WebhooksModule` together.
- `src/main.ts` — bootstraps the app with `rawBody: true` so webhook signature verification can run
  on the exact bytes Flutterwave sent.

## Setup

1. From the repo root, install dependencies:

   ```bash
   pnpm install
   ```

2. Copy the env file and fill in your Flutterwave **test** keys:

   ```bash
   cp examples/nestjs/.env.example examples/nestjs/.env
   ```

   - `FLW_SECRET_KEY` — Flutterwave Dashboard → Settings → API (use the `FLWSECK_TEST-...` key
     while developing).
   - `FLW_WEBHOOK_SECRET` — see "Webhook secret vs. API key" below — this is **not** the same value
     as `FLW_SECRET_KEY`.

3. Run the dev server (from the repo root):

   ```bash
   pnpm --filter payweave-example-nestjs dev
   ```

   The app runs at http://localhost:3000.

4. Visit http://localhost:3000, submit the form with an email, and complete checkout with a
   [Flutterwave test card](https://developer.flutterwave.com/docs/integration-guides/testing-helpers)
   (e.g. `5531 8866 5214 2950`, expiry `09/32`, CVV `564`, PIN `3310`, OTP `12345`).

## Webhook secret vs. API key

Flutterwave webhook (v3) verification does **not** use your API secret key. In your Flutterwave
Dashboard, go to **Settings → Webhooks** and set your own **secret hash** — a value you invent
yourself, not one Flutterwave issues to you. Flutterwave then echoes that exact value back in every
webhook request's `verif-hash` header, and `FLW_WEBHOOK_SECRET` in your `.env` must match it
character-for-character. Verification here is a plain constant-time equality check against that
shared value, not an HMAC signature (Stripe, Paystack, and Flutterwave v4 all differ from v3 in this
respect). So: `FLW_SECRET_KEY` authenticates API calls you make to Flutterwave; `FLW_WEBHOOK_SECRET`
authenticates calls Flutterwave makes back to you — two unrelated values, both required, and easy to
mix up because Flutterwave's dashboard calls the second one a "secret hash" rather than a "webhook
secret."

## Raw body for webhooks

Webhook signature verification must run on the exact bytes Flutterwave sent — never on a re-parsed
or re-stringified body, since that can change byte-for-byte in ways that break the comparison. This
example follows NestJS's documented approach for that:

- `src/main.ts` passes `{ rawBody: true }` to `NestFactory.create`. This makes Nest's underlying
  body-parser capture the raw request bytes globally, via body-parser's own `verify` hook — JSON and
  urlencoded parsing for every other route (like `POST /checkout`) keeps working normally and is
  unaffected.
- `src/webhooks/webhooks.controller.ts` reads those captured bytes back via `req.rawBody` — typed as
  `RawBodyRequest<Request>` from `@nestjs/common` — and passes them straight to
  `payweaveService.client.webhooks.constructEvent(...)`.

## Testing webhooks locally

Flutterwave's webhook URL must be publicly reachable — it cannot point at `localhost`. To see a real
webhook land locally:

1. Start a tunnel to your local server with a tool like [ngrok](https://ngrok.com/):

   ```bash
   ngrok http 3000
   ```

2. In the Flutterwave Dashboard → Settings → Webhooks, set your webhook URL to your tunnel's HTTPS
   URL plus `/webhooks` (e.g. `https://<your-subdomain>.ngrok.app/webhooks`), and set the secret hash
   there to the same value you put in `FLW_WEBHOOK_SECRET`.
3. Complete a checkout in the browser (step 4 above) with a Flutterwave test card. Flutterwave will
   POST a real event to your tunnel, which forwards it to `POST /webhooks` on `localhost:3000`.

## Adding or swapping providers

Everything provider-specific lives in one place: the `createPayweave({ ... })` config in
`src/payweave/payweave.service.ts`. Swap Flutterwave for another provider, or add a second one
alongside it, by adding its keys there — the rest of the app (`checkout.create`, `verify`,
`webhooks`) is provider-agnostic and doesn't change.
