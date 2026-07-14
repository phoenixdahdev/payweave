/**
 * Zod schemas for the Stripe Subscriptions module. Request fields
 * are sourced verbatim from the official Billing API reference (all verified
 * 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/subscriptions/create
 *   - Retrieve: https://docs.stripe.com/api/subscriptions/retrieve
 *   - Update:   https://docs.stripe.com/api/subscriptions/update
 *   - Cancel:   https://docs.stripe.com/api/subscriptions/cancel
 *   - Resume:   https://docs.stripe.com/api/subscriptions/resume
 *   - List:     https://docs.stripe.com/api/subscriptions/list
 *
 * Cancel semantics (verified 2026-07-12): Stripe has
 * TWO cancellation shapes and this module exposes both faithfully —
 *   1. IMMEDIATE cancellation: `DELETE /v1/subscriptions/{id}`
 *      (`subscriptions.cancel()`; optional `invoice_now` / `prorate` /
 *      `cancellation_details` form params).
 *   2. END-OF-PERIOD cancellation: `cancel_at_period_end: true` via
 *      `POST /v1/subscriptions/{id}` (`subscriptions.update()`) — the
 *      subscription stays `active` until the period closes.
 * The local billing state machine depends on the distinction; they are never merged.
 *
 * Proration parameter names (`proration_behavior`, `proration_date`) are
 * copied EXACTLY from the docs, never abstracted.
 * Amounts are integer minor units end to end. Response
 * schemas are LOOSE: unknown provider fields pass through, drift is logged,
 * never thrown.
 *
 * Documented params whose child shapes we have NOT verified against the
 * reference are deliberately untyped in this P0 subset (conservative wins):
 * `add_invoice_items`,
 * `billing_cycle_anchor_config`, `billing_mode`, `billing_schedules`,
 * `invoice_settings`, `payment_settings`, `transfer_data`, `on_behalf_of`,
 * `application_fee_percent`, `customer_account`, and the list filters
 * `automatic_tax` / `customer_account` / `test_clock`. Add them with a docs
 * re-check when needed.
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema, stripeList } from "../types";
import {
  discountParam,
  itemBillingThresholds,
  subscriptionItem,
  subscriptionItemPriceData,
} from "./subscription-items";

/**
 * One `items[]` entry on subscription CREATE — up to 20 items, each with an
 * attached price (https://docs.stripe.com/api/subscriptions/create — verified
 * 2026-07-12).
 */
const createItemParam = z.object({
  /** Saved Price id (`price_*`). Alternative to `price_data`. */
  price: z.string().optional(),
  /** Inline price definition (recurring required). Alternative to `price`. */
  price_data: subscriptionItemPriceData.optional(),
  quantity: z.number().int().nonnegative().optional(),
  metadata: metadataSchema.optional(),
  billing_thresholds: itemBillingThresholds.optional(),
  /** Coupons/promotion codes to redeem into discounts for this item. */
  discounts: z.array(discountParam).optional(),
  /** Tax Rate ids overriding the subscription's `default_tax_rates`. */
  tax_rates: z.array(z.string()).optional(),
});

/**
 * One `items[]` entry on subscription UPDATE
 * (https://docs.stripe.com/api/subscriptions/update — verified 2026-07-12).
 * `id` targets an existing subscription item; `deleted: true` removes it;
 * `clear_usage` drops accumulated usage for a metered price.
 */
const updateItemParam = z.object({
  /** Existing SubscriptionItem id (`si_*`) to update. */
  id: z.string().optional(),
  /** Saved Price id (`price_*`). Alternative to `price_data`. */
  price: z.string().optional(),
  /** Inline price definition (recurring required). Alternative to `price`. */
  price_data: subscriptionItemPriceData.optional(),
  quantity: z.number().int().nonnegative().optional(),
  metadata: metadataSchema.optional(),
  /** Set to `true` to delete the specified item. */
  deleted: z.boolean().optional(),
  /** Delete all usage for the item (metered prices). */
  clear_usage: z.boolean().optional(),
  billing_thresholds: itemBillingThresholds.optional(),
  /** Coupons/promotion codes to redeem into discounts for this item. */
  discounts: z.array(discountParam).optional(),
  /** Tax Rate ids overriding the subscription's `default_tax_rates`. */
  tax_rates: z.array(z.string()).optional(),
});

