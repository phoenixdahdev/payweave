/**
 * unified/mappings.ts — the single source of truth for webhook + status
 * normalization (unified event names, provider status vocabularies) AND the
 * unified-ops capability matrix.
 *
 * ⚠️ PUBLIC CONTRACT. The `unifiedType` / `UnifiedStatus`
 * vocabularies, the provider→unified mappings, and the capability matrix below
 * are a stable, public contract. Changing their SEMANTICS (renaming a unified
 * value, remapping an existing native event/status to a different unified
 * value, flipping a capability-matrix cell from `true` to `false`) is a
 * breaking change and REQUIRES a `major`/`minor` changeset discussion. ADDING a
 * new native→unified row (so a previously-`unknown` event/status now
 * normalizes) or flipping a capability cell `false` → `true` (a provider
 * gaining an op) is a `minor`. Never DROP a mapping and never throw on an
 * unmapped input — unknown events fall through to `"unknown"`, unknown statuses
 * fall through to `"pending"` plus a `schema_drift` log.
 *
 * Design: data-driven tables keyed by provider (+ version for Flutterwave, whose
 * v3/v4 status vocabularies differ — v3 `successful` vs v4 `succeeded`). The
 * exported normalization functions are pure; an optional `logger` is injected
 * by callers so drift can be surfaced without `console.*`.
 */
import type { Logger } from "../core/logger";
import { PayweaveValidationError, type PayweaveProvider } from "../core/errors";

/**
 * Provider identifier accepted by the mapping functions AND the capability
 * matrix — the full v1 provider set. Identical to {@link PayweaveProvider}
 * but kept as its own alias so this file stays free of a `core/config.ts`
 * dependency.
 */
export type MappingProvider = PayweaveProvider;
/** Flutterwave version selector. `undefined` for Paystack and Stripe (unversioned). */
export type MappingVersion = "v3" | "v4" | undefined;

/**
 * Normalized, provider-agnostic webhook event type. `"unknown"` is a
 * first-class value: unmapped native events are delivered as `"unknown"`, never
 * dropped. `subscription.updated`/`subscription.canceled`/`invoice.paid`/
 * `invoice.payment_failed` are mapped for ALL providers so the vocabulary
 * stays total.
 */
export type UnifiedEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "transfer.succeeded"
  | "transfer.failed"
  | "transfer.reversed"
  | "refund.processed"
  | "subscription.created"
  | "subscription.updated"
  | "subscription.canceled"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "dispute.created"
  | "unknown";

/** Normalized transaction status. */
export type UnifiedStatus = "success" | "failed" | "pending" | "abandoned" | "reversed";

// ── Event-name tables ────────────────────────────────────────────────────────

/**
 * Paystack native webhook event → unified type. Paystack event names are
 * status-independent (a `charge.success` is always a success), so this is a flat
 * lookup. Anything absent → `"unknown"`.
 *
 * `subscription.disable`/`subscription.not_renew`/`invoice.update`/
 * `invoice.payment_failed` verified against
 * https://paystack.com/docs/payments/webhooks/ and
 * https://paystack.com/docs/payments/subscriptions/ (verified 2026-07-12):
 * `subscription.disable` fires both on an explicit cancellation and on the
 * final billing cycle completing — either way the subscription is no longer
 * active, so it normalizes to `subscription.canceled`; `subscription.not_renew`
 * only marks the subscription to stop renewing (it stays active until the
 * period ends), so it normalizes to `subscription.updated`, not `.canceled`.
 * `invoice.update` "will contain the final status of the invoice ... as well as
 * information on the charge if it was successful" and fires only on a
 * successful charge attempt — `invoice.payment_failed` fires "instead" on
 * failure — so `invoice.update` maps unconditionally to `invoice.paid`.
 * `invoice.create` (fired when a new upcoming-charge invoice is created, not a
 * payment result) stays unmapped → `"unknown"` (existing, tested behavior).
 */
export const PAYSTACK_EVENT_MAP: Readonly<Record<string, UnifiedEventType>> = {
  "charge.success": "payment.succeeded",
  "transfer.success": "transfer.succeeded",
  "transfer.failed": "transfer.failed",
  "transfer.reversed": "transfer.reversed",
  "refund.processed": "refund.processed",
  "subscription.create": "subscription.created",
  "subscription.disable": "subscription.canceled",
  "subscription.not_renew": "subscription.updated",
  "invoice.update": "invoice.paid",
  "invoice.payment_failed": "invoice.payment_failed",
  "charge.dispute.create": "dispute.created",
};

