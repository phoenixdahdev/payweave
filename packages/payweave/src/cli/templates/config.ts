/**
 * `payweave.ts` + `products.ts` renderers (docs/v1/cli.md §1; unified-config.md
 * §1; plans-and-features.md §1–§3, PW-1005).
 */
import type { DatabaseChoice, ProviderId, ScaffoldInput } from "./types";

/** Per-provider config block (unified-config.md §1's `payweave.ts` example, verbatim shape). */
const PROVIDER_CONFIG_BLOCK: Readonly<Record<ProviderId, readonly string[]>> = {
  stripe: [
    "  stripe: {",
    "    secretKey: process.env.STRIPE_SECRET_KEY!,",
    "    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,",
    "  },",
  ],
  // NOTE: Paystack has no `webhookSecret` config field — its webhook scheme
  // signs with the secret key itself (unified-config.md §5's dispatch table:
  // "x-paystack-signature | paystack | HMAC-SHA512 hex, key = secret key").
  paystack: ["  paystack: {", "    secretKey: process.env.PAYSTACK_SECRET_KEY!,", "  },"],
  // v3 (the default) uses `webhookSecret` for `verif-hash` equality
  // (unified-config.md §5); v4's OAuth `clientId`/`clientSecret` shape is a
  // distinct opt-in the wizard doesn't offer in v1 (spec-silent: v3 is
  // Flutterwave's documented default and the shape the CLI scaffolds).
  flutterwave: [
    "  flutterwave: {",
    "    secretKey: process.env.FLUTTERWAVE_SECRET_KEY!,",
    "    webhookSecret: process.env.FLUTTERWAVE_WEBHOOK_SECRET!,",
    "  },",
  ],
};

/**
 * Import line(s) for the chosen database adapter (database.md §1, §4 subpaths).
 * Absent for `"none"` — a payments-only project imports nothing extra.
 */
const DATABASE_IMPORT: Readonly<Partial<Record<DatabaseChoice, string>>> = {
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

/** The `database:` factory call for the chosen adapter (database.md §1 examples, same shape). */
const DATABASE_FACTORY: Readonly<Partial<Record<DatabaseChoice, string>>> = {
  prisma: "prismaAdapter(prisma)",
  drizzle: "drizzleAdapter(db)",
  postgres: "postgresAdapter({ connectionString: process.env.DATABASE_URL! })",
  mysql: "mysqlAdapter({ uri: process.env.DATABASE_URL! })",
  sqlite: 'sqliteAdapter({ url: process.env.DATABASE_URL ?? "file:./payweave.db" })',
  mongodb: 'mongodbAdapter({ url: process.env.MONGODB_URI!, dbName: "app" })',
};

/**
 * Render `payweave.ts` — the file PW-1002's discovery contract finds at the
 * project root (cli.md §5; unified-config.md §1). Exports the client as
 * `export const payweave = createPayweave(...)` (a named `payweave` export —
 * one of the two shapes `loadConfig` accepts).
 *
 * Spec-silent decision: `products`/`database` are wired together or not at
 * all. plans-and-features.md §2 rule 5 makes `products` without a `database`
 * a `PayweaveConfigError` AT CONSTRUCTION — so a `"none"` database choice
 * omits both from the generated config (never a config that throws the
 * moment the user runs anything). `products.ts` is still scaffolded
 * separately either way (cli.md §1's artifact list is unconditional) so
 * wiring it in later is a two-line diff once a database is added.
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
  // unified-config.md §2 rule 3: omitted + multiple providers configured is a
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
      "// Add a `database` adapter (database.md §1) and pass `products` above to",
      "// unlock the billing surface — subscribe()/check()/report(). products.ts",
      "// already has an example plan structure ready to import.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Render `products.ts` — the example plan structure cli.md §1 calls for
 * (plans-and-features.md §1–§3, matched close to verbatim since that spec
 * section is written as the public docs page). `feature`/`plan` are
 * re-exported from the package root (PW-802) — imported from `"payweave"`
 * directly, exactly as plans-and-features.md §1 shows.
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