/**
 * `cancel_at` — Unix timestamp, or one of the documented symbolic values
 * (https://docs.stripe.com/api/subscriptions/create — verified 2026-07-12).
 */
const cancelAt = z.union([
  z.number().int(),
  z.enum(["max_billed_until", "max_period_end", "min_period_end"]),
]);

/**
 * `cancellation_details` — why the subscription is being canceled
 * (https://docs.stripe.com/api/subscriptions/cancel — verified 2026-07-12).
 */
const cancellationDetails = z.object({
  /** Additional comments about why the user canceled. */
  comment: z.string().optional(),
  /** The customer-submitted reason for cancellation. */
  feedback: z
    .enum([
      "customer_service",
      "low_quality",
      "missing_features",
      "other",
      "switched_service",
      "too_complex",
      "too_expensive",
      "unused",
    ])
    .optional(),
});

/**
 * `trial_end` — Unix timestamp, or the literal `"now"` to end the trial
 * immediately (https://docs.stripe.com/api/subscriptions/create — verified
 * 2026-07-12).
 */
const trialEnd = z.union([z.literal("now"), z.number().int()]);

/**
 * POST /v1/subscriptions — request
 * (https://docs.stripe.com/api/subscriptions/create — verified 2026-07-12).
 *
 * `payment_behavior` on CREATE is `allow_incomplete` | `default_incomplete` |
 * `error_if_incomplete` (`pending_if_incomplete` is update-only), and
 * `proration_behavior` on CREATE is `create_prorations` | `none`
 * (`always_invoice` is not available at creation) — both narrower than their
 * update counterparts, copied exactly from the create page.
 */
export const subscriptionCreateReq = z.object({
  /**
   * Customer id (`cus_*`) to subscribe. Stripe requires a customer (the
   * unverified `customer_account` alternative is untyped in this P0 subset).
   */
  customer: z.string().optional(),
  /** Items being subscribed to — up to 20, each with an attached price. Required. */
  items: z.array(createItemParam).max(20),
  /** Past Unix timestamp to backdate the subscription's start date to. */
  backdate_start_date: z.number().int().optional(),
  /** Future Unix timestamp anchoring the billing cycle (first full invoice). */
  billing_cycle_anchor: z.number().int().optional(),
  /** Unix timestamp or symbolic value at which to auto-cancel. */
  cancel_at: cancelAt.optional(),
  /** Cancel at the end of the current period instead of immediately. Default false. */
  cancel_at_period_end: z.boolean().optional(),
  collection_method: z.enum(["charge_automatically", "send_invoice"]).optional(),
  /** Three-letter ISO currency code, lowercase. */
  currency: z.string().optional(),
  /** Days until invoices are due — `send_invoice` collection only. */
  days_until_due: z.number().int().optional(),
  /** PaymentMethod id (`pm_*`) used as this subscription's default. */
  default_payment_method: z.string().optional(),
  /** Source id used as this subscription's default payment source. */
  default_source: z.string().optional(),
  /** Tax Rate ids applied by default to the subscription's items. */
  default_tax_rates: z.array(z.string()).optional(),
  /** ≤500 chars, displayable to customers. */
  description: z.string().max(500).optional(),
  /** Coupons/promotion codes to redeem into discounts for the subscription. */
  discounts: z.array(discountParam).optional(),
  metadata: metadataSchema.optional(),
  /** Customer is not in the checkout flow. Default false. */
  off_session: z.boolean().optional(),
  payment_behavior: z
    .enum(["allow_incomplete", "default_incomplete", "error_if_incomplete"])
    .optional(),
  /** Invoice-pending-items schedule between billing cycles. */
  pending_invoice_item_interval: z
    .object({
      interval: z.enum(["day", "month", "week", "year"]),
      interval_count: z.number().int().optional(),
    })
    .optional(),
  proration_behavior: z.enum(["create_prorations", "none"]).optional(),
  /** Unix timestamp or `"now"` — when the trial ends. */
  trial_end: trialEnd.optional(),
  /** Use the price's/plan's trial period. Default false. */
  trial_from_plan: z.boolean().optional(),
  /** Trial length in days (alternative to `trial_end`). */
  trial_period_days: z.number().int().optional(),
  /** What happens at trial end when no payment method is present. */
  trial_settings: z
    .object({
      end_behavior: z.object({
        missing_payment_method: z.enum(["cancel", "create_invoice", "pause"]),
      }),
    })
    .optional(),
});
export type SubscriptionCreateReq = z.input<typeof subscriptionCreateReq>;

