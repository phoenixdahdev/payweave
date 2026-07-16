/**
 * NestJS scaffold — a self-contained `payweave` feature module (service +
 * webhook controller + module + README), not the generic root-level
 * `payweave.ts` / `lib/payweave-client.ts` files the other frameworks get.
 * Nest's own module system is the idiomatic home for this: `PayweaveService`
 * is a provider any other feature module can inject by adding
 * `PayweaveModule` to its own `imports` — exactly like
 * `examples/nestjs/src/payweave`. `../init.ts`'s `wirePayweaveModule` adds
 * `PayweaveModule` to the detected project's own `AppModule` automatically
 * once these files are written.
 *
 * `products.ts` (when a database is configured) lives INSIDE this same
 * folder rather than at the project root — everything `payweave init`
 * touches for a Nest project stays under one importable, deletable folder.
 */
import type { DatabaseChoice, ScaffoldFile, ScaffoldInput } from "./types";
import { DATABASE_FACTORY, DATABASE_IMPORT, PROVIDER_CONFIG_BLOCK, renderProducts } from "./config";

export const NEST_PAYWEAVE_DIR = "src/payweave";
const SERVICE_PATH = `${NEST_PAYWEAVE_DIR}/payweave.service.ts`;
const CONTROLLER_PATH = `${NEST_PAYWEAVE_DIR}/payweave-webhook.controller.ts`;
export const NEST_MODULE_PATH = `${NEST_PAYWEAVE_DIR}/payweave.module.ts`;
const PRODUCTS_PATH = `${NEST_PAYWEAVE_DIR}/products.ts`;
const README_PATH = `${NEST_PAYWEAVE_DIR}/README.md`;

/**
 * Prisma/Drizzle need a LOCAL import one level shallower than the
 * root-level `payweave.ts` assumes (`./lib/prisma`) — `payweave.service.ts`
 * lives one directory deeper (`src/payweave/`), so the same user-owned file
 * is now `../lib/prisma`. The other four database choices have no local
 * import at all (just a `payweave/db/*` package import), so they're reused
 * from `./config.ts` unchanged.
 */
const NEST_DATABASE_IMPORT: Readonly<Partial<Record<DatabaseChoice, string>>> = {
  ...DATABASE_IMPORT,
  prisma:
    'import { prismaAdapter } from "payweave/db/prisma";\n' +
    'import { prisma } from "../lib/prisma"; // TODO: point this at your existing PrismaClient',
  drizzle:
    'import { drizzleAdapter } from "payweave/db/drizzle";\n' +
    'import { db } from "../lib/db"; // TODO: point this at your existing Drizzle instance',
};

/**
 * `PayweaveService` — a Nest provider wrapping `createPayweave(...)`.
 * Reuses `PROVIDER_CONFIG_BLOCK`/`DATABASE_FACTORY` verbatim (prepending two
 * spaces of indentation), so the provider/database config shape matches the
 * generic `payweave.ts` renderer exactly, just nested inside a class field.
 */
export function renderNestPayweaveService(input: ScaffoldInput): ScaffoldFile {
  const { providers, database } = input;
  const lines: string[] = [
    `import { Injectable } from "@nestjs/common";`,
    `import { createPayweave } from "payweave";`,
  ];

  const dbImport = NEST_DATABASE_IMPORT[database];
  if (dbImport !== undefined) lines.push(dbImport);
  if (database !== "none") lines.push(`import { free, pro } from "./products";`);

  lines.push("", "@Injectable()", "export class PayweaveService {", "  readonly client = createPayweave({");
  for (const provider of providers) {
    for (const line of PROVIDER_CONFIG_BLOCK[provider]) lines.push(`  ${line}`);
  }
  // `defaultProvider` omitted + multiple providers configured is a
  // PayweaveConfigError — required the moment more than one provider is picked.
  if (providers.length > 1) {
    lines.push(`    defaultProvider: "${providers[0]}",`);
  }
  const dbFactory = DATABASE_FACTORY[database];
  if (dbFactory !== undefined) {
    lines.push(`    database: ${dbFactory},`);
    lines.push(`    products: [free, pro],`);
  }
  lines.push("  });", "}", "");

  return { relPath: SERVICE_PATH, contents: lines.join("\n") };
}

/**
 * The webhook controller, DI-wired to `PayweaveService` rather than
 * constructing its own client — mirrors `examples/nestjs/src/webhooks/webhooks.controller.ts`.
 */
