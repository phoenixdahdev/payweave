/**
 * Zod schemas for the Stripe Checkout Sessions module (PW-602). Request fields
 * are sourced verbatim from the official API reference (all verified
 * 2026-07-12):
 *   - Create:     https://docs.stripe.com/api/checkout/sessions/create
 *   - Retrieve:   https://docs.stripe.com/api/checkout/sessions/retrieve
 *   - List:       https://docs.stripe.com/api/checkout/sessions/list
 *   - Expire:     https://docs.stripe.com/api/checkout/sessions/expire
 *   - Line items: https://docs.stripe.com/api/checkout/sessions/line_items
 *
 * Amounts (`unit_amount`, `amount_total`, …) are integer MINOR units on both
 * sides (providers.md §3.1) — no conversion anywhere. Response schemas are
 * LOOSE: unknown provider fields pass through, drift is logged, never thrown.
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema } from "../types";

/**
 * `line_items[].price_data.product_data` — inline Product creation
 * (https://docs.stripe.com/api/checkout/sessions/create — verified 2026-07-12).
 */
const productData = z.object({
  /** Product name — required by Stripe when creating a product inline. */
  name: z.string(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
  tax_code: z.string().optional(),
});

/**
 * `line_items[].price_data.recurring` — subscription-mode interval
 * (https://docs.stripe.com/api/checkout/sessions/create — verified 2026-07-12).
 */
const recurring = z.object({
  interval: z.enum(["day", "week", "month", "year"]),
  interval_count: z.number().int().optional(),
});

/**
 * `line_items[].price_data` — inline Price creation, the alternative to a
 * saved `price` id (https://docs.stripe.com/api/checkout/sessions/create —
 * verified 2026-07-12). `unit_amount` is integer minor units.
 */
const priceData = z.object({
  /** Three-letter ISO currency code, lowercase (e.g. `usd`). */
  currency: z.string(),
  /** Amount in the smallest currency unit (minor units) — integer, unchanged. */
  unit_amount: z.number().int().nonnegative().optional(),
  /** Decimal string alternative to `unit_amount` (e.g. fractional cents). */
  unit_amount_decimal: z.string().optional(),
  /** Existing Product id (`prod_*`) the price belongs to. */
  product: z.string().optional(),
  /** Inline Product creation (alternative to `product`). */
  product_data: productData.optional(),
  /** Present only for `subscription` mode line items. */
  recurring: recurring.optional(),
  tax_behavior: z.enum(["inclusive", "exclusive", "unspecified"]).optional(),
});

/**
 * One `line_items[]` entry (https://docs.stripe.com/api/checkout/sessions/create
 * — verified 2026-07-12). This array is the form encoder's nested-array acid
 * test: it goes to the wire as `line_items[0][price]=...` bracket pairs.
 */
const lineItemInput = z.object({
  /** Saved Price (or Plan) id (`price_*`). Alternative to `price_data`. */
  price: z.string().optional(),
  /** Inline price definition. Alternative to `price`. */
  price_data: priceData.optional(),
  quantity: z.number().int().optional(),
  /** Let the customer adjust the quantity in Checkout. */
  adjustable_quantity: z
    .object({
      enabled: z.boolean(),
      minimum: z.number().int().optional(),
      maximum: z.number().int().optional(),
    })
    .optional(),
  /** Tax Rate ids applied to this line item. */
  tax_rates: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
});

/**
 * `payment_intent_data` — configuration forwarded to the PaymentIntent a
 * `payment`-mode session creates
 * (https://docs.stripe.com/api/checkout/sessions/create — verified 2026-07-12;
 * only the documented children verified there are typed here).
 */
const paymentIntentData = z.object({
  capture_method: z.enum(["automatic", "automatic_async", "manual"]).optional(),
  setup_future_usage: z.enum(["on_session", "off_session"]).optional(),
  statement_descriptor: z.string().optional(),
  statement_descriptor_suffix: z.string().optional(),
  receipt_email: z.string().optional(),
  metadata: metadataSchema.optional(),
});

/**
 * POST /v1/checkout/sessions — request
 * (https://docs.stripe.com/api/checkout/sessions/create — verified 2026-07-12).
 *
 * `ui_mode` values are those of the SDK's pinned API version
 * (`2026-06-24.dahlia`): `hosted_page` (default), `embedded_page`, `elements`
 * — the pre-2026-03-25 names `hosted`/`embedded`/`custom` were REMOVED by
 * https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes
 * (verified 2026-07-12).
 */
export const sessionCreateReq = z.object({
  /** Session mode — determines what the session sets up. Required. */
  mode: z.enum(["payment", "setup", "subscription"]),
  /** Items being purchased. Required for `payment`/`subscription` modes. */
  line_items: z.array(lineItemInput).optional(),
  /** Redirect target after a successful session (hosted page). */
  success_url: z.string().optional(),
  /** Redirect target when the customer cancels (hosted page). */
  cancel_url: z.string().optional(),
  /** Return target for embedded UI modes. */
  return_url: z.string().optional(),
  /** Checkout UI surface (see the JSDoc above for version-pinned values). */
  ui_mode: z.enum(["hosted_page", "embedded_page", "elements"]).optional(),
  /** Your internal reference for this session (≤200 chars). */
  client_reference_id: z.string().max(200).optional(),
  /** Existing Customer id (`cus_*`) to prefill. */
  customer: z.string().optional(),
  /** Email to prefill when no `customer` is given (≤800 chars). */
  customer_email: z.string().max(800).optional(),
  customer_creation: z.enum(["always", "if_required"]).optional(),
  /** Three-letter ISO currency code — required in some `setup`-mode cases. */
  currency: z.string().optional(),
  /** Payment method types to accept (e.g. `["card"]`). Provider-validated. */
  payment_method_types: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
  /** Unix timestamp — 30 minutes to 24 hours after creation. */
  expires_at: z.number().int().optional(),
  payment_intent_data: paymentIntentData.optional(),
  billing_address_collection: z.enum(["auto", "required"]).optional(),
  allow_promotion_codes: z.boolean().optional(),
});
export type SessionCreateReq = z.input<typeof sessionCreateReq>;

/**
 * A Checkout Session as returned by create/retrieve/list/expire
 * (https://docs.stripe.com/api/checkout/sessions/object). LOOSE: only stable
 * documented fields are named; everything else passes through. `url` IS null
 * in non-open states (e.g. completed/expired sessions) — tolerated, never
 * thrown (PW-602 contract note).
 */
export const checkoutSession = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  /** `open` | `complete` | `expired` (normalization is the unified layer's job). */
  status: z.string().nullable().optional(),
  /** `paid` | `unpaid` | `no_payment_required`. */
  payment_status: z.string().optional(),
  mode: z.string().optional(),
  /** Hosted checkout URL — null once the session is no longer open. */
  url: z.string().nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  /** Customer id string, or an expanded object — kept unknown. */
  customer: z.unknown().optional(),
  customer_email: z.string().nullable().optional(),
  /** PaymentIntent id string, or an expanded object — kept unknown. */
  payment_intent: z.unknown().optional(),
  /** Integer minor units. */
  amount_subtotal: z.number().nullable().optional(),
  /** Integer minor units. */
  amount_total: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  success_url: z.string().nullable().optional(),
  cancel_url: z.string().nullable().optional(),
  created: z.number().optional(),
  expires_at: z.number().optional(),
  livemode: z.boolean().optional(),
});

