/**
 * `payweave.ts` + `products.ts` renderers.
 */
import type { DatabaseChoice, ProviderId, ScaffoldInput } from "./types";

/**
 * Per-provider config block, matching the documented `payweave.ts` example
 * shape. Exported so `./nest.ts` can reuse it verbatim inside a class field
 * (it just prepends indentation) instead of duplicating provider config.
 */
export const PROVIDER_CONFIG_BLOCK: Readonly<Record<ProviderId, readonly string[]>> = {
  stripe: [
    "  stripe: {",
    "    secretKey: process.env.STRIPE_SECRET_KEY!,",
    "    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,",
    "  },",
  ],
  // NOTE: Paystack has no `webhookSecret` config field — its webhook scheme
  // signs with the secret key itself (x-paystack-signature header, HMAC-SHA512
  // hex, key = secret key).
  paystack: ["  paystack: {", "    secretKey: process.env.PAYSTACK_SECRET_KEY!,", "  },"],
  // v3 (the default) uses `webhookSecret` for `verif-hash` equality. v4's
  // OAuth `clientId`/`clientSecret` shape is a distinct opt-in the wizard
  // doesn't offer in v1 (spec-silent: v3 is Flutterwave's documented default
  // and the shape the CLI scaffolds).
  flutterwave: [
    "  flutterwave: {",
    "    secretKey: process.env.FLUTTERWAVE_SECRET_KEY!,",
    "    webhookSecret: process.env.FLUTTERWAVE_WEBHOOK_SECRET!,",
    "  },",
  ],
};

/**
 * Import line(s) for the chosen database adapter.
 * Absent for `"none"` — a payments-only project imports nothing extra.
 * Exported so `./nest.ts` can override just the prisma/drizzle entries (the
 * only ones with a path that depends on where the importing file lives)
 * rather than duplicating the other four.
 */
export const DATABASE_IMPORT: Readonly<Partial<Record<DatabaseChoice, string>>> = {
  prisma:
    'import { prismaAdapter } from "payweave/db/prisma";\n' +
    'import { prisma } from "./lib/prisma"; // TODO: point this at your existing PrismaClient',
  drizzle:
    'import { drizzleAdapter } from "payweave/db/drizzle";\n' +
    'import { db } from "./lib/db"; // TODO: point this at your existing Drizzle instance',
  postgres: 'import { postgresAdapter } from "payweave/db/postgres";',
  mysql: 'import { mysqlAdapter } from "payweave/db/mysql";',
  sqlite: 'import { sqliteAdapter } from "payweave/db/sqlite";',
  mongodb: 'import { mongodbAdapter } from "payweave/db/mongodb";',
};

/** The `database:` factory call for the chosen adapter. */
export const DATABASE_FACTORY: Readonly<Partial<Record<DatabaseChoice, string>>> = {
  prisma: "prismaAdapter(prisma)",
  drizzle: "drizzleAdapter(db)",
  postgres: "postgresAdapter({ connectionString: process.env.DATABASE_URL! })",
  mysql: "mysqlAdapter({ uri: process.env.DATABASE_URL! })",
  sqlite: 'sqliteAdapter({ url: process.env.DATABASE_URL ?? "file:./payweave.db" })',
  mongodb: 'mongodbAdapter({ url: process.env.MONGODB_URI!, dbName: "app" })',
};

/**
 * Render `payweave.ts` — the file the config-loader's discovery contract
 * finds at the project root. Exports the client as
 * `export const payweave = createPayweave(...)` (a named `payweave` export —
 * one of the two shapes `loadConfig` accepts).
 *
 * Decision: `products`/`database` are wired together or not at all.
 * `products` without a `database` is a `PayweaveConfigError` AT
 * CONSTRUCTION — so a `"none"` database choice omits both from the generated
 * config (never a config that throws the moment the user runs anything).
 * `products.ts` is still scaffolded separately either way, so wiring it in
 * later is a two-line diff once a database is added.
 */
export function renderPayweaveConfig(input: ScaffoldInput): string {
  const { providers, database } = input;
  const lines: string[] = [`import { createPayweave } from "payweave";`];

  const dbImport = DATABASE_IMPORT[database];
  if (dbImport !== undefined) lines.push(dbImport);
  if (database !== "none") lines.push(`import { free, pro } from "./products";`);

  lines.push("", `export const payweave = createPayweave({`);
  for (const provider of providers) {
    lines.push(...PROVIDER_CONFIG_BLOCK[provider]);
  }
  // `defaultProvider` omitted + multiple providers configured is a
  // PayweaveConfigError — required the moment more than one provider is picked.
  if (providers.length > 1) {
    lines.push(`  defaultProvider: "${providers[0]}",`);
  }

  const dbFactory = DATABASE_FACTORY[database];
  if (dbFactory !== undefined) {
    lines.push(`  database: ${dbFactory},`);
    lines.push(`  products: [free, pro],`);
  }
  lines.push(`});`, "");

  if (database === "none") {
    lines.push(
      "// Add a `database` adapter and pass `products` above to",
      "// unlock the billing surface — subscribe()/check()/report(). products.ts",
      "// already has an example plan structure ready to import.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Render `products.ts` — an example plan structure. `feature`/`plan` are
 * re-exported from the package root — imported from `"payweave"` directly.
 */
export function renderProducts(): string {
  return [
    `import { feature, plan } from "payweave";`,
    "",
    `const messages = feature({ id: "messages", type: "metered" });`,
    "",
    `export const free = plan({`,
    `  id: "free",`,
    `  name: "Free",`,
    `  group: "base",`,
    `  default: true,`,
    `  includes: [messages({ limit: 100, reset: "month" })],`,
    `});`,
    "",
    `export const pro = plan({`,
    `  id: "pro",`,
    `  name: "Pro",`,
    `  group: "base",`,
    `  price: { amount: 19, currency: "USD", interval: "month" },`,
    `  includes: [messages({ limit: 2_000, reset: "month" })],`,
    `});`,
    "",
  ].join("\n");
}
