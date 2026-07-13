/**
 * `event.apply()` — webhook → billing state (plans-and-features.md §11.3/§11.5,
 * unified-config.md §5, database.md §2–§3, PW-805). Mirrors `subscribe.ts`'s/
 * `usage.ts`'s "non-generic module, generic facade" split with `src/index.ts`
 * — this file never imports `../index` (avoids a circular import back into
 * the facade) and, like those two, is written ONCE against the
 * `DatabaseAdapter` contract (`../db/index`) — no new provider HTTP calls, no
 * DB contract changes.
 *
 * `webhooks/index.ts`'s `constructEvent` attaches `.apply` to every
 * `WebhookEvent` it returns; this module is what that closure calls.
 *
 * ── The idempotency gate (database.md §3, unified-config.md §5) ────────────
 * `webhookEvents.claim(dedupeKey, …)` IS the entire idempotency mechanism — no
 * second dedupe layer here. `claim` → `false` means an identical
 * (`dedupeKey`) event already applied, or another caller is mid-apply right
 * now: `apply()` returns `{ applied: false, skipped: "already-applied" }`
 * without touching billing state. `claim` + the state mutation + `markApplied`
 * all run inside ONE `database.transaction(fn)` call (database.md §2 design
 * rule 4: "claim + side effects + markApplied run in ONE transaction so a
 * failed apply rolls the claim back") — an adapter with real transactions
 * (the sqlite adapter's `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, PW-706) makes a
 * thrown error immediately re-claimable, never waiting out
 * `staleClaimAfterMs`; an adapter without one falls back to exactly the
 * stale-claim story database.md §2 documents. This also gives "local"
 * idempotency for free (§ AC "calling it twice on the same event object in
 * one process applies once"): the second call's `claim()` sees the
 * already-applied row and returns `false` — no separate in-process latch
 * needed.
 *
 * ── Correlating an event back to a `pw_subscriptions` row ───────────────────
 * The `DatabaseAdapter` contract exposes exactly two subscription reads:
 * `getActive(customerId, group)` (the active-SET statuses only —
 * `active`/`past_due`/`trialing`) and nothing keyed by id or by provider
 * reference (database.md §3; adding one is out of this ticket's file scope —
 * `../db/index` is forbidden territory here). Every correlation this module
 * does rides data the EVENT ITSELF carries, per `subscribe.ts`'s own "seams
 * left for PW-805" doc comment:
 *
 * - Stripe: `data.object.client_reference_id` and/or `data.object.metadata.
 *   pwv_reference` name the local row id directly (set on the Checkout
 *   Session by `subscribe.ts`); `data.object.metadata.pwv_customer`/
 *   `pwv_plan` name the local customer row id / config plan id (SAME
 *   session-level `metadata` object — `subscribe.ts` sets all three keys
 *   together, https://docs.stripe.com/api/checkout/sessions/object
 *   `metadata`/`client_reference_id`).
 * - Paystack: `data.reference` (echoed back verbatim from `transactions.
 *   initialize`'s own `reference`, https://paystack.com/docs/api/transaction/
 *   #initialize) and/or `data.metadata.pwv_reference`/`pwv_customer`/
 *   `pwv_plan` (same echo).
 *
 * KNOWN LIMITATION (flagged per AGENTS.md §8, not fixed here —
 * `subscribe.ts` is this ticket's forbidden/read-only territory): Stripe
 * session-level `metadata` is NOT copied onto the Subscription object Stripe
 * creates from that checkout (only an explicit `subscription_data.metadata`
 * at session-creation time would be — a `subscribe.ts` change, out of scope).
 * So today, a bare `customer.subscription.updated`/`.deleted` event for
 * STRIPE that carries no `pwv_*` metadata of its own cannot be correlated to a
 * row by metadata; this module still resolves it via the (`pwv_customer`,
 * `pwv_plan`) → `getActive(customerId, group)` path WHEN that metadata IS
 * present (Paystack already echoes it; a future `subscribe.ts` revision that
 * adds `subscription_data.metadata` would make Stripe's lifecycle events
 * resolvable the same way) and otherwise treats the event as `"unresolved"` —
 * a safe no-op, never a guess at the wrong row (the conservative reading,
 * AGENTS.md §8).
 *
 * ── Out-of-order guard (backlog PW-805 AC) ──────────────────────────────────
 * `subscription.*`/`invoice.*` events can arrive out of send order (provider
 * redelivery, network reordering). Two protections, both keyed off the
 * CURRENTLY STORED row (read via `getActive` before writing — the FIRST
 * `incomplete → active` activation has no prior "real" state to protect and
 * is exempt, see {@link applyActivation}):
 * 1. A row already OUTSIDE the active set (i.e. `canceled`) is invisible to
 *    `getActive` — a late `subscription.updated` after `subscription.canceled`
 *    therefore finds no row at all and safely no-ops (`"unresolved"`) rather
 *    than resurrecting it.
 * 2. Within the active set, period fields only move FORWARD: an event whose
 *    period end is EARLIER than the row's current `currentPeriodEnd` is
 *    treated as stale redelivery and skipped (`"stale"`) — status/other
 *    fields are not touched either, so a late event never partially regresses
 *    a row a newer event already advanced.
 *
 * ── PW-903 seam: plan-change balance reset ──────────────────────────────────
 * `subscription.updated` events tell us the row's *current* plan via the same
 * `pwv_plan` metadata used for correlation. When it differs from the stored
 * row's `planId`, that's a genuine plan change (`pw_subscriptions.planId` is
 * patchable — `database.md §3`'s patch schema explicitly allows it): this
 * module patches `planId`/`planVersion` on the row AND calls
 * {@link resetBalancesForPlanChange} for every METERED feature the new plan
 * includes, zeroing `used` and re-seeding `limit`/`resetInterval`/`anchor`
 * from the new plan (`balances.resetTo`, database.md §3). PW-903 owns the
 * conformance scenario for this; {@link resetBalancesForPlanChange} is
 * exported standalone so it can also be called/wired directly there.
 */
