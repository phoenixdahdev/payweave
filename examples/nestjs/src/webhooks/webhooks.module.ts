import { Module } from "@nestjs/common"

import { PayweaveModule } from "../payweave/payweave.module.js"
import { WebhooksController } from "./webhooks.controller.js"

@Module({
  imports: [PayweaveModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