/**
 * Flutterwave native webhook events whose unified type SPLITS on the transaction
 * status carried in `data.status` (e.g. `charge.completed` is a success OR a
 * failure depending on the status). Resolved through {@link toUnifiedStatus} so
 * the v3 (`successful`) vs v4 (`succeeded`) vocabulary difference is handled in
 * one place.
 */
export const FLUTTERWAVE_STATUS_SPLIT_MAP: Readonly<
  Record<string, { readonly succeeded: UnifiedEventType; readonly failed: UnifiedEventType }>
> = {
  "charge.completed": { succeeded: "payment.succeeded", failed: "payment.failed" },
  "transfer.completed": { succeeded: "transfer.succeeded", failed: "transfer.failed" },
};

/**
 * Flutterwave native events with a status-independent unified type.
 *
 * Verified 2026-07-12, resolving the standing NOTE(verify):
 * `refund.completed` — https://developer.flutterwave.com/reference/refund_completed_webhook
 * (a dedicated "refund completion" webhook, unconditionally a completed
 * refund, unlike `charge.completed`/`transfer.completed` which cover both
 * outcomes and stay in {@link FLUTTERWAVE_STATUS_SPLIT_MAP}).
 * `subscription.cancelled` — https://developer.flutterwave.com/v3.0/docs/payment-plans-1
 * (sample payload: `"event": "subscription.cancelled"`, `data.status:
 * "deactivated"`); no `subscription.created`/`.updated` native event is
 * documented for FLW v3 (the first `charge.completed` on a payment-plan
 * subscription doubles as both the charge AND the creation signal) — left
 * unmapped rather than invented, per AGENTS.md.
 * `chargeback.initiated` — https://developer.flutterwave.com/v3.0/docs/chargebacks
 * (sample payload `"event": "chargeback.initiated"`); `chargeback.accepted` /
 * `.declined` / `.lost` also exist but have no unified equivalent to map to,
 * so they stay unmapped.
 * No native FLW `invoice.*` webhook event is documented — Flutterwave has no
 * separate invoicing concept on webhooks, so `invoice.paid` /
 * `invoice.payment_failed` have no FLW row (stays `"unknown"`, honestly
 * reflecting the provider gap rather than inventing a name).
 *
 * Shared as-is across v3/v4 (same convention as the rest of this flat map —
 * only STATUS vocabularies, not event NAMES, differ by version).
 */
export const FLUTTERWAVE_EVENT_MAP: Readonly<Record<string, UnifiedEventType>> = {
  "refund.completed": "refund.processed",
  "subscription.cancelled": "subscription.canceled",
  "chargeback.initiated": "dispute.created",
};

/**
 * Stripe native webhook event → unified type, STATUS-INDEPENDENT rows. Event
 * type names verified against https://docs.stripe.com/api/events/types
 * (verified 2026-07-12). Status-DEPENDENT rows
 * (`checkout.session.completed`, `refund.updated`) live in
 * {@link STRIPE_EVENT_STATUS_SPLIT_MAP} — Stripe nests the resource one level
 * down (`data.object`, https://docs.stripe.com/api/events/object), unlike
 * Paystack/Flutterwave's flat `data`, so they can't share this plain lookup.
 * Anything absent from both tables → `"unknown"`.
 *
 * `checkout.session.async_payment_succeeded`/`.async_payment_failed` are
 * ADDITIONS beyond the documented event set, added after verifying
 * https://docs.stripe.com/checkout/fulfillment (2026-07-12): a delayed/async
 * payment method (e.g. a bank debit) can complete a Checkout Session while
 * `payment_status` is still `"unpaid"` — the real success/failure signal
 * arrives later via these two events, so they are mapped flat here to keep
 * `payment.succeeded`/`payment.failed` honest for that flow.
 */
export const STRIPE_EVENT_MAP: Readonly<Record<string, UnifiedEventType>> = {
  "payment_intent.succeeded": "payment.succeeded",
  "checkout.session.async_payment_succeeded": "payment.succeeded",
  "payment_intent.payment_failed": "payment.failed",
  "checkout.session.async_payment_failed": "payment.failed",
  "charge.refunded": "refund.processed",
  "customer.subscription.created": "subscription.created",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.canceled",
  "invoice.paid": "invoice.paid",
  "invoice.payment_succeeded": "invoice.paid",
  "invoice.payment_failed": "invoice.payment_failed",
  "charge.dispute.created": "dispute.created",
};

/** One {@link STRIPE_EVENT_STATUS_SPLIT_MAP} row: which field on the nested `data.object` decides the outcome, and which native values count as the success case. */
export interface StripeEventStatusSplit {
  readonly field: "status" | "payment_status";
  readonly matches: readonly string[];
  readonly unifiedType: UnifiedEventType;
}

