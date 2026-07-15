# Payweave — Express example

A minimal, working integration of the [`payweave`](https://www.npmjs.com/package/payweave) payments
SDK in a plain Express + TypeScript server, using Paystack as the provider. Clone this folder as a
starting point for your own app.

## What's here

- `src/payweave.ts` — the singleton `payweave` client, configured from env vars.
- `src/server.ts` — the whole app:
  - `GET /` — a landing page with a plain HTML form that starts checkout (no client JS, no view engine).
  - `POST /checkout` — creates a Payweave checkout session for a fixed demo amount and redirects the
    customer to it.
  - `GET /checkout/callback` — where Paystack's `redirectUrl` sends the customer back; verifies the
    payment with `payweave.verify()` and renders a success/failure page.
  - `POST /webhooks` — the Paystack webhook endpoint, parsed with a dedicated `express.raw()` so
    signature verification runs on the exact bytes Paystack sent.

## Setup

1. From the repo root, install dependencies:

   ```bash
   pnpm install
   ```

2. Copy the env file and fill in your Paystack **test** secret key:

   ```bash
   cp examples/express/.env.example examples/express/.env
   ```

   - `PAYSTACK_SECRET_KEY` — Paystack Dashboard → Settings → API Keys & Webhooks.

3. Run the dev server (from the repo root):

   ```bash
   pnpm --filter payweave-example-express dev
   ```

   The app runs at http://localhost:3000.

4. Visit http://localhost:3000, submit the form with an email, and complete checkout with a
   [Paystack test card](https://paystack.com/docs/payments/test-payments) (e.g. `4084 0840 8408 4081`,
   any future expiry, CVV `408`, PIN `0000`, OTP `123456`).

## Testing webhooks locally

Paystack's webhook URL must be publicly reachable — it cannot point at `localhost`, and there's no
dashboard button to fire a one-off test event (unlike some other providers). To see a real webhook
land locally:

1. Start a tunnel to your local server with a tool like [ngrok](https://ngrok.com/):

   ```bash
   ngrok http 3000
   ```

2. In the Paystack Dashboard → Settings → API Keys & Webhooks, set the **test** webhook URL to your
   tunnel's HTTPS URL plus `/webhooks` (e.g. `https://<your-subdomain>.ngrok.app/webhooks`).
3. Complete a checkout in the browser (step 4 above) with a Paystack test card. Paystack will POST a
   real `charge.success` event to your tunnel, which forwards it to `POST /webhooks` on
   `localhost:3000`.

## Adding or swapping providers

Everything provider-specific lives in one place: the `createPayweave({ ... })` config in
`src/payweave.ts`. Swap Paystack for another provider, or add a second one alongside it, by adding
its keys there — the rest of the app (`checkout.create`, `verify`, `webhooks`) is provider-agnostic
and doesn't change.
