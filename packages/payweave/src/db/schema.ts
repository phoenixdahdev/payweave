/**
 * Row schemas + storage constants for the Payweave database layer
 * (docs/v1/database.md §2, PW-701). These Zod schemas ARE the logical storage
 * contract — every row an adapter returns must parse against them, and the
 * conformance suite (`test/db/conformance.ts`) enforces exactly that. Exact
 * DDL per dialect lives with each adapter (PW-704+), which owns the mapping
 * from these camelCase field names to the spec's snake_case column names
 * (`externalId` ↔ `external_id`, `periodEnd` ↔ `period_end`, …).
 *
 * Conventions (database.md §2 "Key columns" notation):
 * - Columns marked `?` in the spec are NULLABLE here (`.nullable()` — the
 *   value is always present on the row, `null` when unset). Optional keys
 *   (`?:`) appear only on INPUT shapes.
 * - No floats anywhere: money is integer minor units + currency code (golden
 *   rule 7 applies to storage), counters/versions are integers.
 * - All timestamps are UTC `Date` instances.
 *
 * INTERNAL until PW-505 wires the `payweave/db` subpath into the exports map.
 */
import { z } from "zod";

// ── Table names ──────────────────────────────────────────────────────────────

/** Every Payweave-owned table/collection is prefixed `pw_` (database.md §2). */
export const PW_TABLE_PREFIX = "pw_";

/**
 * Canonical table/collection names, keyed by the adapter store that owns them
 * (database.md §2). Adapters and migrations MUST use these constants — never
 * re-spell the names.
 */
export const PW_TABLES = {
  customers: "pw_customers",
  plans: "pw_plans",
  subscriptions: "pw_subscriptions",
  featureBalances: "pw_feature_balances",
  webhookEvents: "pw_webhook_events",
  migrations: "pw_migrations",
} as const;

/** Union of the canonical `pw_*` table names. */
export type PwTableName = (typeof PW_TABLES)[keyof typeof PW_TABLES];

// ── Shared scalars ───────────────────────────────────────────────────────────

/**
 * Payweave row id: `pwv_<ulid>` (database.md §2 — "IDs are `pwv_<ulid>`
 * strings unless noted"). ULID = 26 chars of Crockford base32; decoding is
 * case-insensitive, so both cases are accepted. The exceptions ("unless
 * noted") are `pw_webhook_events.dedupe_key` and `pw_migrations.name`, which
 * are natural keys.
 */
export const pwIdSchema = z
  .string()
  .regex(
    /^pwv_[0-9A-HJKMNP-TV-Z]{26}$/i,
    "expected a Payweave row id — 'pwv_' followed by a 26-char ULID",
  );

/**
 * Subscription lifecycle states (database.md §2 `pw_subscriptions.status`).
 */
export const pwSubscriptionStatusSchema = z.enum([
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "trialing",
]);
export type PwSubscriptionStatus = z.infer<typeof pwSubscriptionStatusSchema>;

/**
 * Statuses covered by the partial unique index on (`customer_id`, `group`) —
 * at most ONE subscription per customer/group may be in any of these states
 * (database.md §2). `subscriptions.getActive` answers from this set.
 */
export const PW_ACTIVE_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"] as const;

/** Metered-feature reset interval (plans-and-features.md §2, metered-usage.md §5). */
export const pwResetIntervalSchema = z.enum(["day", "week", "month", "year"]);
export type PwResetInterval = z.infer<typeof pwResetIntervalSchema>;

/** Plan price billing interval (plans-and-features.md §4: `month` or `year`). */
export const pwPriceIntervalSchema = z.enum(["month", "year"]);
export type PwPriceInterval = z.infer<typeof pwPriceIntervalSchema>;

/**
 * Default stale-claim window for `webhookEvents.claim` (database.md §3): a
 * claimed-but-unapplied event becomes re-claimable once
 * `now - claimed_at >= staleClaimAfterMs`, so a crashed apply is retried on
 * provider redelivery instead of silently dropped.
 */
export const DEFAULT_STALE_CLAIM_AFTER_MS = 60_000;