/**
 * Stripe events whose unified type depends on the WRAPPED RESOURCE's status
 * (`data.object.<field>`, verified 2026-07-12):
 *
 * - `checkout.session.completed` fires once the checkout FLOW finishes, which
 *   is not the same as payment succeeding for a delayed/async payment method
 *   (`payment_status` can still be `"unpaid"` at that point —
 *   https://docs.stripe.com/checkout/fulfillment). Only `payment_status:
 *   "paid"` or `"no_payment_required"` (a genuinely $0 checkout) normalize to
 *   `payment.succeeded`; `"unpaid"` falls through to `"unknown"` (the real
 *   signal arrives later via `checkout.session.async_payment_succeeded`,
 *   mapped flat in {@link STRIPE_EVENT_MAP}) — session status ∈ {open,
 *   complete, expired}, payment_status ∈ {paid, unpaid, no_payment_required}
 *   per https://docs.stripe.com/api/checkout/sessions/object.
 * - `refund.updated` fires for EVERY refund status transition — Refund
 *   `status` ∈ {pending, requires_action, succeeded, failed, canceled} per
 *   https://docs.stripe.com/api/refunds/object — only `"succeeded"` is a
 *   completed refund; every other transition falls through to `"unknown"`
 *   (never a false `refund.processed`).
 */
export const STRIPE_EVENT_STATUS_SPLIT_MAP: Readonly<Record<string, StripeEventStatusSplit>> = {
  "checkout.session.completed": {
    field: "payment_status",
    matches: ["paid", "no_payment_required"],
    unifiedType: "payment.succeeded",
  },
  "refund.updated": {
    field: "status",
    matches: ["succeeded"],
    unifiedType: "refund.processed",
  },
};

// ── Status tables ────────────────────────────────────────────────────────────

/** Paystack transaction `status` strings → unified status. */
export const PAYSTACK_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  success: "success",
  failed: "failed",
  pending: "pending",
  ongoing: "pending",
  processing: "pending",
  queued: "pending",
  abandoned: "abandoned",
  reversed: "reversed",
};

/** Flutterwave v3 transaction `status` strings → unified status (`successful`). */
export const FLUTTERWAVE_V3_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  successful: "success",
  failed: "failed",
  pending: "pending",
  processing: "pending",
  queued: "pending",
};

/** Flutterwave v4 transaction `status` strings → unified status (`succeeded`). */
export const FLUTTERWAVE_V4_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  succeeded: "success",
  failed: "failed",
  pending: "pending",
  processing: "pending",
  queued: "pending",
};

/**
 * Stripe status strings → unified status — MERGED across the object types
 * `toUnifiedStatus` normalizes for Stripe (Checkout Session `payment_status` +
 * `status`, PaymentIntent `status`); none of the verified values collide.
 * Verified 2026-07-12:
 *
 * - Checkout Session `payment_status` ∈ {paid, unpaid, no_payment_required}
 *   and `status` ∈ {open, complete, expired} —
 *   https://docs.stripe.com/api/checkout/sessions/object. `no_payment_required`
 *   (a genuinely $0 checkout) is an ADDITION beyond the documented status set —
 *   treated as `success` (the checkout completed, nothing further to charge).
 *   `open` is an ADDITION (in-progress, not yet an anomaly) → `pending`.
 *   `status: "complete"` is DELIBERATELY OMITTED: it means the checkout FLOW
 *   finished, not that payment succeeded — a delayed/async payment method can
 *   complete a session while `payment_status` is still `"unpaid"`
 *   (https://docs.stripe.com/checkout/fulfillment) — callers must normalize
 *   `payment_status`, the payment-outcome field, not the session's own
 *   `status`; an unrecognized `"complete"` intentionally falls through to the
 *   safe `"pending"` default (+ drift log) rather than a table entry that could
 *   silently paper over a caller reading the wrong field.
 * - PaymentIntent `status` ∈ {requires_payment_method, requires_confirmation,
 *   requires_action, processing, requires_capture, succeeded, canceled} —
 *   https://docs.stripe.com/api/payment_intents/object,
 *   https://docs.stripe.com/payments/paymentintents/lifecycle.
 *   `requires_capture` (funds authorized, not yet captured) is an ADDITION
 *   beyond the documented status set, mapped to `pending` for the same reason as
 *   the other `requires_*` states — not yet succeeded.
 */
