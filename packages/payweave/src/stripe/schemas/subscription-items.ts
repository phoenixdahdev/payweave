/**
 * Zod schemas for the Stripe Subscription Items module. Request
 * fields are sourced verbatim from the official API reference (all verified
 * 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/subscription_items/create
 *   - Retrieve: https://docs.stripe.com/api/subscription_items/retrieve
 *   - Update:   https://docs.stripe.com/api/subscription_items/update
 *   - Delete:   https://docs.stripe.com/api/subscription_items/delete
 *   - List:     https://docs.stripe.com/api/subscription_items/list
 *
 * `unit_amount` is integer MINOR units end to end — no
 * conversion anywhere. Proration parameter names are copied EXACTLY from the
 * docs and never abstracted (PW-604 contract note). Response schemas are
 * LOOSE: unknown provider fields pass through, drift is logged, never thrown.
 *
 * This file also exports the request-param building blocks shared with the
 * `subscriptions` schemas (`price_data`, `discounts`, item
 * `billing_thresholds`) so the two modules never fork their shapes.
 */
import { z } from "zod";
import { listCursorFields, metadataSchema } from "../types";

/**
 * `price_data.recurring` — billing frequency for an inline price
 * (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12). Required inside `price_data`; `interval_count` maximum is
 * three years (3 years / 36 months / 156 weeks).
 */
const recurring = z.object({
  interval: z.enum(["day", "week", "month", "year"]),
  interval_count: z.number().int().optional(),
});

/**
 * `price_data` — inline Price creation, the alternative to a saved `price` id
 * (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12). Unlike Checkout's variant, `recurring` is REQUIRED here and
 * there is no inline `product_data`. `unit_amount` is integer minor units
 * (0 allowed for a free price); only one of `unit_amount` /
 * `unit_amount_decimal` may be set (enforced provider-side).
 */
export const subscriptionItemPriceData = z.object({
  /** Three-letter ISO currency code, lowercase (e.g. `usd`). Required. */
  currency: z.string(),
  /** Existing Product id (`prod_*`) this price belongs to. Required. */
  product: z.string(),
  /** Billing frequency. Required. */
  recurring,
  tax_behavior: z.enum(["exclusive", "inclusive", "unspecified"]).optional(),
  /** Amount in the smallest currency unit (minor units) — integer, unchanged. */
  unit_amount: z.number().int().nonnegative().optional(),
  /** Decimal string alternative to `unit_amount` (≤12 decimal places). */
  unit_amount_decimal: z.string().optional(),
});

/**
 * One `discounts[]` entry — a coupon, existing discount, or promotion code to
 * redeem (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12). Exactly one of the three ids is expected provider-side.
 */
export const discountParam = z.object({
  /** Coupon id to create a new discount from. */
  coupon: z.string().optional(),
  /** Existing Discount id to reuse. */
  discount: z.string().optional(),
  /** Promotion code id to create a new discount from. */
  promotion_code: z.string().optional(),
});

/**
 * Per-item `billing_thresholds` — usage threshold that advances the
 * subscription to a new billing period
 * (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12).
 */
export const itemBillingThresholds = z.object({
  usage_gte: z.number().int(),
});

/**
 * `payment_behavior` — how Stripe handles a payment required by the change
 * when `collection_method=charge_automatically`
 * (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12).
 */
const paymentBehavior = z.enum([
  "allow_incomplete",
  "default_incomplete",
  "error_if_incomplete",
  "pending_if_incomplete",
]);

/**
 * `proration_behavior` — how to handle prorations resulting from the change
 * (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12). Copied exactly; the default is `create_prorations`.
 */
const prorationBehavior = z.enum(["always_invoice", "create_prorations", "none"]);

/**
 * POST /v1/subscription_items — request
 * (https://docs.stripe.com/api/subscription_items/create — verified
 * 2026-07-12).
 */
export const subscriptionItemCreateReq = z.object({
  /** Subscription id (`sub_*`) to add the item to. Required. */
  subscription: z.string().min(1),
  /** Saved Price id (`price_*`). Alternative to `price_data`. */
  price: z.string().optional(),
  /** Inline price definition. Alternative to `price`. */
  price_data: subscriptionItemPriceData.optional(),
  quantity: z.number().int().nonnegative().optional(),
  metadata: metadataSchema.optional(),
  billing_thresholds: itemBillingThresholds.optional(),
  /** Coupons/promotion codes to redeem into discounts for this item. */
  discounts: z.array(discountParam).optional(),
  payment_behavior: paymentBehavior.optional(),
  proration_behavior: prorationBehavior.optional(),
  /** Unix timestamp — prorate as though the update happened at this time. */
  proration_date: z.number().int().optional(),
  /** Tax Rate ids overriding the subscription's `default_tax_rates`. */
  tax_rates: z.array(z.string()).optional(),
});
export type SubscriptionItemCreateReq = z.input<typeof subscriptionItemCreateReq>;

