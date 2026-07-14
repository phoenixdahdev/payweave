/**
 * Prisma/Drizzle schema fragment renderers.
 */
import type { ScaffoldFile } from "./types";

/**
 * Provisional Prisma schema fragment, hand-derived from the logical schema
 * table (`src/db/schema.ts`). `payweave/db/prisma`'s real factory has not
 * shipped yet — it is still a placeholder that always throws
 * `PayweaveConfigError` (see `src/db/prisma/index.ts`) — so there is no
 * canonical fragment to re-export yet. Treat this as a starting point: once
 * a real canonical schema.prisma fragment ships, confirm field names
 * against that instead.
 *
 * `pw_migrations` is deliberately NOT included: Prisma/Drizzle users own
 * their own migrations (`prisma migrate`), unlike the SQL adapters where
 * Payweave applies its own embedded migrations.
 */
export function renderPrismaSchema(): ScaffoldFile {
  const contents = `// payweave.prisma — Payweave schema fragment.
// PROVISIONAL: hand-derived pending a canonical fragment shipping with the
// Prisma adapter — see the doc comment on this file's generator
// (src/cli/templates/schema.ts).
// Merge these models into your own schema.prisma.

model PwCustomer {
  id          String   @id
  externalId  String   @unique @map("external_id")
  providerIds Json     @map("provider_ids")
  email       String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("pw_customers")
}

model PwPlan {
  id            String   @id
  planId        String   @map("plan_id")
  version       Int
  group         String
  isDefault     Boolean  @map("is_default")
  name          String?
  priceMinor    Int?     @map("price_minor")
  priceCurrency String?  @map("price_currency")
  priceInterval String?  @map("price_interval")
  features      Json
  providerRefs  Json     @map("provider_refs")
  pushedAt      DateTime @map("pushed_at")

  @@unique([planId, version])
  @@map("pw_plans")
}

model PwSubscription {
  id                      String   @id
  customerId              String   @map("customer_id")
  planId                  String   @map("plan_id")
  planVersion             Int      @map("plan_version")
  group                   String
  status                  String
  provider                String
  providerSubscriptionRef String?  @map("provider_subscription_ref")
  currentPeriodStart      DateTime @map("current_period_start")
  currentPeriodEnd        DateTime @map("current_period_end")
  cancelAtPeriodEnd       Boolean  @map("cancel_at_period_end")
  createdAt               DateTime @default(now()) @map("created_at")
  updatedAt               DateTime @updatedAt @map("updated_at")

  @@map("pw_subscriptions")
}

model PwFeatureBalance {
  id            String   @id
  customerId    String   @map("customer_id")
  featureId     String   @map("feature_id")
  group         String
  used          Int
  limit         Int
  resetInterval String   @map("reset_interval")
  anchor        DateTime
  periodStart   DateTime @map("period_start")
  periodEnd     DateTime @map("period_end")
  planId        String   @map("plan_id")
  planVersion   Int      @map("plan_version")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@unique([customerId, featureId, group])
  @@map("pw_feature_balances")
}

model PwWebhookEvent {
  dedupeKey  String    @id @map("dedupe_key")
  provider   String
  type       String
  receivedAt DateTime  @map("received_at")
  claimedAt  DateTime? @map("claimed_at")
  appliedAt  DateTime? @map("applied_at")

  @@map("pw_webhook_events")
}
`;
  return { relPath: "payweave.prisma", contents };
}

/**
 * Drizzle guidance file. Unlike Prisma, `payweave/db/drizzle` already SHIPS
 * real, canonical table definitions — `pgSchema`/`mysqlSchema`/`sqliteSchema`
 * — so this re-exports the real thing instead of hand-duplicating a
 * fragment that could drift from it.
 */
export function renderDrizzleSchema(): ScaffoldFile {
  const contents = [
    "// payweave-schema.ts — merge Payweave's tables into your Drizzle schema.",
    "// Pick the export matching your SQL dialect; the other",
    "// two stay commented out so this file typechecks regardless of which one",
    "// you use.",
    'export { pgSchema as payweavePgSchema } from "payweave/db/drizzle";',
    '// export { mysqlSchema as payweaveMysqlSchema } from "payweave/db/drizzle";',
    '// export { sqliteSchema as payweaveSqliteSchema } from "payweave/db/drizzle";',
    "",
  ].join("\n");
  return { relPath: "payweave-schema.ts", contents };
}
