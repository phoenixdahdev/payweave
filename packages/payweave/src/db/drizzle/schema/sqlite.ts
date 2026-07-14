/**
 * Published Drizzle schema — SQLite/libSQL dialect (docs/v1/database.md
 * §2/§4, PW-708). Merge these table definitions into your own `schema.ts` and
 * migrate them with `drizzle-kit` (`push` for local/dev, `generate` +
 * `migrate` for tracked migrations) — Payweave never runs migrations for the
 * Drizzle adapter itself (`../index.ts`'s `migrations.apply()` returns
 * instructions, never DDL; database.md §4 "Same model" as the Prisma
 * adapter).
 *
 * Column-for-column equivalent to `src/db/migrations/ddl.ts`'s
 * `SQLITE_INIT_STATEMENTS` — asserted by `test/db/drizzle.test.ts`'s
 * cross-dialect parity test so this file, `./mysql.ts`, and `./pg.ts` can
 * never silently drift from each other or from the SQL adapters' DDL
 * knowledge. Per-dialect storage mapping: timestamps are
 * epoch-millisecond `integer` columns (`{ mode: "timestamp_ms" }` — drizzle
 * marshals to/from a JS `Date` automatically); JSON columns are `text`
 * (`{ mode: "json" }`); booleans are `integer` (`{ mode: "boolean" }`).
 *
 * The `pw_subscriptions` partial-unique active-subscription rule (database.md
 * §2) uses SQLite's NATIVE partial index support: `uniqueIndex(...).where(...)`.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  PwFeatureInclusion,
  PwPriceInterval,
  PwResetInterval,
  PwSubscriptionStatus,
} from "../../schema";
import { PW_ACTIVE_SUBSCRIPTION_STATUSES, PW_TABLES } from "../../schema";

/** `status IN (...)` list for the partial-unique index, derived from the contract constant. */
const ACTIVE_STATUS_SQL_LIST = sql.raw(
  PW_ACTIVE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(", "),
);

export const pwCustomers = sqliteTable(PW_TABLES.customers, {
  id: text("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  providerIds: text("provider_ids", { mode: "json" }).$type<Record<string, string>>().notNull(),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const pwPlans = sqliteTable(
  PW_TABLES.plans,
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    version: integer("version").notNull(),
    group: text("group").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull(),
    name: text("name"),
    priceMinor: integer("price_minor"),
    priceCurrency: text("price_currency"),
    priceInterval: text("price_interval").$type<PwPriceInterval>(),
    features: text("features", { mode: "json" }).$type<Record<string, PwFeatureInclusion>>().notNull(),
    providerRefs: text("provider_refs", { mode: "json" })
      .$type<Record<string, Record<string, string>>>()
      .notNull(),
    pushedAt: integer("pushed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("pw_plans_plan_id_version_uq").on(t.planId, t.version)],
);

export const pwSubscriptions = sqliteTable(
  PW_TABLES.subscriptions,
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    group: text("group").notNull(),
    status: text("status").$type<PwSubscriptionStatus>().notNull(),
    provider: text("provider"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    currentPeriodStart: integer("current_period_start", { mode: "timestamp_ms" }).notNull(),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }).notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("pw_subscriptions_active_uq")
      .on(t.customerId, t.group)
      .where(sql`${t.status} IN (${ACTIVE_STATUS_SQL_LIST})`),
  ],
);

export const pwFeatureBalances = sqliteTable(
  PW_TABLES.featureBalances,
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull(),
    featureId: text("feature_id").notNull(),
    group: text("group").notNull(),
    used: integer("used").notNull(),
    limit: integer("limit").notNull(),
    resetInterval: text("reset_interval").$type<PwResetInterval>().notNull(),
    anchor: integer("anchor", { mode: "timestamp_ms" }).notNull(),
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("pw_feature_balances_customer_feature_group_uq").on(
      t.customerId,
      t.featureId,
      t.group,
    ),
  ],
);

export const pwWebhookEvents = sqliteTable(PW_TABLES.webhookEvents, {
  dedupeKey: text("dedupe_key").primaryKey(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
});

/** Every table this schema publishes, keyed the same way as `PW_TABLES`. */
export const sqliteSchema = {
  pwCustomers,
  pwPlans,
  pwSubscriptions,
  pwFeatureBalances,
  pwWebhookEvents,
};