import { PayweaveConfigError } from "../core/errors";
import type { Logger } from "../core/logger";
import type { DatabaseAdapter, PwFeatureBalanceInit, PwSubscription, PwSubscriptionPatch } from "../db/index";
import type { ResolvedProduct } from "../core/config";
import { resolvePlanGroup, type BillingContext } from "./subscribe";
import type { WebhookProvider } from "../webhooks/index";

/**
 * Everything {@link applyWebhookEvent} needs out of `createPayweave`'s
 * resolved config — a slice of {@link BillingContext} (only `database` +
 * `products` are ever touched; `subscribe`/`check`/`report`'s wider context
 * carries provider clients this module never calls). `src/index.ts` passes
 * the SAME `billingContext` object it already builds for PW-804/PW-902 —
 * structurally compatible, so no new object is constructed there.
 */
export type BillingApplyContext = Pick<BillingContext, "database" | "products">;

/**
 * The slice of a constructed `WebhookEvent` (`../webhooks/index`) this module
 * needs. Deliberately NOT the full interface — `WebhookEvent.apply` itself
 * closes over one of these, so the full type (which carries `apply`) would be
 * circular to construct from inside `constructEvent`.
 */
export interface WebhookEventForApply {
  readonly provider: WebhookProvider;
  readonly type: string;
  readonly unifiedType: string;
  readonly data: unknown;
  readonly dedupeKey: string;
}

/** Why {@link ApplyResult.applied} is `false`. Absent when `applied` is `true`. */
export type ApplySkipReason = "already-applied" | "unmapped" | "unresolved" | "stale";

/** Result of one {@link applyWebhookEvent} call. */
export interface ApplyResult {
  /** `true` only when this call performed the state mutation. */
  applied: boolean;
  skipped?: ApplySkipReason;
  /** The mutated row, when `applied` is `true`; `undefined` otherwise. */
  subscription?: PwSubscription;
}

