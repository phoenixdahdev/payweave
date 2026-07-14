/**
 * Document ⇄ row mapping for the MongoDB adapter. Documents are the
 * `src/db/schema.ts` row shapes verbatim with `id`
 * stored as `_id` — mapped at the adapter boundary in both directions
 * `pw_webhook_events.dedupeKey` and (conceptually)
 * `pw_migrations.name` are the schema's own documented exceptions to the
 * `pwv_<ulid>` id rule (`src/db/schema.ts`'s `pwIdSchema` doc comment) — for
 * `pw_webhook_events` the natural key IS `_id` directly, no separate `id`
 * field exists on that row type at all.
 *
 * Every mapper reads ONLY the fields it knows about — internal bookkeeping
 * fields the adapter also persists on some documents (`_pwLastApplied` on
 * `pw_feature_balances`, `./adapter.ts`'s doc comment) are never read here,
 * so they can never leak into a `Pw*` row even though they physically live
 * alongside the modeled fields in storage.
 */
import type {
  PwCustomer,
  PwFeatureBalance,
  PwPlanVersion,
  PwSubscription,
  PwWebhookEvent,
} from "../schema";

// ── pw_customers ─────────────────────────────────────────────────────────────

export interface CustomerDoc {
  _id: string;
  externalId: string;
  providerIds: Record<string, string>;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function docToCustomer(doc: CustomerDoc): PwCustomer {
  return {
    id: doc._id,
    externalId: doc.externalId,
    providerIds: doc.providerIds ?? {},
    email: doc.email ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── pw_plans ─────────────────────────────────────────────────────────────────

export interface PlanVersionDoc {
  _id: string;
  planId: string;
  version: number;
  group: string;
  isDefault: boolean;
  name: string | null;
  priceMinor: number | null;
  priceCurrency: string | null;
  priceInterval: string | null;
  features: Record<string, unknown>;
  providerRefs: Record<string, Record<string, string>>;
  pushedAt: Date;
}

export function docToPlanVersion(doc: PlanVersionDoc): PwPlanVersion {
  return {
    id: doc._id,
    planId: doc.planId,
    version: doc.version,
    group: doc.group,
    isDefault: doc.isDefault,
    name: doc.name,
    priceMinor: doc.priceMinor,
    priceCurrency: doc.priceCurrency,
    priceInterval: doc.priceInterval as PwPlanVersion["priceInterval"],
    features: doc.features as PwPlanVersion["features"],
    providerRefs: doc.providerRefs,
    pushedAt: doc.pushedAt,
  };
}

// ── pw_subscriptions ─────────────────────────────────────────────────────────

export interface SubscriptionDoc {
  _id: string;
  customerId: string;
  planId: string;
  planVersion: number;
  group: string;
  status: string;
  provider: string | null;
  providerSubscriptionRef: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function docToSubscription(doc: SubscriptionDoc): PwSubscription {
  return {
    id: doc._id,
    customerId: doc.customerId,
    planId: doc.planId,
    planVersion: doc.planVersion,
    group: doc.group,
    status: doc.status as PwSubscription["status"],
    provider: doc.provider,
    providerSubscriptionRef: doc.providerSubscriptionRef,
    currentPeriodStart: doc.currentPeriodStart,
    currentPeriodEnd: doc.currentPeriodEnd,
    cancelAtPeriodEnd: doc.cancelAtPeriodEnd,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── pw_feature_balances ──────────────────────────────────────────────────────

export interface FeatureBalanceDoc {
  _id: string;
  customerId: string;
  featureId: string;
  group: string;
  used: number;
  limit: number;
  resetInterval: string;
  anchor: Date;
  periodStart: Date;
  periodEnd: Date;
  planId: string;
  planVersion: number;
  updatedAt: Date;
  /** Internal bookkeeping only — never part of {@link PwFeatureBalance}; see `./adapter.ts`. */
  _pwLastApplied?: boolean;
}

export function docToFeatureBalance(doc: FeatureBalanceDoc): PwFeatureBalance {
  return {
    id: doc._id,
    customerId: doc.customerId,
    featureId: doc.featureId,
    group: doc.group,
    used: doc.used,
    limit: doc.limit,
    resetInterval: doc.resetInterval as PwFeatureBalance["resetInterval"],
    anchor: doc.anchor,
    periodStart: doc.periodStart,
    periodEnd: doc.periodEnd,
    planId: doc.planId,
    planVersion: doc.planVersion,
    updatedAt: doc.updatedAt,
  };
}

// ── pw_webhook_events ────────────────────────────────────────────────────────

export interface WebhookEventDoc {
  /** The natural key — `_id` IS `dedupeKey` (schema.ts's documented exception). */
  _id: string;
  provider: string;
  type: string;
  receivedAt: Date;
  claimedAt: Date | null;
  appliedAt: Date | null;
  /** Internal bookkeeping only — never part of {@link PwWebhookEvent}; see `./adapter.ts`. */
  _pwWon?: boolean;
}

export function docToWebhookEvent(doc: WebhookEventDoc): PwWebhookEvent {
  return {
    dedupeKey: doc._id,
    provider: doc.provider,
    type: doc.type,
    receivedAt: doc.receivedAt,
    claimedAt: doc.claimedAt ?? null,
    appliedAt: doc.appliedAt ?? null,
  };
}
