/**
 * The `DatabaseAdapter` contract (docs/v1/database.md §3, PW-701) — the ONLY
 * interface core/billing code may touch. No SQL outside adapters.
 *
 * First-party adapters (PW-704+) live under `payweave/db/*` subpaths with
 * their drivers as optional peerDependencies; anything that
 * satisfies this contract — and passes the conformance suite in
 * `test/db/conformance.ts` — can be a community adapter.
 *
 * The interface is hand-written because its members are functions; every DATA
 * shape it exchanges (`PwCustomer`, `PwPlanVersion`, …) is `z.infer` of the
 * row schemas in `./schema`, which remain the source of truth.
 *
 * Public as the `payweave/db` subpath since PW-505.
 */
import type {
  PwCustomer,
  PwCustomerUpsert,
  PwFeatureBalance,
  PwFeatureBalanceInit,
  PwPlanVersion,
  PwPlanVersionInput,
  PwSubscription,
  PwSubscriptionInput,
  PwSubscriptionPatch,
} from "./schema";

export {
  PW_TABLE_PREFIX,
  PW_TABLES,
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  DEFAULT_STALE_CLAIM_AFTER_MS,
  pwIdSchema,
  pwSubscriptionStatusSchema,
  pwResetIntervalSchema,
  pwPriceIntervalSchema,
  pwCustomerSchema,
  pwCustomerUpsertSchema,
  pwFeatureInclusionSchema,
  pwPlanVersionSchema,
  pwPlanVersionInputSchema,
  pwSubscriptionSchema,
  pwSubscriptionInputSchema,
  pwSubscriptionPatchSchema,
  pwFeatureBalanceSchema,
  pwFeatureBalanceInitSchema,
  pwWebhookEventSchema,
  pwMigrationRecordSchema,
} from "./schema";
export type {
  PwTableName,
  PwSubscriptionStatus,
  PwResetInterval,
  PwPriceInterval,
  PwCustomer,
  PwCustomerUpsert,
  PwFeatureInclusion,
  PwPlanVersion,
  PwPlanVersionInput,
  PwSubscription,
  PwSubscriptionInput,
  PwSubscriptionPatch,
  PwFeatureBalance,
  PwFeatureBalanceInit,
  PwWebhookEvent,
  PwMigrationRecord,
} from "./schema";

/**
 * Storage dialects of the first-party adapters. Community adapters may use
 * any other string — `DatabaseAdapter["dialect"]` stays open.
 */
export type PwKnownDialect = "postgres" | "mysql" | "sqlite" | "prisma" | "drizzle" | "mongodb";

/**
 * The database contract every adapter implements.
 *
 * Concurrency is part of the contract, not an implementation detail:
 * `balances.consume` and `webhookEvents.claim` MUST be atomic under parallel
 * calls — the conformance suite races them and requires
 * zero lost updates, zero double-resets, and once-only claims.
 */
export interface DatabaseAdapter {
  /**
   * Storage dialect identifier. First-party values are {@link PwKnownDialect};
   * the `(string & Record<never, never>)` arm keeps the union open for
   * community adapters without collapsing the literals (spec spelling:
   * `(string & {})`).
   */
  readonly dialect: PwKnownDialect | (string & Record<never, never>);

  /** `pw_customers` — maps your user ids to per-provider customer ids. */
  customers: {
    getByExternalId(externalId: string): Promise<PwCustomer | null>;
    /** Insert-or-update keyed by `externalId`; idempotent (same logical row, same id). */
    upsert(input: PwCustomerUpsert): Promise<PwCustomer>;
    /** Merge `{ [provider]: ref }` into `providerIds` without clobbering other providers. */
    linkProviderRef(externalId: string, provider: string, ref: string): Promise<void>;
  };

  /** `pw_plans` — immutable, append-only plan versions pushed from config. */
  plans: {
    /** Highest pushed version for `planId`, or `null` before any push. */
    getActiveVersion(planId: string): Promise<PwPlanVersion | null>;
    /** The active (highest) version of every pushed plan id. */
    listActive(): Promise<PwPlanVersion[]>;
    /**
     * Append-only push: no-op returning the active version when its content
     * hash is unchanged; otherwise appends `version + 1`. NEVER mutates or
     * deletes an existing (`planId`, `version`) row.
     */
    pushVersion(plan: PwPlanVersionInput): Promise<PwPlanVersion>;
  };

  /** `pw_subscriptions` — one active row per (customer, group). */
  subscriptions: {
    /**
     * The (customer, group) row whose status is in
     * {@link PW_ACTIVE_SUBSCRIPTION_STATUSES} (`active`/`past_due`/`trialing`)
     * — the same set the partial unique index covers — or `null`.
     */
    getActive(customerId: string, group: string): Promise<PwSubscription | null>;
    /**
     * Rejects when an active-set row already exists for (customer, group) —
     * the partial-unique rule is enforced by storage, not by callers.
     */
    create(input: PwSubscriptionInput): Promise<PwSubscription>;
    update(id: string, patch: PwSubscriptionPatch): Promise<PwSubscription>;
  };