/** Options accepted by {@link applyWebhookEvent} (and, minus `logger`, by `WebhookEvent.apply`). */
export interface ApplyOptions {
  /** Injected clock — testability (fake redelivery timing, out-of-order fixtures). Default `new Date()`. */
  now?: Date | undefined;
  /** Optional injected logger for drift reporting (never `console.*`). */
  logger?: Logger | undefined;
}

// ── Small, provider-agnostic payload readers ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numberField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolField(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = obj?.[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Stripe's nested resource (`data.object`, https://docs.stripe.com/api/events/object) — `undefined` for every other provider's flat `data`. */
function stripeObject(event: WebhookEventForApply): Record<string, unknown> | undefined {
  /* istanbul ignore next -- defensive: every call site already gates on `event.provider === "stripe"` first. */
  if (event.provider !== "stripe") return undefined;
  return asRecord(asRecord(event.data)?.object);
}

/** The flat `data` object every non-Stripe provider uses. */
function flatData(event: WebhookEventForApply): Record<string, unknown> | undefined {
  /* istanbul ignore next -- defensive: every call site already gates on `event.provider !== "stripe"` first. */
  return event.provider === "stripe" ? undefined : asRecord(event.data);
}

// ── Correlation (module doc comment above) ──────────────────────────────────

/** What we could learn about which local row this event concerns. */
interface Correlation {
  /** The `pw_subscriptions.id` `subscribe()` stamped onto the event (rowId-level correlation). */
  rowId: string | undefined;
  /** The `pw_customers.id` `subscribe()` stamped onto the event. */
  customerId: string | undefined;
  /** The config plan id the event concerns (correlation AND, on updates, plan-change detection). */
  planId: string | undefined;
  /** The provider's own subscription reference, when the event carries one. */
  providerSubscriptionRef: string | undefined;
}

function resolveCorrelation(event: WebhookEventForApply): Correlation {
  if (event.provider === "stripe") {
    const obj = stripeObject(event);
    const meta = asRecord(obj?.metadata);
    const rowId = stringField(obj, "client_reference_id") ?? stringField(meta, "pwv_reference");
    // Checkout Session: `subscription` is the created Subscription's id
    // (string, unexpanded — https://docs.stripe.com/api/checkout/sessions/object).
    // A Subscription event's OWN `id` IS that reference.
    const providerSubscriptionRef =
      stringField(obj, "subscription") ??
      (stringField(obj, "object") === "subscription" ? stringField(obj, "id") : undefined);
    return {
      rowId,
      customerId: stringField(meta, "pwv_customer"),
      planId: stringField(meta, "pwv_plan"),
      providerSubscriptionRef,
    };
  }
  const data = flatData(event);
  const meta = asRecord(data?.metadata);
  return {
    rowId: stringField(data, "reference") ?? stringField(meta, "pwv_reference"),
    customerId: stringField(meta, "pwv_customer"),
    planId: stringField(meta, "pwv_plan"),
    providerSubscriptionRef: stringField(data, "subscription_code"),
  };
}

function resolveGroupForPlanId(ctx: BillingApplyContext, planId: string): ResolvedProduct | undefined {
  return ctx.products?.find((p) => p.id === planId);
}

/**
 * Find the row a lifecycle event concerns via `getActive(customerId, group)`
 * — the ONLY id-free read the `DatabaseAdapter` contract exposes (module doc
 * comment). Returns `null` when the correlation metadata is absent OR the
 * row genuinely isn't in the active set right now (already canceled — the
 * out-of-order protection, not a bug).
 */
async function findActiveRow(
  tx: DatabaseAdapter,
  ctx: BillingApplyContext,
  correlation: Correlation,
): Promise<PwSubscription | null> {
  if (!correlation.customerId || !correlation.planId) return null;
  const plan = resolveGroupForPlanId(ctx, correlation.planId);
  if (!plan) return null;
  return tx.subscriptions.getActive(correlation.customerId, resolvePlanGroup(plan));
}