export function renderNestWebhookController(): ScaffoldFile {
  const contents = [
    `import { Controller, Post, Req, Res, HttpStatus } from "@nestjs/common";`,
    `import type { RawBodyRequest } from "@nestjs/common";`,
    `import type { Request, Response } from "express";`,
    "",
    `import { PayweaveService } from "./payweave.service";`,
    "",
    "// Enable raw body capture when bootstrapping (main.ts) — Payweave verifies",
    "// the EXACT raw bytes the provider signed (golden rule 6); req.rawBody is",
    "// only populated once this is set:",
    "//   const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });",
    `@Controller("api/webhooks/payweave")`,
    "export class PayweaveWebhookController {",
    "  constructor(private readonly payweaveService: PayweaveService) {}",
    "",
    "  @Post()",
    "  async handle(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {",
    "    let event;",
    "    try {",
    "      event = this.payweaveService.client.webhooks.constructEvent({",
    "        rawBody: req.rawBody!,",
    "        headers: req.headers,",
    "      });",
    "    } catch {",
    '      res.status(HttpStatus.BAD_REQUEST).send("invalid webhook signature");',
    "      return;",
    "    }",
    "",
    "    await event.apply();",
    "    res.status(HttpStatus.OK).end();",
    "  }",
    "}",
    "",
  ].join("\n");
  return { relPath: CONTROLLER_PATH, contents };
}

/** `PayweaveModule` — wires the service + controller together and exports the service for other feature modules. */
export function renderNestPayweaveModule(): ScaffoldFile {
  const contents = [
    `import { Module } from "@nestjs/common";`,
    "",
    `import { PayweaveService } from "./payweave.service";`,
    `import { PayweaveWebhookController } from "./payweave-webhook.controller";`,
    "",
    "// Exports PayweaveService so any other feature module can inject it by",
    "// adding PayweaveModule to its own `imports` — Nest de-duplicates module",
    "// instances across the graph, so it stays one shared singleton.",
    "@Module({",
    "  providers: [PayweaveService],",
    "  controllers: [PayweaveWebhookController],",
    "  exports: [PayweaveService],",
    "})",
    "export class PayweaveModule {}",
    "",
  ].join("\n");
  return { relPath: NEST_MODULE_PATH, contents };
}

/** A short README documenting the generated folder — what each file is, and what's still manual (env values, `rawBody: true`). */
export function renderNestReadme(input: ScaffoldInput): ScaffoldFile {
  const lines: string[] = [
    "# Payweave module",
    "",
    "Generated by `npx payweave init`. A self-contained Nest module — everything",
    "Payweave needs lives in this folder, and `PayweaveModule` has already been",
    "added to `AppModule`'s `imports` in your project's root module.",
    "",
    "## Files",
    "",
    "- `payweave.service.ts` — the Payweave client (`createPayweave(...)`), exposed as `PayweaveService#client`.",
    "- `payweave-webhook.controller.ts` — the `POST /api/webhooks/payweave` route. Verifies the raw signed bytes; never trust a webhook body alone.",
    "- `payweave.module.ts` — wires the two above together and exports `PayweaveService` for other feature modules to inject.",
  ];
  if (input.database !== "none") {
    lines.push(
      "- `products.ts` — example plans/features. Edit these, then run `npx payweave push` to sync them to your provider(s).",
    );
  }
  lines.push(
    "",
    "## Before this works",
    "",
    "1. Fill in real values in `.env.example` at your project root, then copy it to `.env`.",
    "2. Set `rawBody: true` when bootstrapping in `main.ts`:",
    "   ```ts",
    "   const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });",
    "   ```",
    "   Without this, `req.rawBody` is undefined and every webhook fails signature verification.",
    "",
  );
  return { relPath: README_PATH, contents: lines.join("\n") };
}

/** Every Nest-specific scaffold file: service, webhook controller, module, README, plus `products.ts` (same folder) when a database is configured. */
export function planNestScaffold(input: ScaffoldInput): readonly ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    renderNestPayweaveService(input),
    renderNestWebhookController(),
    renderNestPayweaveModule(),
  ];
  if (input.database !== "none") {
    files.push({ relPath: PRODUCTS_PATH, contents: renderProducts() });
  }
  files.push(renderNestReadme(input));
  return files;
}
