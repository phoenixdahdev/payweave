/**
 * Zod schemas for the Stripe Refunds module (PW-605). Request fields are
 * sourced verbatim from the official API reference (all verified 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/refunds/create
 *   - Retrieve: https://docs.stripe.com/api/refunds/retrieve
 *   - Update:   https://docs.stripe.com/api/refunds/update
 *   - Cancel:   https://docs.stripe.com/api/refunds/cancel
 *   - List:     https://docs.stripe.com/api/refunds/list
 *   - Object:   https://docs.stripe.com/api/refunds/object
 *
 * `amount` is integer MINOR units end to end (providers.md §3.1) — no
 * conversion anywhere. Documented response fields whose child shapes we have
 * not fully verified against the reference (`destination_details`'s ~40
 * payment-method-specific hashes, `next_action.display_details`) are
 * deliberately kept loose/untyped in this P0 subset (conservative wins,
 * AGENTS.md §8). Response schemas are LOOSE: unknown fields pass through,
 * drift is logged, never thrown.
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema } from "../types";

/**
 * POST /v1/refunds — request
 * (https://docs.stripe.com/api/refunds/create — verified 2026-07-12).
 *
 * Per the docs, a Charge or PaymentIntent identifier is required unless
 * `origin: "customer_balance"` is provided — enforced here so an untargeted
 * refund fails BEFORE any network call (refunds move money; parse-before-send).
 */
export const refundCreateReq = z
  .object({
    /**
     * Positive integer in the smallest currency unit (minor units) — "can
     * refund only up to the remaining, unrefunded amount of the charge".
     * Omit to refund in full.
     */
    amount: z.number().int().positive().optional(),
    /** The identifier of the charge to refund (`ch_*`). */
    charge: z.string().optional(),
    /**
     * The identifier of the PaymentIntent to refund (`pi_*`) — the path the
     * unified layer uses (providers.md §3.3: refunds go against the payment
     * intent).
     */
    payment_intent: z.string().optional(),
    /**
     * Reason for the refund. If set: `duplicate` | `fraudulent` |
     * `requested_by_customer`.
     */
    reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
    /**
     * For payment methods without native refund support (e.g. Konbini,
     * PromptPay) — customer email to receive refund instructions.
     */
    instructions_email: z.string().optional(),
    metadata: metadataSchema.optional(),
    /**
     * Origin of the refund. `customer_balance` refunds from a Customer
     * Balance instead of a Charge/PaymentIntent — when provided, a
     * Charge/PaymentIntent identifier is not required.
     */
    origin: z.enum(["customer_balance"]).optional(),
    /**
     * Whether the application fee should be refunded too (refundable only by
     * the application that created the charge — Connect).
     */
    refund_application_fee: z.boolean().optional(),
    /**
     * Whether the transfer should be reversed when refunding (reversible only
     * by the application that created the charge — Connect).
     */
    reverse_transfer: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.charge !== undefined || v.payment_intent !== undefined || v.origin !== undefined,
    {
      message:
        "one of charge, payment_intent, or origin is required " +
        "(https://docs.stripe.com/api/refunds/create)",
    },
  );
export type RefundCreateReq = z.input<typeof refundCreateReq>;

/**
 * POST /v1/refunds/{id} — request
 * (https://docs.stripe.com/api/refunds/update — verified 2026-07-12).
 * `metadata` is the ONLY updatable field on a refund; individual keys are
 * unset by posting an empty string value.
 */
export const refundUpdateReq = z.object({
  metadata: metadataSchema.optional(),
});
export type RefundUpdateReq = z.input<typeof refundUpdateReq>;

/**
 * GET /v1/refunds — query params
 * (https://docs.stripe.com/api/refunds/list — verified 2026-07-12).
 * `created` reaches the URL as bracket keys (`created[gte]`).
 */
export const refundListQuery = z.object({
  ...listCursorFields,
  /** Only return refunds for this Charge id. */
  charge: z.string().optional(),
  /** Only return refunds for this PaymentIntent id. */
  payment_intent: z.string().optional(),
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
});
export type RefundListQuery = z.input<typeof refundListQuery>;

/**
 * A Refund as returned by every endpoint
 * (https://docs.stripe.com/api/refunds/object — verified 2026-07-12). LOOSE:
 * only stable documented fields are named; everything else passes through.
 * All amounts are integer minor units.
 *
 * Conservative-untyped child shapes (AGENTS.md §8): `destination_details`
 * (~40 payment-method-specific hashes, e.g. `card.reference_status`) and
 * `next_action` (`display_details.email_sent` etc.) stay loose objects;
 * expandable references (`balance_transaction`, `charge`, `payment_intent`,
 * `failure_balance_transaction`, `source_transfer_reversal`,
 * `transfer_reversal`) are id string OR expanded object — kept `unknown`.
 */
export const refund = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  amount: z.number().optional(),
  /** Balance transaction id string, or an expanded object — kept unknown. */
  balance_transaction: z.unknown().optional(),
  /** Charge id string, or an expanded object — kept unknown. */
  charge: z.unknown().optional(),
  created: z.number().optional(),
  currency: z.string().optional(),
  /** Non-card refunds only. */
  description: z.string().nullable().optional(),
  /** Transaction-specific details — child hashes deliberately untyped. */
  destination_details: z.looseObject({}).nullable().optional(),
  /** Balance transaction reversing the initial one after a failed refund. */
  failure_balance_transaction: z.unknown().optional(),
  /**
   * `lost_or_stolen_card` | `expired_or_canceled_card` |
   * `charge_for_pending_refund_disputed` | `insufficient_funds` | `declined` |
   * `merchant_request` | `unknown` — kept loose (drift logs, never throws).
   */
  failure_reason: z.string().nullable().optional(),
  instructions_email: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  /** Present when status is `requires_action` — child shape kept loose. */
  next_action: z.looseObject({}).nullable().optional(),
  /** PaymentIntent id string, or an expanded object — kept unknown. */
  payment_intent: z.unknown().optional(),
  /** `processing` | `insufficient_funds` | `charge_pending` — kept loose. */
  pending_reason: z.string().nullable().optional(),
  /**
   * `duplicate` | `fraudulent` | `requested_by_customer` or Stripe-generated
   * `expired_uncaptured_charge` — kept loose.
   */
  reason: z.string().nullable().optional(),
  receipt_number: z.string().nullable().optional(),
  /** Transfer reversal id string, or an expanded object — kept unknown. */
  source_transfer_reversal: z.unknown().optional(),
  /**
   * `pending` | `requires_action` | `succeeded` | `failed` | `canceled` —
   * normalization is the unified layer's job (providers.md §3.3).
   */
  status: z.string().nullable().optional(),
  /** Transfer reversal id string, or an expanded object — kept unknown. */
  transfer_reversal: z.unknown().optional(),
});