// ── Period extraction (CRITICAL finding: Stripe period lives on subscription ITEMS) ──

interface ExtractedPeriod {
  /** `undefined` when the event's shape carries no derivable period start (module doc comment — Paystack). */
  start: Date | undefined;
  end: Date;
}

function firstListItem(container: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const wrapper = asRecord(container?.[key]);
  const list = wrapper?.data;
  return Array.isArray(list) && list.length > 0 ? asRecord(list[0]) : undefined;
}

function periodFromUnixSeconds(start: number | undefined, end: number | undefined): ExtractedPeriod | undefined {
  if (end === undefined) return undefined;
  return { start: start !== undefined ? new Date(start * 1000) : undefined, end: new Date(end * 1000) };
}

/**
 * Read the real billing period off an event's payload, per provider/shape.
 * Stripe: a Subscription-shaped `data.object` (subscription.created/updated)
 * carries it on `items.data[0].current_period_start/end` — NOT on the
 * subscription itself on the pinned API version
 * (https://docs.stripe.com/api/subscriptions/object, CRITICAL finding (c));
 * an Invoice-shaped `data.object` (invoice.paid/payment_failed) carries the
 * equivalent on `lines.data[0].period.start/end`
 * (https://docs.stripe.com/api/invoices/object). A Checkout-Session-shaped
 * `data.object` (checkout.session.completed) carries neither — `undefined`,
 * which callers treat as "no period info on THIS event" rather than an error.
 * Paystack: no start/end period exists anywhere in the API — only
 * `next_payment_date` (the CURRENT cycle's end,
 * https://paystack.com/docs/api/subscription/, the exact field already
 * modeled by `src/paystack/schemas/plans.ts`'s `subscription` schema) — the
 * period START is left `undefined` for the caller to derive conservatively
 * (see {@link resolvePeriodStart}).
 */
function extractPeriod(event: WebhookEventForApply): ExtractedPeriod | undefined {
  if (event.provider === "stripe") {
    const obj = stripeObject(event);
    const item = firstListItem(obj, "items");
    if (item) {
      const period = periodFromUnixSeconds(
        numberField(item, "current_period_start"),
        numberField(item, "current_period_end"),
      );
      if (period) return period;
    }
    const line = firstListItem(obj, "lines");
    if (line) {
      const period = asRecord(line.period);
      const derived = periodFromUnixSeconds(numberField(period, "start"), numberField(period, "end"));
      if (derived) return derived;
    }
    return undefined;
  }
  const data = flatData(event);
  const nextPaymentDate = stringField(data, "next_payment_date");
  if (!nextPaymentDate) return undefined;
  const end = new Date(nextPaymentDate);
  if (Number.isNaN(end.getTime())) return undefined;
  return { start: undefined, end };
}

/**
 * Fill in an `undefined` period start conservatively: contiguous with the
 * stored row when possible, else `now`. Both call sites only reach this AFTER
 * {@link isStalePeriod} already confirmed `period.end >= currentRow.
 * currentPeriodEnd` for the SAME row, so the `now` fallback below is a
 * defensive backstop (a `null` `currentRow`, or the contiguity check somehow
 * failing despite that invariant) rather than a reachable outcome today.
 */
function resolvePeriodStart(period: ExtractedPeriod, currentRow: PwSubscription | null, now: Date): Date {
  if (period.start) return period.start;
  if (currentRow && currentRow.currentPeriodEnd.getTime() <= period.end.getTime()) {
    return currentRow.currentPeriodEnd;
  }
  /* istanbul ignore next -- defensive backstop, see the doc comment above. */
  return now;
}

/** `true` when `period` is strictly OLDER than what `currentRow` already stores — the out-of-order guard. */
function isStalePeriod(period: ExtractedPeriod | undefined, currentRow: PwSubscription): boolean {
  return period !== undefined && period.end.getTime() < currentRow.currentPeriodEnd.getTime();
}

