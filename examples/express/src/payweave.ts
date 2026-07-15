import { createPayweave } from "payweave"

/**
 * The Payweave client for this app, configured for Paystack.
 *
 * Every route in this example talks to `payweave`, never to a
 * provider-specific SDK — swapping Paystack for another provider, or adding a
 * second one alongside it, is just adding its keys to this config.
 *
 * Paystack has no separate webhook-signing secret: its HMAC is keyed off this
 * same `secretKey`, so there's no `webhookSecret` field to set here (unlike
 * Stripe).
 */
export const payweave = createPayweave({
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY!,
  },
})
