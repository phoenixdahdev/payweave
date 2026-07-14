/**
 * Zod schemas for the Stripe PaymentIntents module. Request fields are
 * sourced verbatim from the official API reference (all verified 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/payment_intents/create
 *   - Retrieve: https://docs.stripe.com/api/payment_intents/retrieve
 *   - Confirm:  https://docs.stripe.com/api/payment_intents/confirm
 *   - Capture:  https://docs.stripe.com/api/payment_intents/capture
 *   - Cancel:   https://docs.stripe.com/api/payment_intents/cancel
 *   - List:     https://docs.stripe.com/api/payment_intents/list
 *
 * `amount`/`amount_to_capture` are integer MINOR units end to end (providers.md
 * §3.1) — no conversion anywhere. Documented params whose child shapes we have
 * not verified against the reference (`shipping`, `transfer_data`,
 * `payment_method_options`, `payment_method_data`) are deliberately NOT typed
 * in this P0 subset (conservative wins, AGENTS.md §8) — they can be added once
 * enumerated from the docs. Response schemas are LOOSE: unknown fields pass
 * through, drift is logged, never thrown.
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema } from "../types";

/** `automatic_payment_methods` on create — verified 2026-07-12. */
const automaticPaymentMethods = z.object({
  enabled: z.boolean(),
  allow_redirects: z.enum(["always", "never"]).optional(),
});

/**
 * POST /v1/payment_intents — request
 * (https://docs.stripe.com/api/payment_intents/create — verified 2026-07-12).
 */
export const paymentIntentCreateReq = z.object({
  /** Positive integer in the smallest currency unit (minor units) — unchanged. */
  amount: z.number().int().positive(),
  /** Three-letter ISO currency code, lowercase. Required. */
  currency: z.string(),
  automatic_payment_methods: automaticPaymentMethods.optional(),
  /** `true` = create + confirm in one call. Defaults to false. */
  confirm: z.boolean().optional(),
  /** Customer id (`cus_*`) this intent belongs to. */
  customer: z.string().optional(),
  description: z.string().optional(),
  metadata: metadataSchema.optional(),
  /** PaymentMethod id (`pm_*`) to attach. */
  payment_method: z.string().optional(),
  /** Payment method types to accept (e.g. `["card", "link"]`). */
  payment_method_types: z.array(z.string()).optional(),
  receipt_email: z.string().optional(),
  /** `automatic` | `automatic_async` (default) | `manual`. */
  capture_method: z.enum(["automatic", "automatic_async", "manual"]).optional(),
  confirmation_method: z.enum(["automatic", "manual"]).optional(),
  setup_future_usage: z.enum(["on_session", "off_session"]).optional(),
  /** ≤22 chars — statement text for non-card charges. */
  statement_descriptor: z.string().max(22).optional(),
  /** ≤22 chars — suffix appended to the account descriptor for card charges. */
  statement_descriptor_suffix: z.string().max(22).optional(),
  /** Redirect URL after off-page authentication (use with `confirm: true`). */
  return_url: z.string().optional(),
  /** Customer is not in the checkout flow (docs type: boolean or string). */
  off_session: z.union([z.boolean(), z.string()]).optional(),
  /** Transaction-group identifier for Connect. */
  transfer_group: z.string().optional(),
  /** Connect application fee, integer minor units. */
  application_fee_amount: z.number().int().optional(),
});
export type PaymentIntentCreateReq = z.input<typeof paymentIntentCreateReq>;

/**
 * POST /v1/payment_intents/{id}/confirm — request
 * (https://docs.stripe.com/api/payment_intents/confirm — verified 2026-07-12).
 */
