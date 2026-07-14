/**
 * Published Drizzle schema — PostgreSQL dialect. Merge these table
 * definitions into your own `schema.ts` and
 * migrate them with `drizzle-kit` (`push` for local/dev, `generate` +
 * `migrate` for tracked migrations) — Payweave never runs migrations for the
 * Drizzle adapter itself (`../index.ts`'s `migrations.apply()` returns
 * instructions, never DDL — "same model" as the Prisma
 * adapter). This is the dialect the shared conformance suite runs against in
 * CI — a dockerized `postgres:16`; it
 * cannot run in this sandbox (no docker), so it is exercised here via the
 * schema + adapter code, not a live conformance run (see `test/db/drizzle.test.ts`).
 *
 * Column-for-column equivalent to `src/db/migrations/ddl.ts`'s
 * `POSTGRES_INIT_STATEMENTS` — asserted by `test/db/drizzle.test.ts`'s
 * cross-dialect parity test. Per-dialect storage mapping:
 * `timestamptz` timestamps, `jsonb` JSON, native `boolean`, `bigint` (mode
 * `"number"`, since these values are safe-integer money/usage counters —
 * AGENTS.md rule 7 — never JS `bigint`) for money/usage/version-scale integers.
 *
 * The `pw_subscriptions` partial-unique active-subscription rule uses
 * Postgres's NATIVE partial index support: `uniqueIndex(...).where(...)`.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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

export const pwCustomers = pgTable(PW_TABLES.customers, {
  id: text("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  providerIds: jsonb("provider_ids").$type<Record<string, string>>().notNull(),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const pwPlans = pgTable(
  PW_TABLES.plans,
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    version: integer("version").notNull(),
    group: text("group").notNull(),
    isDefault: boolean("is_default").notNull(),
    name: text("name"),
    priceMinor: bigint("price_minor", { mode: "number" }),
    priceCurrency: text("price_currency"),
    priceInterval: text("price_interval").$type<PwPriceInterval>(),
    features: jsonb("features").$type<Record<string, PwFeatureInclusion>>().notNull(),
    providerRefs: jsonb("provider_refs").$type<Record<string, Record<string, string>>>().notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("pw_plans_plan_id_version_uq").on(t.planId, t.version)],
);

export const pwSubscriptions = pgTable(
  PW_TABLES.subscriptions,
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => pwCustomers.id),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    group: text("group").notNull(),
    status: text("status").$type<PwSubscriptionStatus>().notNull(),
    provider: text("provider"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("pw_subscriptions_active_uq")
      .on(t.customerId, t.group)
      .where(sql`${t.status} IN (${ACTIVE_STATUS_SQL_LIST})`),
  ],
);

export const pwFeatureBalances = pgTable(
  PW_TABLES.featureBalances,
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => pwCustomers.id),
    featureId: text("feature_id").notNull(),
    group: text("group").notNull(),
    used: bigint("used", { mode: "number" }).notNull(),
    limit: bigint("limit", { mode: "number" }).notNull(),
    resetInterval: text("reset_interval").$type<PwResetInterval>().notNull(),
    anchor: timestamp("anchor", { withTimezone: true }).notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("pw_feature_balances_customer_feature_group_uq").on(
      t.customerId,
      t.featureId,
      t.group,
    ),
  ],
);

export const pwWebhookEvents = pgTable(PW_TABLES.webhookEvents, {
  dedupeKey: text("dedupe_key").primaryKey(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});

/** Every table this schema publishes, keyed the same way as `PW_TABLES`. */
export const pgSchema = {
  pwCustomers,
  pwPlans,
  pwSubscriptions,
  pwFeatureBalances,
  pwWebhookEvents,
};
