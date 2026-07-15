import { Module } from "@nestjs/common"

import { PayweaveService } from "./payweave.service.js"

/**
 * Exports `PayweaveService` so any feature module (checkout, webhooks, ...)
 * can inject it by adding `PayweaveModule` to its own `imports`. Nest
 * de-duplicates module instances across the graph, so `PayweaveService`
 * stays a single shared singleton no matter how many modules import it.
 */
@Module({
  providers: [PayweaveService],
  exports: [PayweaveService],
})
export class PayweaveModule {}