export const paymentIntentConfirmReq = z.object({
  /** PaymentMethod id (`pm_*`) to use for this confirmation attempt. */
  payment_method: z.string().optional(),
  /** Redirect URL after authentication for redirect-based methods. */
  return_url: z.string().optional(),
  receipt_email: z.string().optional(),
  setup_future_usage: z.enum(["on_session", "off_session"]).optional(),
  capture_method: z.enum(["automatic", "automatic_async", "manual"]).optional(),
  /** Customer is not in the checkout flow (docs type: boolean or string). */
  off_session: z.union([z.boolean(), z.string()]).optional(),
  /** ConfirmationToken id capturing client-collected payment details. */
  confirmation_token: z.string().optional(),
  /** Fail (instead of returning `requires_action`) when an action is needed. */
  error_on_requires_action: z.boolean().optional(),
  /** Mandate id to use for this confirmation. */
  mandate: z.string().optional(),
});
export type PaymentIntentConfirmReq = z.input<typeof paymentIntentConfirmReq>;

/**
 * POST /v1/payment_intents/{id}/capture — request
 * (https://docs.stripe.com/api/payment_intents/capture — verified 2026-07-12).
 */
export const paymentIntentCaptureReq = z.object({
  /** Integer minor units to capture; defaults to full `amount_capturable`. */
  amount_to_capture: z.number().int().positive().optional(),
  /** Connect application fee, integer minor units. */
  application_fee_amount: z.number().int().optional(),
  /** Default true. `false` retains uncaptured funds (multicapture accounts). */
  final_capture: z.boolean().optional(),
  metadata: metadataSchema.optional(),
  /** ≤22 chars — statement text for non-card charges. */
  statement_descriptor: z.string().max(22).optional(),
  /** ≤22 chars — suffix appended to the account descriptor for card charges. */
  statement_descriptor_suffix: z.string().max(22).optional(),
});
export type PaymentIntentCaptureReq = z.input<typeof paymentIntentCaptureReq>;

/**
 * POST /v1/payment_intents/{id}/cancel — request
 * (https://docs.stripe.com/api/payment_intents/cancel — verified 2026-07-12).
 */
export const paymentIntentCancelReq = z.object({
  cancellation_reason: z
    .enum(["duplicate", "fraudulent", "requested_by_customer", "abandoned"])
    .optional(),
});
export type PaymentIntentCancelReq = z.input<typeof paymentIntentCancelReq>;

/**
 * GET /v1/payment_intents — query params
 * (https://docs.stripe.com/api/payment_intents/list — verified 2026-07-12).
 * `created` reaches the URL as bracket keys (`created[gte]`).
 */
export const paymentIntentListQuery = z.object({
  ...listCursorFields,
  /** Filter by Customer id. */
  customer: z.string().optional(),
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
});
export type PaymentIntentListQuery = z.input<typeof paymentIntentListQuery>;

/**
 * A PaymentIntent as returned by every endpoint
 * (https://docs.stripe.com/api/payment_intents/object). LOOSE: only stable
 * documented fields are named; everything else passes through. All amounts are
 * integer minor units.
 */
export const paymentIntent = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  amount: z.number().optional(),
  amount_capturable: z.number().optional(),
  amount_received: z.number().optional(),
  currency: z.string().optional(),
  /**
   * `requires_payment_method` | `requires_confirmation` | `requires_action` |
   * `processing` | `requires_capture` | `canceled` | `succeeded` —
   * normalization is the unified layer's job.
   */
  status: z.string().optional(),
  client_secret: z.string().nullable().optional(),
  capture_method: z.string().optional(),
  confirmation_method: z.string().optional(),
  /** Customer id string, or an expanded object — kept unknown. */
  customer: z.unknown().optional(),
  description: z.string().nullable().optional(),
  /** Latest Charge id string, or an expanded object — kept unknown. */
  latest_charge: z.unknown().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  /** PaymentMethod id string, or an expanded object — kept unknown. */
  payment_method: z.unknown().optional(),
  receipt_email: z.string().nullable().optional(),
  /** Client-side action required to continue — kept loose. */
  next_action: z.looseObject({}).nullable().optional(),
  cancellation_reason: z.string().nullable().optional(),
  canceled_at: z.number().nullable().optional(),
  created: z.number().optional(),
  livemode: z.boolean().optional(),
});
