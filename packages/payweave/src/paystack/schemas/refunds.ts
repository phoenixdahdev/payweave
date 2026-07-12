/**
 * Zod schemas for the Paystack Refunds module.
 * Docs: https://paystack.com/docs/api/refund/
 */
import { z } from "zod";

/** POST /refund — request. */
export const createRefundReq = z.object({
  /** Transaction id or reference to refund. Required. */
  transaction: z.union([z.string(), z.number().int()]),
  /** Amount in KOBO (minor units). Omit to refund the full amount. */
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  customer_note: z.string().optional(),
  merchant_note: z.string().optional(),
});
export type CreateRefundReq = z.input<typeof createRefundReq>;

/** GET /refund — query. */
export const listRefundsQuery = z.object({
  transaction: z.union([z.string(), z.number().int()]).optional(),
  currency: z.string().optional(),
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListRefundsQuery = z.input<typeof listRefundsQuery>;

/** A refund object (loose). */
export const refund = z.looseObject({
  id: z.number().optional(),
  transaction: z.union([z.number(), z.looseObject({})]).optional(),
  integration: z.number().optional(),
  amount: z.number().optional(),
  deducted_amount: z.number().nullable().optional(),
  currency: z.string().optional(),
  channel: z.string().nullable().optional(),
  status: z.string().optional(),
  refunded_by: z.string().nullable().optional(),
  customer_note: z.string().nullable().optional(),
  merchant_note: z.string().nullable().optional(),
  expected_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