// ── Status/flag mapping (spec-silent — providers.md §3.5 names the unified event, not every native status string) ──

/**
 * Stripe Subscription `status` → `pw_subscriptions.status`
 * (https://docs.stripe.com/api/subscriptions/object, verified 2026-07-13).
 * `unpaid`/`paused` are dunning-adjacent, non-terminal states — closest local
 * analog is `past_due` (still billing-relevant, not yet given up on);
 * `incomplete_expired` never became a real subscription — closest analog is
 * `canceled` (nothing to keep active). `subscription.canceled` (the
 * `customer.subscription.deleted` event) always forces `"canceled"` directly
 * rather than trusting this table (see {@link applyCancellation}).
 */
const STRIPE_SUBSCRIPTION_STATUS_MAP: Readonly<Record<string, PwSubscriptionPatch["status"]>> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "past_due",
  paused: "past_due",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
};

/**
 * Paystack subscription `status` → `pw_subscriptions.status` (the same
 * `subscription` schema's `status: z.string()`,
 * `src/paystack/schemas/plans.ts`). `non-renewing` stays `active` (still
 * billing normally until the period ends — `cancelAtPeriodEnd` carries the
 * "won't renew" signal separately, see {@link extractCancelAtPeriodEnd});
 * `attention` (a failed-charge/needs-attention state) maps to `past_due`.
 */
const PAYSTACK_SUBSCRIPTION_STATUS_MAP: Readonly<Record<string, PwSubscriptionPatch["status"]>> = {
  active: "active",
  "non-renewing": "active",
  attention: "past_due",
  completed: "canceled",
  cancelled: "canceled",
};

function mapNativeStatus(event: WebhookEventForApply): PwSubscriptionPatch["status"] | undefined {
  if (event.provider === "stripe") {
    return STRIPE_SUBSCRIPTION_STATUS_MAP[stringField(stripeObject(event), "status") ?? ""];
  }
  if (event.provider === "paystack") {
    return PAYSTACK_SUBSCRIPTION_STATUS_MAP[stringField(flatData(event), "status") ?? ""];
  }
  // `unified/mappings.ts`'s FLUTTERWAVE_EVENT_MAP maps nothing to
  // `subscription.created`/`.updated` (only `.cancelled`, PW-607's own doc
  // comment) — this function is only ever called for those two unified
  // types, so a Flutterwave event never reaches it in practice today.
  /* istanbul ignore next -- defensive: unreachable given the current unified mapping tables. */
  return undefined;
}

/** Stripe's `cancel_at_period_end`; Paystack's `subscription.not_renew` native event (no boolean field — the event name IS the signal). */
function extractCancelAtPeriodEnd(event: WebhookEventForApply): boolean | undefined {
  if (event.provider === "stripe") return boolField(stripeObject(event), "cancel_at_period_end");
  if (event.provider === "paystack" && event.type === "subscription.not_renew") return true;
  return undefined;
}

// ── PW-903 seam ──────────────────────────────────────────────────────────────

/**
 * Reset every METERED feature `plan` includes for `customerId`/`group` to the
 * plan's own limits (database.md §3 `balances.resetTo` — "plan changes").
 * Exported standalone (not just called from {@link applyWebhookEvent}) so
 * PW-903's conformance scenario can wire/call it directly too — the hook this
 * ticket is asked to provide.
 */
export async function resetBalancesForPlanChange(
  database: DatabaseAdapter,
  params: {
    customerId: string;
    group: string;
    plan: ResolvedProduct;
    planVersion: number;
    anchor: Date;
  },
): Promise<void> {
  for (const inclusion of params.plan.includes) {
    if (inclusion.type !== "metered") continue;
    const init: PwFeatureBalanceInit = {
      limit: inclusion.limit,
      resetInterval: inclusion.reset,
      anchor: params.anchor,
      planId: params.plan.id,
      planVersion: params.planVersion,
    };
    await database.balances.resetTo(params.customerId, inclusion.featureId, params.group, init);
  }
}

