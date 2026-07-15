import { Module } from "@nestjs/common"

import { CheckoutModule } from "./checkout/checkout.module.js"
import { PayweaveModule } from "./payweave/payweave.module.js"
import { WebhooksModule } from "./webhooks/webhooks.module.js"

@Module({
  imports: [PayweaveModule, CheckoutModule, WebhooksModule],
})
export class AppModule {}
