import { Module } from "@nestjs/common"

import { PayweaveModule } from "../payweave/payweave.module.js"
import { CheckoutController } from "./checkout.controller.js"

@Module({
  imports: [PayweaveModule],
  controllers: [CheckoutController],
})
export class CheckoutModule {}