// ── pw_customers ─────────────────────────────────────────────────────────────

/**
 * `pw_customers` row — maps YOUR user id (`externalId`, unique) to
 * per-provider customer ids (database.md §2).
 */
export const pwCustomerSchema = z.object({
  id: pwIdSchema,
  /** Your `customerId` — unique across the table. */
  externalId: z.string().min(1),
  /** Column `provider_ids` (JSON), e.g. `{ stripe: "cus_x", paystack: "CUS_x" }`. */
  providerIds: z.record(z.string().min(1), z.string().min(1)),
  email: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PwCustomer = z.infer<typeof pwCustomerSchema>;

/**
 * Input for `customers.upsert` — keyed by `externalId`; provider refs are
 * linked separately via `customers.linkProviderRef` (database.md §3).
 */
export const pwCustomerUpsertSchema = z.object({
  externalId: z.string().min(1),
  email: z.string().optional(),
});
export type PwCustomerUpsert = z.infer<typeof pwCustomerUpsertSchema>;

// ── pw_plans ─────────────────────────────────────────────────────────────────

/**
 * One resolved feature inclusion inside a plan version's `features` JSON
 * (plans-and-features.md §9). Loose objects: PW-801 may enrich inclusions
 * with extra fields — unknown keys must survive a round-trip through storage.
 */
export const pwFeatureInclusionSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("boolean") }),
  z.looseObject({
    type: z.literal("metered"),
    limit: z.number().int().positive(),
    reset: pwResetIntervalSchema,
  }),
]);
export type PwFeatureInclusion = z.infer<typeof pwFeatureInclusionSchema>;

/**
 * `pw_plans` row — an IMMUTABLE plan version pushed from config
 * (database.md §2). Append-only: `plans.pushVersion` never mutates or deletes
 * an existing (`planId`, `version`) row; running app instances keep reading
 * the version they were deployed with.
 */
export const pwPlanVersionSchema = z.object({
  id: pwIdSchema,
  /** The config-side plan id (`plan()`'s `id`), unique together with `version`. */
  planId: z.string().min(1),
  version: z.number().int().positive(),
  group: z.string().min(1),
  isDefault: z.boolean(),
  name: z.string().nullable(),
  /** Integer minor units — no floats ever (golden rule 7). `null` = free plan. */
  priceMinor: z.number().int().nonnegative().nullable(),
  priceCurrency: z.string().nullable(),
  priceInterval: pwPriceIntervalSchema.nullable(),
  /** Column `features` (JSON) — resolved includes, keyed by feature id. */
  features: z.record(z.string().min(1), pwFeatureInclusionSchema),
  /**
   * Column `provider_refs` (JSON), e.g.
   * `{ stripe: { productId, priceId }, paystack: { planCode } }` — filled in
   * by billing sync (`payweave push`, PW-803).
   */
  providerRefs: z.record(z.string().min(1), z.record(z.string().min(1), z.string().min(1))),
  pushedAt: z.date(),
});
export type PwPlanVersion = z.infer<typeof pwPlanVersionSchema>;

/**
 * Input for `plans.pushVersion` — the adapter assigns `id`, the next
 * `version`, and `pushedAt` (append-only versioning, database.md §2).
 */
export const pwPlanVersionInputSchema = pwPlanVersionSchema.omit({
  id: true,
  version: true,
  pushedAt: true,
});
export type PwPlanVersionInput = z.infer<typeof pwPlanVersionInputSchema>;

// ── pw_subscriptions ─────────────────────────────────────────────────────────

/**
 * `pw_subscriptions` row — one active row per (customer, group)
 * (database.md §2). The default plan produces NO subscription row; "customer
 * is on `free`" is computed at read time.
 *
 * NOTE(spec §2 vs plans-and-features.md §11): `provider` and
 * `providerSubscriptionRef` are nullable here although §2's column list does
 * not mark them `?` — a free (non-default) plan is "recorded locally, no
 * provider object" (§11), so a local activation has no provider ref to store.
 */
