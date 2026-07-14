/**
 * Published Drizzle schema — MySQL dialect (docs/v1/database.md §2/§4,
 * PW-708). Merge these table definitions into your own `schema.ts` and
 * migrate them with `drizzle-kit` (`push` for local/dev, `generate` +
 * `migrate` for tracked migrations) — Payweave never runs migrations for the
 * Drizzle adapter itself (`../index.ts`'s `migrations.apply()` returns
 * instructions, never DDL; database.md §4 "Same model" as the Prisma
 * adapter).
 *
 * Column-for-column equivalent to `src/db/migrations/ddl.ts`'s
 * `MYSQL_INIT_STATEMENTS` — asserted by `test/db/drizzle.test.ts`'s
 * cross-dialect parity test. Per-dialect storage mapping:
 * `datetime(3)` timestamps, native `json`, `tinyint(1)`-backed `boolean`,
 * `bigint` (mode `"number"`) for money/usage/version-scale integers.
 *
 * MySQL has NO partial unique indexes (database.md §4 build-time resolution,
 * mirroring PW-703's `src/db/migrations/ddl.ts` header exactly): the
 * `pw_subscriptions` active-subscription rule is emulated with a `STORED`
 * generated column `active_slot` (`'x'` when `status` is in the active set,
 * `NULL` otherwise) plus a composite unique index on
 * (`customer_id`, `group`, `active_slot`) — MySQL unique indexes never treat
 * NULLs as equal, so inactive rows never collide while a second active-set
 * row per (customer, group) is rejected. `active_slot` is generated storage
 * — the adapter must NEVER write it (an INSERT naming it errors; that is the
 * DDL working, not a bug).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  datetime,
  int,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type {
  PwFeatureInclusion,
  PwPriceInterval,
  PwResetInterval,
  PwSubscriptionStatus,
} from "../../schema";
import { PW_ACTIVE_SUBSCRIPTION_STATUSES, PW_TABLES } from "../../schema";

/** `status IN (...)` list for the generated `active_slot` column, derived from the contract constant. */
const ACTIVE_STATUS_SQL_LIST = sql.raw(
  PW_ACTIVE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(", "),
);

const utf8mb4Bin = { charSet: "utf8mb4" as const, collate: "utf8mb4_bin" as const };

export const pwCustomers = mysqlTable(PW_TABLES.customers, {
  id: varchar("id", { length: 255 }).primaryKey(),
  externalId: varchar("external_id", { length: 255, ...utf8mb4Bin }).notNull().unique(),
  providerIds: json("provider_ids").$type<Record<string, string>>().notNull(),
  email: varchar("email", { length: 255 }),
  createdAt: datetime("created_at", { fsp: 3 }).notNull(),
  updatedAt: datetime("updated_at", { fsp: 3 }).notNull(),
});

export const pwPlans = mysqlTable(
  PW_TABLES.plans,
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    planId: varchar("plan_id", { length: 255 }).notNull(),
    version: int("version").notNull(),
    group: varchar("group", { length: 255 }).notNull(),
    isDefault: boolean("is_default").notNull(),
    name: varchar("name", { length: 255 }),
    priceMinor: bigint("price_minor", { mode: "number" }),
    priceCurrency: varchar("price_currency", { length: 255 }),
    priceInterval: varchar("price_interval", { length: 255 }).$type<PwPriceInterval>(),
    features: json("features").$type<Record<string, PwFeatureInclusion>>().notNull(),
    providerRefs: json("provider_refs").$type<Record<string, Record<string, string>>>().notNull(),
    pushedAt: datetime("pushed_at", { fsp: 3 }).notNull(),
  },
  (t) => [uniqueIndex("pw_plans_plan_id_version_uq").on(t.planId, t.version)],
);

export const pwSubscriptions = mysqlTable(
  PW_TABLES.subscriptions,
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    customerId: varchar("customer_id", { length: 255 })
      .notNull()
      .references(() => pwCustomers.id),
    planId: varchar("plan_id", { length: 255 }).notNull(),
    planVersion: int("plan_version").notNull(),
    group: varchar("group", { length: 255, ...utf8mb4Bin }).notNull(),
    status: varchar("status", { length: 255, ...utf8mb4Bin }).$type<PwSubscriptionStatus>().notNull(),
    provider: varchar("provider", { length: 255 }),
    providerSubscriptionRef: varchar("provider_subscription_ref", { length: 255 }),
    currentPeriodStart: datetime("current_period_start", { fsp: 3 }).notNull(),
    currentPeriodEnd: datetime("current_period_end", { fsp: 3 }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull(),
    createdAt: datetime("created_at", { fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { fsp: 3 }).notNull(),
    // STORED generated column emulating the partial-unique rule (see module
    // header) — never write to this column directly.
    activeSlot: char("active_slot", { length: 1 }).generatedAlwaysAs(
      sql`case when ${sql.identifier("status")} in (${ACTIVE_STATUS_SQL_LIST}) then 'x' else null end`,
      { mode: "stored" },
    ),
  },
  (t) => [uniqueIndex("pw_subscriptions_active_uq").on(t.customerId, t.group, t.activeSlot)],
);

export const pwFeatureBalances = mysqlTable(
  PW_TABLES.featureBalances,
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    customerId: varchar("customer_id", { length: 255 })
      .notNull()
      .references(() => pwCustomers.id),
    featureId: varchar("feature_id", { length: 255 }).notNull(),
    group: varchar("group", { length: 255, ...utf8mb4Bin }).notNull(),
    used: bigint("used", { mode: "number" }).notNull(),
    limit: bigint("limit", { mode: "number" }).notNull(),
    resetInterval: varchar("reset_interval", { length: 255 }).$type<PwResetInterval>().notNull(),
    anchor: datetime("anchor", { fsp: 3 }).notNull(),
    periodStart: datetime("period_start", { fsp: 3 }).notNull(),
    periodEnd: datetime("period_end", { fsp: 3 }).notNull(),
    planId: varchar("plan_id", { length: 255 }).notNull(),
    planVersion: int("plan_version").notNull(),
    updatedAt: datetime("updated_at", { fsp: 3 }).notNull(),
  },
  (t) => [
    uniqueIndex("pw_feature_balances_customer_feature_group_uq").on(
      t.customerId,
      t.featureId,
      t.group,
    ),
  ],
);

export const pwWebhookEvents = mysqlTable(PW_TABLES.webhookEvents, {
  dedupeKey: varchar("dedupe_key", { length: 255 }).primaryKey(),
  provider: varchar("provider", { length: 255 }).notNull(),
  type: varchar("type", { length: 255 }).notNull(),
  receivedAt: datetime("received_at", { fsp: 3 }).notNull(),
  claimedAt: datetime("claimed_at", { fsp: 3 }),
  appliedAt: datetime("applied_at", { fsp: 3 }),
});

/** Every table this schema publishes, keyed the same way as `PW_TABLES`. */
export const mysqlSchema = {
  pwCustomers,
  pwPlans,
  pwSubscriptions,
  pwFeatureBalances,
  pwWebhookEvents,
};
