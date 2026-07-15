import { NestFactory } from "@nestjs/core"
import { NestExpressApplication } from "@nestjs/platform-express"

import { AppModule } from "./app.module.js"

async function bootstrap() {
  // `rawBody: true` makes Nest's underlying body-parser capture the exact
  // received bytes globally (via body-parser's own `verify` hook) alongside
  // its normal JSON/urlencoded parsing — see `src/webhooks/webhooks.controller.ts`,
  // which is the only route that needs those raw bytes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true })
  await app.listen(process.env.PORT ?? 3000)
}

bootstrap()