export const pwSubscriptionSchema = z.object({
  id: pwIdSchema,
  /** FK → `pw_customers.id` (the `pwv_` id, NOT your external id). */
  customerId: pwIdSchema,
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  group: z.string().min(1),
  status: pwSubscriptionStatusSchema,
  provider: z.string().min(1).nullable(),
  providerSubscriptionRef: z.string().min(1).nullable(),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  cancelAtPeriodEnd: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PwSubscription = z.infer<typeof pwSubscriptionSchema>;

/** Input for `subscriptions.create` — the adapter assigns `id` + timestamps. */
export const pwSubscriptionInputSchema = pwSubscriptionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type PwSubscriptionInput = z.infer<typeof pwSubscriptionInputSchema>;

/**
 * Patch for `subscriptions.update`. A subscription never moves across
 * customers or groups — plan changes patch `planId`/`planVersion`/`status`
 * and period bounds on the SAME row.
 */
export const pwSubscriptionPatchSchema = pwSubscriptionInputSchema
  .omit({ customerId: true, group: true })
  .partial();
export type PwSubscriptionPatch = z.infer<typeof pwSubscriptionPatchSchema>;

// ── pw_feature_balances ──────────────────────────────────────────────────────

/**
 * `pw_feature_balances` row — metered usage state with lazy reset
 * (database.md §2, metered-usage.md §5). Unique per
 * (`customerId`, `featureId`, `group`).
 *
 * `used` is a plain integer, NOT non-negative: unconditional `consume` (the
 * `report` path) may push a balance below zero by design (metered-usage.md
 * §6). All period math derives from `anchor` — never from a previously
 * computed (clamped) `periodStart` (metered-usage.md §5).
 */
export const pwFeatureBalanceSchema = z.object({
  id: pwIdSchema,
  /** FK → `pw_customers.id`. */
  customerId: pwIdSchema,
  featureId: z.string().min(1),
  group: z.string().min(1),
  used: z.number().int(),
  limit: z.number().int().nonnegative(),
  resetInterval: pwResetIntervalSchema,
  /** Billing-cycle anchor — the origin of ALL period arithmetic. */
  anchor: z.date(),
  periodStart: z.date(),
  periodEnd: z.date(),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  updatedAt: z.date(),
});
export type PwFeatureBalance = z.infer<typeof pwFeatureBalanceSchema>;

/**
 * Row template for `balances.consume`'s lazy creation and for
 * `balances.resetTo` (plan changes). Only the underivable fields: the adapter
 * derives `used` (starts at 0), the current `periodStart`/`periodEnd` (from
 * `anchor` + `resetInterval` + `now`, metered-usage.md §5), and `updatedAt`.
 */
export const pwFeatureBalanceInitSchema = z.object({
  limit: z.number().int().nonnegative(),
  resetInterval: pwResetIntervalSchema,
  anchor: z.date(),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
});
export type PwFeatureBalanceInit = z.infer<typeof pwFeatureBalanceInitSchema>;

// ── pw_webhook_events ────────────────────────────────────────────────────────

/**
 * `pw_webhook_events` row — the idempotency gate for `event.apply()`
 * (database.md §2). `dedupeKey` is the primary key (a natural key, not a
 * `pwv_` id); `claimedAt`/`appliedAt` drive the once-only + stale-claim
 * semantics of `webhookEvents.claim`.
 */
export const pwWebhookEventSchema = z.object({
  dedupeKey: z.string().min(1),
  provider: z.string().min(1),
  type: z.string().min(1),
  receivedAt: z.date(),
  claimedAt: z.date().nullable(),
  appliedAt: z.date().nullable(),
});
export type PwWebhookEvent = z.infer<typeof pwWebhookEventSchema>;

// ── pw_migrations ────────────────────────────────────────────────────────────

/**
 * `pw_migrations` row — migration ledger for SQL adapters (database.md §2).
 * `name` is the primary key; a checksum mismatch on an applied migration
 * fails loudly (never re-run mutated history — database.md §4).
 */
export const pwMigrationRecordSchema = z.object({
  name: z.string().min(1),
  appliedAt: z.date(),
  checksum: z.string().min(1),
});
export type PwMigrationRecord = z.infer<typeof pwMigrationRecordSchema>;
