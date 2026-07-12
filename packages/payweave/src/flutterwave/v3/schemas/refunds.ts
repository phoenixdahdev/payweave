/**
 * Zod schemas for the Flutterwave v3 Refunds module. Fields sourced verbatim
 * from the official v3 reference (version selector v3.0.0):
 *   - Create refund: https://developer.flutterwave.com/v3.0.0/reference/refund-a-transaction
 *   - List refunds:  https://developer.flutterwave.com/v3.0.0/reference/get-all-refunds
 *   - Fetch refund:  https://developer.flutterwave.com/v3.0.0/reference/get-a-refund
 *
 * Amounts are MAJOR units (Surface A) and pass through unchanged.
 */
import { z } from "zod";

/** POST /transactions/:id/refund — request body. Omit `amount` to refund fully. */
export const createRefundReq = z.object({
  /** Amount to refund in MAJOR units. Omit for a full refund. */
  amount: z.union([z.number(), z.string()]).optional(),
});
export type CreateRefundReq = z.input<typeof createRefundReq>;

/** GET /refunds — query params. */
export const listRefundsQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.number().int().positive().optional(),
  status: z.string().optional(),
});
export type ListRefundsQuery = z.input<typeof listRefundsQuery>;

/** A refund object (loose). */
export const refund = z.looseObject({
  id: z.number().optional(),
  account_id: z.number().optional(),
  tx_id: z.number().optional(),
  flw_ref: z.string().nullable().optional(),
  amount_refunded: z.number().optional(),
  status: z.string().optional(),
  destination: z.string().nullable().optional(),
  meta: z.unknown().optional(),
  created_at: z.string().optional(),
});