export const STRIPE_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  // Checkout Session `payment_status`
  paid: "success",
  no_payment_required: "success",
  unpaid: "pending",
  // Checkout Session `status` (payment-outcome-relevant values only — see note above)
  open: "pending",
  expired: "abandoned",
  // PaymentIntent `status`
  succeeded: "success",
  processing: "pending",
  requires_action: "pending",
  requires_confirmation: "pending",
  requires_payment_method: "pending",
  requires_capture: "pending",
  canceled: "abandoned",
};

function statusTableFor(
  provider: MappingProvider,
  version: MappingVersion,
): Readonly<Record<string, UnifiedStatus>> {
  if (provider === "paystack") return PAYSTACK_STATUS_MAP;
  if (provider === "stripe") return STRIPE_STATUS_MAP;
  return version === "v4" ? FLUTTERWAVE_V4_STATUS_MAP : FLUTTERWAVE_V3_STATUS_MAP;
}

// ── Pure mapping functions ───────────────────────────────────────────────────

/**
 * Normalize a provider transaction status to a {@link UnifiedStatus}. Matching
 * is case-insensitive. An unrecognized status NEVER throws: it returns
 * `"pending"` (the safe default — never grant value off a webhook) and emits a
 * `schema_drift` log if a `logger` is supplied.
 *
 * @param provider - `"paystack"` | `"flutterwave"` | `"stripe"`.
 * @param version - Flutterwave version (`"v3"` | `"v4"`); `undefined` for Paystack and Stripe.
 * @param nativeStatus - Provider-native status string (e.g. `"successful"`).
 * @param logger - Optional injected logger for drift reporting.
 */
export function toUnifiedStatus(
  provider: MappingProvider,
  version: MappingVersion,
  nativeStatus: string | null | undefined,
  logger?: Logger,
): UnifiedStatus {
  const key = typeof nativeStatus === "string" ? nativeStatus.trim().toLowerCase() : "";
  const table = statusTableFor(provider, version);
  const mapped = table[key];
  if (mapped !== undefined) return mapped;
  logger?.({
    type: "schema_drift",
    message: "Unknown transaction status; defaulting to 'pending'.",
    provider,
    version,
    nativeStatus,
  });
  return "pending";
}

/**
 * Normalize a provider-native webhook event name to a {@link UnifiedEventType}.
 * For Flutterwave events whose meaning depends on the transaction outcome
 * (`charge.completed`, `transfer.completed`), the split is resolved from
 * `data.status` via {@link toUnifiedStatus}. For Stripe events whose meaning
 * depends on the wrapped resource's status (`checkout.session.completed`,
 * `refund.updated`), the split is resolved directly from
 * `data.object.<field>` per {@link STRIPE_EVENT_STATUS_SPLIT_MAP} (Stripe's
 * event envelope nests the resource one level deeper than Paystack/FLW's flat
 * `data`). Anything unmapped → `"unknown"` (delivered, never dropped).
 *
 * @param provider - `"paystack"` | `"flutterwave"` | `"stripe"`.
 * @param version - Flutterwave version; `undefined` for Paystack and Stripe.
 * @param nativeType - Provider-native event name (e.g. `"charge.success"`).
 * @param data - The event's `data` object — FLW status splits read `data.status`; Stripe status splits read `data.object.<field>`.
 */
export function toUnifiedEventType(
  provider: MappingProvider,
  version: MappingVersion,
  nativeType: string | null | undefined,
  data?: unknown,
): UnifiedEventType {
  const key = typeof nativeType === "string" ? nativeType.trim() : "";
  if (provider === "paystack") {
    return PAYSTACK_EVENT_MAP[key] ?? "unknown";
  }
  if (provider === "stripe") {
    const split = STRIPE_EVENT_STATUS_SPLIT_MAP[key];
    if (split) {
      const value = readStripeObjectField(data, split.field);
      return value !== undefined && split.matches.includes(value) ? split.unifiedType : "unknown";
    }
    return STRIPE_EVENT_MAP[key] ?? "unknown";
  }
  const split = FLUTTERWAVE_STATUS_SPLIT_MAP[key];
  if (split) {
    const status = readStatus(data);
    if (status === undefined) return "unknown";
    const unified = toUnifiedStatus(provider, version, status);
    if (unified === "success") return split.succeeded;
    if (unified === "failed") return split.failed;
    return "unknown";
  }
  return FLUTTERWAVE_EVENT_MAP[key] ?? "unknown";
}

function readStatus(data: unknown): string | undefined {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const status = (data as Record<string, unknown>).status;
    if (typeof status === "string") return status;
  }
  return undefined;
}

