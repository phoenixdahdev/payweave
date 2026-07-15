import { Injectable } from "@nestjs/common"
import { createPayweave } from "payweave"

/**
 * The Payweave client for this app, configured for Flutterwave.
 *
 * Built once, at construction — Nest providers are singletons by default, so
 * this runs exactly once per app instance. Every controller talks to
 * `payweaveService.client`, never to a provider-specific SDK — swapping
 * Flutterwave for another provider, or adding a second one alongside it, is
 * just adding its keys to this config.
 */
@Injectable()
export class PayweaveService {
  readonly client = createPayweave({
    flutterwave: {
      secretKey: process.env.FLW_SECRET_KEY!,
      webhookSecret: process.env.FLW_WEBHOOK_SECRET!,
    },
  })
}