/**
 * GET /v1/checkout/sessions — query params
 * (https://docs.stripe.com/api/checkout/sessions/list — verified 2026-07-12).
 * `created` and `customer_details` are nested dictionaries and reach the URL
 * as bracket keys (`created[gte]`, `customer_details[email]`).
 */
export const sessionListQuery = z.object({
  ...listCursorFields,
  /** Filter by Customer id. */
  customer: z.string().optional(),
  /** Filter by customer email (`customer_details[email]`, ≤800 chars). */
  customer_details: z.object({ email: z.string().max(800) }).optional(),
  /** Filter by PaymentIntent id. */
  payment_intent: z.string().optional(),
  /** Filter by Payment Link id. */
  payment_link: z.string().optional(),
  /** Filter by Subscription id. */
  subscription: z.string().optional(),
  status: z.enum(["open", "complete", "expired"]).optional(),
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
});
export type SessionListQuery = z.input<typeof sessionListQuery>;

/**
 * A line item of a completed session
 * (https://docs.stripe.com/api/checkout/sessions/line_items — verified
 * 2026-07-12). All `amount_*` fields are integer minor units.
 */
export const sessionLineItem = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  amount_discount: z.number().optional(),
  amount_subtotal: z.number().optional(),
  amount_tax: z.number().optional(),
  amount_total: z.number().optional(),
  currency: z.string().optional(),
  description: z.string().nullable().optional(),
  /** The Price object backing this item — kept loose. */
  price: z.looseObject({}).nullable().optional(),
  quantity: z.number().nullable().optional(),
});

/**
 * GET /v1/checkout/sessions/{id}/line_items — query params
 * (https://docs.stripe.com/api/checkout/sessions/line_items — verified
 * 2026-07-12): cursor pagination only.
 */
export const lineItemsQuery = z.object({ ...listCursorFields });
export type LineItemsQuery = z.input<typeof lineItemsQuery>;