  /** `pw_feature_balances` — metered usage state (lazy reset). */
  balances: {
    get(customerId: string, featureId: string, group: string): Promise<PwFeatureBalance | null>;
    /**
     * THE hot path. Atomically: lazy-reset the period if expired (`now >=
     * periodEnd` — periods are half-open, so the reset jumps to the CURRENT
     * anchor-relative window per metered-usage.md §5), then decrement by
     * `amount` (0 = peek/check, which always "applies"). Single statement or
     * transaction — see database.md §5; never a read-modify-write across
     * statements without a lock. Returns the post-operation balance snapshot
     * plus whether the decrement applied.
     *
     * `now` is caller-injected (testability); passing a `now` earlier than
     * the row's current `periodStart` is unspecified behavior.
     */
    consume(input: {
      customerId: string;
      featureId: string;
      group: string;
      amount: number;
      /**
       * true → gated decrement: apply only when remaining balance ≥ amount,
       * otherwise leave the row untouched and return `applied: false` (drives
       * `check({ consume: true })`). false/omitted → unconditional decrement;
       * balance may go negative (drives `report`). Same atomicity either way.
       */
      conditional?: boolean;
      /**
       * Row template used when no balance row exists yet (default-plan lazy
       * creation). Ignored when the row already exists — it is a creation
       * template, not a patch.
       */
      init: PwFeatureBalanceInit;
      now: Date;
    }): Promise<PwFeatureBalance & { applied: boolean }>;
    /** Plan changes: replace limits/plan/anchor from `init` and zero `used`. */
    resetTo(
      customerId: string,
      featureId: string,
      group: string,
      init: PwFeatureBalanceInit,
    ): Promise<void>;
  };

  /** `pw_webhook_events` — the idempotency gate for `event.apply()`. */
  webhookEvents: {
    /**
     * Claim an event for application. true = the caller owns it and MUST
     * apply side effects; false = already applied or freshly claimed
     * elsewhere. Returns true for (a) first sight, or (b) a STALE claim — an
     * existing row with `appliedAt` null whose claim age satisfies
     * `now - claimedAt >= staleClaimAfterMs` (default
     * {@link DEFAULT_STALE_CLAIM_AFTER_MS} = 60_000; strictly younger claims
     * are NEVER stealable). This makes claimed-but-never-applied events
     * (process crashed between claim and markApplied) re-claimable on
     * provider redelivery instead of silently dropped. A successful steal
     * refreshes `claimedAt` to `now`. Acquisition is atomic (insert-or-steal
     * in one statement).
     */
    claim(
      dedupeKey: string,
      meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
    ): Promise<boolean>;
    /** Terminal: an applied dedupe key is never re-claimable. */
    markApplied(dedupeKey: string): Promise<void>;
  };

  /** Migration ledger + runner. */
  migrations: {
    status(): Promise<{ pending: string[]; applied: string[] }>;
    /**
     * Prisma/Drizzle adapters never shell out — they return `applied: []`
     * plus `instructions` telling the user what to run;
     * SQL/Mongo adapters apply for real and omit `instructions`.
     */
    apply(): Promise<{ applied: string[]; instructions?: string }>;
  };

  /**
   * Run `fn` inside a transaction where the adapter supports one; otherwise
   * the adapter documents its fallback (e.g. MongoDB standalone runs the
   * single-document atomic paths without multi-document rollback).
   */
  transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;
}

// ── Derived helper types (adapter authors + conformance suite) ──────────────
// Derived from the interface rather than re-declared, so they can never drift.

/** Input accepted by {@link DatabaseAdapter.balances.consume}. */
export type PwConsumeInput = Parameters<DatabaseAdapter["balances"]["consume"]>[0];

/** Post-operation snapshot returned by {@link DatabaseAdapter.balances.consume}. */
export type PwConsumeResult = Awaited<ReturnType<DatabaseAdapter["balances"]["consume"]>>;

/** Metadata accepted by {@link DatabaseAdapter.webhookEvents.claim}. */
export type PwClaimMeta = Parameters<DatabaseAdapter["webhookEvents"]["claim"]>[1];

/** Result of {@link DatabaseAdapter.migrations.status}. */
export type PwMigrationStatus = Awaited<ReturnType<DatabaseAdapter["migrations"]["status"]>>;

/** Result of {@link DatabaseAdapter.migrations.apply}. */
export type PwMigrationApplyResult = Awaited<ReturnType<DatabaseAdapter["migrations"]["apply"]>>;