// ── The three state-mutating branches ───────────────────────────────────────

/** `payment.succeeded` / `invoice.paid` (§11.3): flip an `incomplete` row to `active`, or refresh an already-active row's real period on renewal. */
async function applyActivation(
  tx: DatabaseAdapter,
  ctx: BillingApplyContext,
  event: WebhookEventForApply,
  now: Date,
): Promise<ApplyResult> {
  const correlation = resolveCorrelation(event);
  const period = extractPeriod(event);
  const activeRow = await findActiveRow(tx, ctx, correlation);

  if (activeRow) {
    // Renewal on an already-active row — the out-of-order guard applies here
    // (this is NOT the first activation).
    if (isStalePeriod(period, activeRow)) return { applied: false, skipped: "stale" };
    const patch: PwSubscriptionPatch = { status: "active" };
    if (correlation.providerSubscriptionRef) patch.providerSubscriptionRef = correlation.providerSubscriptionRef;
    if (period) {
      patch.currentPeriodStart = resolvePeriodStart(period, activeRow, now);
      patch.currentPeriodEnd = period.end;
    }
    const updated = await tx.subscriptions.update(activeRow.id, patch);
    return { applied: true, subscription: updated };
  }

  // No active-set row found for this correlation — the expected shape for the
  // FIRST activation of the `incomplete` row `subscribe()` created (`incomplete`
  // is outside the active set by design, database.md §2). Resolve it via the
  // row id `subscribe()` left on the event (module doc comment). No guard: an
  // `incomplete` row's period is only ever `subscribe()`'s nominal placeholder
  // (`subscribe.ts`'s `nominalPeriod`), so there is no "real" prior state to
  // protect against regression.
  if (!correlation.rowId) return { applied: false, skipped: "unresolved" };
  const patch: PwSubscriptionPatch = { status: "active" };
  if (correlation.providerSubscriptionRef) patch.providerSubscriptionRef = correlation.providerSubscriptionRef;
  if (period) {
    patch.currentPeriodStart = period.start ?? now;
    patch.currentPeriodEnd = period.end;
  }
  const updated = await tx.subscriptions.update(correlation.rowId, patch);
  return { applied: true, subscription: updated };
}

/**
 * `subscription.created`/`subscription.updated`/`subscription.canceled`/
 * `invoice.payment_failed` (§11.3/§11.5): update an already-active row.
 * `forcedStatus` pins the target status for the events whose UNIFIED TYPE
 * alone is authoritative (`canceled`, `payment_failed`) regardless of
 * whatever native `status` string the payload carries; `undefined` (plain
 * `subscription.created`/`.updated`) reads the real status via
 * {@link mapNativeStatus}.
 */
