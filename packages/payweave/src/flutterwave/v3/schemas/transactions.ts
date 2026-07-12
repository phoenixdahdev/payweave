/**
 * Zod schemas for the Flutterwave v3 Transactions module. Request fields sourced
 * verbatim from the official v3 reference (version selector pinned to v3.0.0):
 *   - Verify by id:        https://developer.flutterwave.com/v3.0.0/reference/verify-transaction
 *   - Verify by reference: https://developer.flutterwave.com/v3.0.0/reference/verify-transaction-by-tx_ref
 *   - List:                https://developer.flutterwave.com/v3.0.0/reference/list-transactions
 *   - Fees:                https://developer.flutterwave.com/v3.0.0/reference/get-transaction-fees
 *
 * Amounts are MAJOR units and pass through unchanged (Surface A).
 */
import { z } from "zod";

/**
 * A Flutterwave v3 transaction object (verify/list). Loose: only the stable,
 * documented top-level fields are named; everything else passes through.
 */
export const transaction = z.looseObject({
  id: z.number(),
  tx_ref: z.string().nullable().optional(),
  flw_ref: z.string().nullable().optional(),
  device_fingerprint: z.string().nullable().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  charged_amount: z.number().optional(),
  app_fee: z.number().optional(),
  merchant_fee: z.number().optional(),
  processor_response: z.string().nullable().optional(),
  auth_model: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  narration: z.string().nullable().optional(),
  /** Flutterwave transaction status, e.g. "successful" | "failed" | "pending". */
  status: z.string().optional(),
  payment_type: z.string().nullable().optional(),
  created_at: z.string().optional(),
  account_id: z.number().optional(),
  amount_settled: z.number().optional(),
  customer: z.looseObject({}).optional(),
  card: z.looseObject({}).optional(),
  meta: z.unknown().optional(),
});

/** GET /transactions — query params. */
export const listQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.number().int().positive().optional(),
  customer_email: z.string().optional(),
  status: z.string().optional(),
  tx_ref: z.string().optional(),
  currency: z.string().optional(),
  amount: z.union([z.number(), z.string()]).optional(),
});
export type ListQuery = z.input<typeof listQuery>;

/** GET /transactions/fee — query params. `amount` is MAJOR units. */
export const feesQuery = z.object({
  amount: z.union([z.number(), z.string()]),
  currency: z.string().optional(),
  /** e.g. "card", "account", "ussd" — the charge type the fee is quoted for. */
  ptype: z.string().optional(),
});
export type FeesQuery = z.input<typeof feesQuery>;

/** GET /transactions/fee — response data (loose). */
export const feeData = z.looseObject({
  charge_amount: z.number().optional(),
  fee: z.number().optional(),
  merchant_fee: z.number().optional(),
  flutterwave_fee: z.number().optional(),
  stamp_duty_fee: z.number().optional(),
  currency: z.string().optional(),
});
