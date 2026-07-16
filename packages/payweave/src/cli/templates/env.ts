/**
 * `.env.example` renderer + merge.
 *
 * Env var NAMES only, no values — real secrets never belong in a scaffolded
 * file, and the secret-regex CI gate (`scripts/check-no-secrets.mjs`) scans
 * every committed file, so no placeholder here may even resemble a real key
 * shape.
 */
import type { DatabaseChoice, ProviderId, ScaffoldInput } from "./types";

/** Exported so `mergeEnvExample` (and `init.ts`) can check per-block var names without re-parsing the joined string. */
export const PROVIDER_ENV_BLOCK: Readonly<Record<ProviderId, readonly string[]>> = {
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

export const DATABASE_ENV_BLOCK: Readonly<Partial<Record<DatabaseChoice, readonly string[]>>> = {
  postgres: ["# Postgres connection string", "DATABASE_URL="],
  mysql: ["# MySQL connection string", "DATABASE_URL="],
  sqlite: ["# SQLite / libSQL URL — defaults to file:./payweave.db if unset", "DATABASE_URL="],
  mongodb: ["# MongoDB connection string", "MONGODB_URI="],
};

/** Render `.env.example` for the chosen providers + database. */
export function renderEnvExample(input: ScaffoldInput): string {
  const blocks: (readonly string[])[] = [
    [
      "# Payweave — environment variables",
      "# Fill in real values in your own .env; never commit secrets.",
    ],
  ];
  for (const provider of input.providers) blocks.push(PROVIDER_ENV_BLOCK[provider]);
  const dbBlock = DATABASE_ENV_BLOCK[input.database];
  if (dbBlock !== undefined) blocks.push(dbBlock);
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

function blockHasMissingVar(block: readonly string[], existingKeys: ReadonlySet<string>): boolean {
  return block.some((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    return key !== undefined && !existingKeys.has(key);
  });
}

/**
 * Merge the wizard's env blocks into an EXISTING `.env.example` instead of
 * replacing it. Unlike every other scaffold file, `.env.example` is never
 * wholesale-overwritten (not even with `--force`, see `runInitCommand`'s doc
 * comment) — teams fill in real local values there, so clobbering it on a
 * second `init` run (e.g. after adding a provider) would silently discard
 * that work. Only whole blocks (a provider, or the database) with at least
 * one var not already present anywhere in the file get appended; a block
 * that's already fully covered is skipped, so re-running `init` with
 * unchanged answers is a true no-op. Returns `undefined` in that no-op case
 * so the caller can report "already up to date" instead of rewriting the
 * file with byte-identical content.
 */
export function mergeEnvExample(input: ScaffoldInput, existing: string): string | undefined {
  const existingKeys = new Set(
    existing
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((key): key is string => key !== undefined),
  );

  const missingBlocks: (readonly string[])[] = [];
  for (const provider of input.providers) {
    const block = PROVIDER_ENV_BLOCK[provider];
    if (blockHasMissingVar(block, existingKeys)) missingBlocks.push(block);
  }
  const dbBlock = DATABASE_ENV_BLOCK[input.database];
  if (dbBlock !== undefined && blockHasMissingVar(dbBlock, existingKeys)) missingBlocks.push(dbBlock);

  if (missingBlocks.length === 0) return undefined;
  const trimmed = existing.replace(/\n+$/, "");
  return `${trimmed}\n\n${missingBlocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}