/**
 * POST /v1/subscription_items/{id} — request
 * (https://docs.stripe.com/api/subscription_items/update — verified
 * 2026-07-12).
 */
export const subscriptionItemUpdateReq = z.object({
  /** Saved Price id (`price_*`). Alternative to `price_data`. */
  price: z.string().optional(),
  /** Inline price definition. Alternative to `price`. */
  price_data: subscriptionItemPriceData.optional(),
  quantity: z.number().int().nonnegative().optional(),
  metadata: metadataSchema.optional(),
  billing_thresholds: itemBillingThresholds.optional(),
  /** Coupons/promotion codes to redeem into discounts for this item. */
  discounts: z.array(discountParam).optional(),
  /** Customer is not in the flow — attempt payment immediately off-session. */
  off_session: z.boolean().optional(),
  payment_behavior: paymentBehavior.optional(),
  proration_behavior: prorationBehavior.optional(),
  /** Unix timestamp — prorate as though the update happened at this time. */
  proration_date: z.number().int().optional(),
  /** Tax Rate ids overriding the subscription's `default_tax_rates`. */
  tax_rates: z.array(z.string()).optional(),
});
export type SubscriptionItemUpdateReq = z.input<typeof subscriptionItemUpdateReq>;

/**
 * DELETE /v1/subscription_items/{id} — request
 * (https://docs.stripe.com/api/subscription_items/delete — verified
 * 2026-07-12). Deleting removes the price from the subscription; params ride
 * the DELETE as a form body, exactly like the docs' curl example.
 */
export const subscriptionItemDeleteReq = z.object({
  /** Delete all usage for the item — only when the price's `usage_type` is `metered`. */
  clear_usage: z.boolean().optional(),
  payment_behavior: paymentBehavior.optional(),
  proration_behavior: prorationBehavior.optional(),
  /** Unix timestamp — prorate as though the update happened at this time. */
  proration_date: z.number().int().optional(),
});
export type SubscriptionItemDeleteReq = z.input<typeof subscriptionItemDeleteReq>;

/**
 * GET /v1/subscription_items — query params
 * (https://docs.stripe.com/api/subscription_items/list — verified 2026-07-12).
 * `subscription` is REQUIRED — subscription items can only be listed per
 * subscription. Plain cursor pagination otherwise.
 */
export const subscriptionItemListQuery = z.object({
  ...listCursorFields,
  /** Subscription id (`sub_*`) whose items to list. Required. */
  subscription: z.string().min(1),
});
export type SubscriptionItemListQuery = z.input<typeof subscriptionItemListQuery>;

/**
 * A Subscription Item as returned by create/retrieve/update/list — and
 * embedded in `subscription.items.data[]`
 * (https://docs.stripe.com/api/subscription_items/object — verified
 * 2026-07-12). LOOSE: only stable documented fields are named; everything
 * else passes through.
 *
 * On the SDK's pinned API version (`2026-06-24.dahlia`),
 * `current_period_start`/`current_period_end` live HERE on the item — not on
 * the parent subscription object. EPIC 8's local billing state (PW-804/805)
 * reads the period boundaries from `items.data[].current_period_*`.
 */
export const subscriptionItem = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  /** Parent subscription id (`sub_*`). */
  subscription: z.string().optional(),
  /** The Price the customer is subscribed to — kept loose beyond its id. */
  price: z.looseObject({ id: z.string().optional() }).nullable().optional(),
  quantity: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  created: z.number().optional(),
  /** Start of the item's current billing period (Unix timestamp). */
  current_period_start: z.number().optional(),
  /** End of the item's current billing period (Unix timestamp). */
  current_period_end: z.number().optional(),
  /** Time period the item has been billed for — nullable, expandable. */
  billed_until: z.unknown().optional(),
  billing_thresholds: z.looseObject({}).nullable().optional(),
  /** Discount ids (or expanded objects) — kept unknown. */
  discounts: z.unknown().optional(),
  /** Tax Rate objects applied to this item — kept unknown. */
  tax_rates: z.unknown().optional(),
});

/**
 * DELETE /v1/subscription_items/{id} — response: the deletion
 * acknowledgement `{ id, object: "subscription_item", deleted: true }`
 * (https://docs.stripe.com/api/subscription_items/delete — verified
 * 2026-07-12). LOOSE like every response schema.
 */
export const subscriptionItemDeleted = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  deleted: z.boolean().optional(),
});
