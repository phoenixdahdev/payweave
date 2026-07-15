import { Controller, Post, Req, Res, HttpStatus } from "@nestjs/common"
import type { RawBodyRequest } from "@nestjs/common"
import type { Request, Response } from "express"

import { PayweaveService } from "../payweave/payweave.service.js"

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly payweaveService: PayweaveService) {}

  @Post()
  async handle(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    let event
    try {
      event = this.payweaveService.client.webhooks.constructEvent({
        rawBody: req.rawBody!, // Buffer — populated because rawBody:true was set in main.ts
        headers: req.headers,
      })
    } catch {
      // A bad/missing `verif-hash` header throws PayweaveWebhookVerificationError.
      return res.sendStatus(HttpStatus.BAD_REQUEST)
    }

    res.sendStatus(HttpStatus.OK) // ack fast, handle after

    switch (event.unifiedType) {
      case "payment.succeeded":
        // Re-verify via this.payweaveService.client.verify({ reference })
        // before fulfilling — never trust the webhook body alone.
        console.log(`[payweave] payment.succeeded (dedupeKey=${event.dedupeKey})`)
        break
      case "payment.failed":
        console.log(`[payweave] payment.failed (dedupeKey=${event.dedupeKey})`)
        break
      default:
        console.log(`[payweave] unhandled event: ${event.unifiedType}`)
    }
  }
}
