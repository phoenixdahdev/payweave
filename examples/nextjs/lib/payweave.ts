import { createPayweave } from "payweave"

/**
 * The Payweave client for this app, configured for Stripe.
 *
 * Every route in this example talks to `payweave`, never to a
 * provider-specific SDK — swapping Stripe for another provider, or adding a
 * second one alongside it, is just adding its keys to this config.
 */
export const payweave = createPayweave({
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  },
})