/**
 * Read a field off Stripe's nested `data.object` — every Stripe event wraps
 * its resource one level down (https://docs.stripe.com/api/events/object,
 * verified 2026-07-12), unlike Paystack/Flutterwave's flat `data`.
 */
function readStripeObjectField(data: unknown, field: string): string | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const obj = (data as Record<string, unknown>).object;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const value = (obj as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

// ── Unified-ops capability matrix ────────────────

/**
 * The six unified ops (Surface B, `src/unified/types.ts`'s
 * {@link UnifiedNamespace}) as flat, dot-qualified identifiers — the keys the
 * capability matrix and the typed capability guard operate on.
 */
export type UnifiedOpName =
  | "checkout.create"
  | "verify"
  | "refunds.create"
  | "transfers.create"
  | "banks.list"
  | "banks.resolveAccount";

/**
 * One capability-matrix cell: whether `op` is supported on a given provider,
 * and — only when it is NOT — the exact message the typed guard throws.
 */
export interface UnifiedOpCapability {
  readonly supported: boolean;
  /** Present only when `supported` is `false`. */
  readonly reason?: string;
}

const ALL_SUPPORTED: Readonly<Record<UnifiedOpName, UnifiedOpCapability>> = {
  "checkout.create": { supported: true },
  verify: { supported: true },
  "refunds.create": { supported: true },
  "transfers.create": { supported: true },
  "banks.list": { supported: true },
  "banks.resolveAccount": { supported: true },
};

/**
 * The unified-ops capability matrix: which of the six
 * unified ops each provider supports. Data, not prose, so
 * `payweave.capabilities()` (`src/index.ts`) and doc generators
 * can render it directly.
 *
 * Paystack and Flutterwave support all six. Stripe does NOT map
 * `transfers.create` or `banks.*` in v1 — Stripe payouts/Connect transfers are
 * semantically different from Paystack/FLW bank transfers, and bank-account
 * lookup is NG-specific. `checkout.create`/`verify`/
 * `refunds.create` ARE capability-supported on stripe (mapped to
 * `checkout.sessions`/`paymentIntents`/`refunds`) — the runtime
 * wiring of that mapping (`src/unified/stripe.ts`) is separate follow-up work
 * tracked outside this capability-matrix change; calling those ops today
 * rejects with a distinct "not implemented yet" error rather than the
 * capability-gap error below (see `stripeUnifiedNamespace` in `src/index.ts`).
 *
 * EXTEND ONLY (same rule as the event/status tables above): a
 * `false` cell may flip to `true` (additive, `minor`) once a provider's
 * mapping lands; flipping `true` → `false` is a breaking change.
 */
export const UNIFIED_CAPABILITY_MATRIX: Readonly<
  Record<MappingProvider, Readonly<Record<UnifiedOpName, UnifiedOpCapability>>>
> = {
  paystack: ALL_SUPPORTED,
  flutterwave: ALL_SUPPORTED,
  stripe: {
    "checkout.create": { supported: true },
    verify: { supported: true },
    "refunds.create": { supported: true },
    "transfers.create": {
      supported: false,
      reason: "transfers are not supported on stripe",
    },
    "banks.list": {
      supported: false,
      reason: "banks.list is not supported on stripe",
    },
    "banks.resolveAccount": {
      supported: false,
      reason: "banks.resolveAccount is not supported on stripe",
    },
  },
};

/**
 * Whether `provider` supports `op` per the {@link UNIFIED_CAPABILITY_MATRIX}.
 * An unknown provider/op pair (unreachable via the typed matrix, reachable
 * only from untyped callers) is treated as unsupported — fail closed, never
 * silently allow an unshaped call through.
 */
export function isUnifiedOpSupported(provider: MappingProvider, op: UnifiedOpName): boolean {
  return UNIFIED_CAPABILITY_MATRIX[provider]?.[op]?.supported ?? false;
}

/**
 * Assert that `provider` supports `op`. A no-op when it
 * is; otherwise throws {@link PayweaveValidationError}, naming the provider
 * and operation (e.g.
 * `"transfers are not supported on stripe"` for `transfers.create` on
 * stripe). Never throws for a supported op, and never for anything OTHER than
 * a capability gap — config/auth/network failures surface through their own
 * error classes elsewhere in the request path.
 */
export function assertUnifiedCapability(provider: MappingProvider, op: UnifiedOpName): void {
  const cell = UNIFIED_CAPABILITY_MATRIX[provider]?.[op];
  if (cell?.supported) return;
  throw new PayweaveValidationError(cell?.reason ?? `${op} is not supported on ${provider}`, {
    provider,
  });
}
