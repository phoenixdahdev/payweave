/**
 * `.env.example` renderer (docs/v1/cli.md §1, §7; PW-1005).
 *
 * Env var NAMES only, no values — real secrets never belong in a scaffolded
 * file (cli.md §1: "collects the env var names"), and the AGENTS.md §2 rule 5
 * secret-regex CI gate (`scripts/check-no-secrets.mjs`) scans every committed
 * file, so no placeholder here may even resemble a real key shape.
 */
import type { DatabaseChoice, ProviderId, ScaffoldInput } from "./types";

const PROVIDER_ENV_BLOCK: Readonly<Record<ProviderId, readonly string[]>> = {
  stripe: [
    "# Stripe — https://dashboard.stripe.com/apikeys",
    "STRIPE_SECRET_KEY=",
    "STRIPE_WEBHOOK_SECRET=",
  ],
  paystack: [
    "# Paystack — https://dashboard.paystack.com/#/settings/developer",
    "PAYSTACK_SECRET_KEY=",
  ],
  flutterwave: [
    "# Flutterwave — https://dashboard.flutterwave.com/settings/apis",
    "FLUTTERWAVE_SECRET_KEY=",
    "FLUTTERWAVE_WEBHOOK_SECRET=",
  ],
};

const DATABASE_ENV_BLOCK: Readonly<Partial<Record<DatabaseChoice, readonly string[]>>> = {
  postgres: ["# Postgres connection string", "DATABASE_URL="],
  mysql: ["# MySQL connection string", "DATABASE_URL="],
  sqlite: ["# SQLite / libSQL URL — defaults to file:./payweave.db if unset", "DATABASE_URL="],
  mongodb: ["# MongoDB connection string", "MONGODB_URI="],
};

/** Render `.env.example` for the chosen providers + database. */
export function renderEnvExample(input: ScaffoldInput): string {
  const blocks: (readonly string[])[] = [
    [
      "# Payweave — environment variables (docs/v1/cli.md §1)",
      "# Fill in real values in your own .env; never commit secrets.",
    ],
  ];
  for (const provider of input.providers) blocks.push(PROVIDER_ENV_BLOCK[provider]);
  const dbBlock = DATABASE_ENV_BLOCK[input.database];
  if (dbBlock !== undefined) blocks.push(dbBlock);
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}