/**
 * `pause_collection` — pause PAYMENT COLLECTION while the subscription stays
 * `active` (https://docs.stripe.com/api/subscriptions/update — verified
 * 2026-07-12). Distinct from the `paused` subscription STATUS, which is what
 * `subscriptions.resume()` acts on. Pass the empty string `""` to unset and
 * resume collection (https://docs.stripe.com/billing/subscriptions/pause-payment
 * — verified 2026-07-12: "update the subscription and unset
 * `pause_collection`", curl `-d "pause_collection"=`).
 */
const pauseCollection = z.union([
  z.object({
    behavior: z.enum(["keep_as_draft", "mark_uncollectible", "void"]),
    /** Unix timestamp at which collection automatically resumes. */
    resumes_at: z.number().int().optional(),
  }),
  z.literal(""),
]);

/**
 * POST /v1/subscriptions/{id} — request
 * (https://docs.stripe.com/api/subscriptions/update — verified 2026-07-12).
 *
 * `{ cancel_at_period_end: true }` here is the END-OF-PERIOD cancellation
 * path; `subscriptions.cancel()` (DELETE) is the immediate one — see the
 * module JSDoc.
 */
export const subscriptionUpdateReq = z.object({
  /** Item changes: update by `id`, add by `price`, remove with `deleted: true`. */
  items: z.array(updateItemParam).optional(),
  /** Unix timestamp or symbolic value at which to auto-cancel. */
  cancel_at: cancelAt.optional(),
  /** `true` = cancel when the current period ends; `false` = clear a pending one. */
  cancel_at_period_end: z.boolean().optional(),
  cancellation_details: cancellationDetails.optional(),
  /** `now` resets the billing cycle anchor; `unchanged` keeps it. */
  billing_cycle_anchor: z.enum(["now", "unchanged"]).optional(),
  collection_method: z.enum(["charge_automatically", "send_invoice"]).optional(),
  /** Days until invoices are due — `send_invoice` collection only. */
  days_until_due: z.number().int().optional(),
  /** PaymentMethod id (`pm_*`) used as this subscription's default. */
  default_payment_method: z.string().optional(),
  /** ≤500 chars, displayable to customers. */
  description: z.string().max(500).optional(),
  /** Coupons/promotion codes to redeem into discounts for the subscription. */
  discounts: z.array(discountParam).optional(),
  metadata: metadataSchema.optional(),
  /** Customer is not in the checkout flow. Default false. */
  off_session: z.boolean().optional(),
  /** Pause payment collection (subscription stays `active`); `""` unsets. */
  pause_collection: pauseCollection.optional(),
  payment_behavior: z
    .enum([
      "allow_incomplete",
      "default_incomplete",
      "error_if_incomplete",
      "pending_if_incomplete",
    ])
    .optional(),
  proration_behavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
  /** Unix timestamp — prorate as though the update happened at this time. */
  proration_date: z.number().int().optional(),
  /** Unix timestamp or `"now"` — when the trial ends. */
  trial_end: trialEnd.optional(),
});
export type SubscriptionUpdateReq = z.input<typeof subscriptionUpdateReq>;

/**
 * DELETE /v1/subscriptions/{id} — request (IMMEDIATE cancellation,
 * https://docs.stripe.com/api/subscriptions/cancel — verified 2026-07-12).
 * Params ride the DELETE as a form body, exactly like the docs' curl example.
 */
export const subscriptionCancelReq = z.object({
  cancellation_details: cancellationDetails.optional(),
  /** Generate a final invoice for un-invoiced metered usage and pending prorations. Default false. */
  invoice_now: z.boolean().optional(),
  /** Credit remaining unused time until the period end via a proration item. Default false. */
  prorate: z.boolean().optional(),
});
export type SubscriptionCancelReq = z.input<typeof subscriptionCancelReq>;

/**
 * POST /v1/subscriptions/{id}/resume — request
 * (https://docs.stripe.com/api/subscriptions/resume — verified 2026-07-12).
 * Only for subscriptions with STATUS `paused` (e.g. a trial that ended under
 * `trial_settings.end_behavior.missing_payment_method: "pause"`) using
 * `charge_automatically` collection. `billing_cycle_anchor` defaults to
 * `now`; when it is `now`, no prorations are generated.
 */