async function applyLifecycleUpdate(
  tx: DatabaseAdapter,
  ctx: BillingApplyContext,
  event: WebhookEventForApply,
  now: Date,
  forcedStatus: PwSubscriptionPatch["status"] | undefined,
  allowPlanChange: boolean,
  logger: Logger | undefined,
): Promise<ApplyResult> {
  const correlation = resolveCorrelation(event);
  const row = await findActiveRow(tx, ctx, correlation);
  if (!row) {
    logger?.({
      type: "schema_drift",
      message:
        "billing apply: could not correlate a subscription lifecycle event to a local row — safe no-op.",
      provider: event.provider,
      nativeType: event.type,
      unifiedType: event.unifiedType,
    });
    return { applied: false, skipped: "unresolved" };
  }

  const period = extractPeriod(event);
  if (isStalePeriod(period, row)) return { applied: false, skipped: "stale" };

  const patch: PwSubscriptionPatch = {};
  const status = forcedStatus ?? mapNativeStatus(event);
  if (status) patch.status = status;
  if (period) {
    patch.currentPeriodStart = resolvePeriodStart(period, row, now);
    patch.currentPeriodEnd = period.end;
  }
  const cancelAtPeriodEnd = extractCancelAtPeriodEnd(event);
  if (cancelAtPeriodEnd !== undefined) patch.cancelAtPeriodEnd = cancelAtPeriodEnd;

  // PW-903 seam — a genuine plan change (module doc comment).
  if (allowPlanChange && correlation.planId && correlation.planId !== row.planId) {
    const newPlan = resolveGroupForPlanId(ctx, correlation.planId);
    if (newPlan) {
      const pushed = await tx.plans.getActiveVersion(newPlan.id);
      const planVersion = pushed?.version ?? row.planVersion;
      patch.planId = newPlan.id;
      patch.planVersion = planVersion;
      await resetBalancesForPlanChange(tx, {
        customerId: row.customerId,
        group: row.group,
        plan: newPlan,
        planVersion,
        anchor: patch.currentPeriodStart ?? row.currentPeriodStart,
      });
    }
  }

  if (Object.keys(patch).length === 0) return { applied: false, skipped: "unmapped" };
  const updated = await tx.subscriptions.update(row.id, patch);
  return { applied: true, subscription: updated };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Idempotently apply one webhook event's billing-state transition
 * (unified-config.md §5). Throws {@link PayweaveConfigError} when no
 * `database` is configured — mirrors `subscribe`/`check`/`report`'s "the
 * method always exists, calling it without a database always throws" pattern
 * (`unified-config.md §3`).
 */
export async function applyWebhookEvent(
  ctx: BillingApplyContext,
  event: WebhookEventForApply,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const database = ctx.database;
  if (!database) {
    throw new PayweaveConfigError(
      "event.apply() needs a database — pass a payweave/db/* adapter to createPayweave() " +
        "(unified-config.md §5).",
    );
  }
  const now = options.now ?? new Date();
  const logger = options.logger;

  // Module doc comment: claim + side effects + markApplied run in ONE
  // transaction (database.md §2 design rule 4).
  return database.transaction(async (tx): Promise<ApplyResult> => {
    const claimed = await tx.webhookEvents.claim(event.dedupeKey, {
      provider: event.provider,
      type: event.type,
      now,
    });
    if (!claimed) return { applied: false, skipped: "already-applied" };

    let result: ApplyResult;
    switch (event.unifiedType) {
      case "payment.succeeded":
      case "invoice.paid":
        result = await applyActivation(tx, ctx, event, now);
        break;
      case "subscription.created":
      case "subscription.updated":
        result = await applyLifecycleUpdate(tx, ctx, event, now, undefined, true, logger);
        break;
      case "subscription.canceled":
        result = await applyLifecycleUpdate(tx, ctx, event, now, "canceled", false, logger);
        break;
      case "invoice.payment_failed":
        result = await applyLifecycleUpdate(tx, ctx, event, now, "past_due", false, logger);
        break;
      default:
        // Unmapped/irrelevant (transfers, refunds, disputes, "unknown", …) —
        // ALWAYS a safe no-op; never throw on an unmapped type (backlog
        // PW-805 AC, mirroring `unified/mappings.ts`'s own "never drop, never
        // throw on unmapped" rule).
        result = { applied: false, skipped: "unmapped" };
    }

    // `"unresolved"` is deliberately NOT marked applied (spec-silent decision,
    // AGENTS.md §8): the correlation data an event carries can never change on
    // redelivery of that SAME event, so retrying it is only useful if a LATER
    // apply (e.g. a subsequent event, or `subscribe()` finishing a slightly
    // delayed row write) makes it resolvable — leaving the claim un-applied
    // keeps it re-claimable after `staleClaimAfterMs` instead of silently and
    // permanently dropping an event we never acted on. Every other outcome
    // (a real mutation, `"stale"` — genuinely superseded, never worth another
    // try, or `"unmapped"` — nothing to ever do for this type) is terminal:
    // mark it applied so it never re-triggers this work again.
    if (result.skipped !== "unresolved") {
      await tx.webhookEvents.markApplied(event.dedupeKey);
    }
    return result;
  });
}