export const subscriptionResumeReq = z.object({
  /** `now` resets the anchor and starts a new period; `unchanged` keeps it. Default `now`. */
  billing_cycle_anchor: z.enum(["now", "unchanged"]).optional(),
  proration_behavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
  /** Unix timestamp — prorate as though resumed at this time. */
  proration_date: z.number().int().optional(),
});
export type SubscriptionResumeReq = z.input<typeof subscriptionResumeReq>;

/**
 * GET /v1/subscriptions — query params
 * (https://docs.stripe.com/api/subscriptions/list — verified 2026-07-12).
 * Range filters (`created`, `current_period_start`, `current_period_end`)
 * reach the URL as bracket keys (`created[gte]`); list filters are QUERY
 * params, never form body.
 */
export const subscriptionListQuery = z.object({
  ...listCursorFields,
  /** Filter by Customer id. */
  customer: z.string().optional(),
  /** Filter by recurring Price id. */
  price: z.string().optional(),
  /**
   * Status filter. Documented special values (verified 2026-07-12):
   * `canceled` (includes deleted customers' subscriptions), `ended` (canceled
   * + expired due to incomplete payment), `all`; omitted = all non-canceled
   * subscriptions. Kept as an open string — the docs page does not enumerate
   * a closed value set for this filter (conservative); Stripe
   * validates server-side.
   */
  status: z.string().optional(),
  collection_method: z.enum(["charge_automatically", "send_invoice"]).optional(),
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
  /** Current-period-start window (Unix timestamps). */
  current_period_start: createdRange.optional(),
  /** Current-period-end window (Unix timestamps). */
  current_period_end: createdRange.optional(),
});
export type SubscriptionListQuery = z.input<typeof subscriptionListQuery>;

/**
 * A Subscription as returned by every endpoint
 * (https://docs.stripe.com/api/subscriptions/object — verified 2026-07-12).
 * LOOSE: only stable documented fields are named; everything else passes
 * through. `status` and the period boundaries feed the local billing
 * state and correlate with the `customer.subscription.*` webhook
 * payloads.
 *
 * NOTE (verified 2026-07-12): on the SDK's pinned API version
 * (`2026-06-24.dahlia`) `current_period_start`/`current_period_end` are NOT
 * top-level subscription fields — they live on each embedded item at
 * `items.data[].current_period_start/end` (`schemas/subscription-items.ts`).
 */
export const subscription = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  /**
   * `incomplete` | `incomplete_expired` | `trialing` | `active` | `past_due`
   * | `canceled` | `unpaid` | `paused` — normalization is the unified layer's
   * job.
   */
  status: z.string().optional(),
  /** Customer id string, or an expanded object — kept unknown. */
  customer: z.unknown().optional(),
  /** Embedded (paginated) list of the subscription's items. */
  items: stripeList(subscriptionItem).optional(),
  currency: z.string().optional(),
  collection_method: z.string().optional(),
  /** Unix timestamp at which the subscription will auto-cancel. */
  cancel_at: z.number().nullable().optional(),
  /** Whether the subscription cancels when the current period ends. */
  cancel_at_period_end: z.boolean().optional(),
  /** When the cancellation was requested (Unix timestamp). */
  canceled_at: z.number().nullable().optional(),
  /** `{ reason, feedback, comment }` — kept loose. */
  cancellation_details: z.looseObject({}).nullable().optional(),
  created: z.number().optional(),
  /** Start of the subscription (may differ from `created` when backdated). */
  start_date: z.number().optional(),
  /** Anchor aligning future billing cycle dates (Unix timestamp). */
  billing_cycle_anchor: z.number().optional(),
  trial_start: z.number().nullable().optional(),
  trial_end: z.number().nullable().optional(),
  /** When the subscription ended (Unix timestamp). */
  ended_at: z.number().nullable().optional(),
  /** Latest Invoice id string, or an expanded object — kept unknown. */
  latest_invoice: z.unknown().optional(),
  /** Default PaymentMethod id string, or an expanded object — kept unknown. */
  default_payment_method: z.unknown().optional(),
  days_until_due: z.number().nullable().optional(),
  /** Payment-collection pause state — `{ behavior, resumes_at }`, kept loose. */
  pause_collection: z.looseObject({}).nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
  livemode: z.boolean().optional(),
});
