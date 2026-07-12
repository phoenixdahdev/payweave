/**
 * Zod schemas for the Flutterwave v3 Transfers + Beneficiaries modules. Fields
 * sourced verbatim from the official v3 reference (version selector v3.0.0):
 *   - Create transfer:  https://developer.flutterwave.com/v3.0.0/reference/create-a-transfer
 *   - List transfers:   https://developer.flutterwave.com/v3.0.0/reference/list-all-transfers
 *   - Fetch transfer:   https://developer.flutterwave.com/v3.0.0/reference/get-a-transfer
 *   - Transfer fee:     https://developer.flutterwave.com/v3.0.0/reference/get-transfer-fee
 *   - Create beneficiary: https://developer.flutterwave.com/v3.0.0/reference/create-a-transfer-beneficiary
 *   - List beneficiaries: https://developer.flutterwave.com/v3.0.0/reference/list-all-transfer-beneficiaries
 *   - Fetch beneficiary:  https://developer.flutterwave.com/v3.0.0/reference/fetch-a-transfer-beneficiary
 *
 * Amounts are MAJOR units (Surface A) and pass through unchanged.
 */
import { z } from "zod";
import { metaSchema } from "../shared";

/** POST /transfers — request body. */
export const createTransferReq = z.object({
  /** Recipient bank code. */
  account_bank: z.string(),
  account_number: z.string(),
  /** Amount in MAJOR units. Passed through unchanged. */
  amount: z.union([z.number(), z.string()]),
  currency: z.string().optional(),
  narration: z.string().optional(),
  /** Your unique transfer reference. */
  reference: z.string().optional(),
  callback_url: z.string().optional(),
  /** Currency to debit the balance in (for cross-currency transfers). */
  debit_currency: z.string().optional(),
  beneficiary_name: z.string().optional(),
  /** Saved beneficiary id to transfer to instead of raw account details. */
  beneficiary: z.number().optional(),
  meta: metaSchema.optional(),
});
export type CreateTransferReq = z.input<typeof createTransferReq>;

/** GET /transfers — query params. */
export const listTransfersQuery = z.object({
  page: z.number().int().positive().optional(),
  status: z.string().optional(),
});
export type ListTransfersQuery = z.input<typeof listTransfersQuery>;

/** GET /transfers/fee — query params. `amount` is MAJOR units. */
export const transferFeeQuery = z.object({
  amount: z.union([z.number(), z.string()]),
  currency: z.string().optional(),
  /** Fee category, e.g. "account" | "mobilemoney". */
  type: z.string().optional(),
});
export type TransferFeeQuery = z.input<typeof transferFeeQuery>;

/** A transfer object (loose). */
export const transfer = z.looseObject({
  id: z.number().optional(),
  account_number: z.string().optional(),
  bank_code: z.string().optional(),
  full_name: z.string().optional(),
  created_at: z.string().optional(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  fee: z.number().optional(),
  status: z.string().optional(),
  reference: z.string().nullable().optional(),
  narration: z.string().nullable().optional(),
  complete_message: z.string().nullable().optional(),
  bank_name: z.string().optional(),
});

/** A transfer-fee object (loose). */
export const transferFee = z.looseObject({
  currency: z.string().optional(),
  fee_type: z.string().optional(),
  fee: z.number().optional(),
});

/** POST /beneficiaries — request body. */
export const createBeneficiaryReq = z.object({
  account_bank: z.string(),
  account_number: z.string(),
  beneficiary_name: z.string().optional(),
  currency: z.string().optional(),
  bank_name: z.string().optional(),
});
export type CreateBeneficiaryReq = z.input<typeof createBeneficiaryReq>;

/** GET /beneficiaries — query params. */
export const listBeneficiariesQuery = z.object({
  page: z.number().int().positive().optional(),
});
export type ListBeneficiariesQuery = z.input<typeof listBeneficiariesQuery>;

/** A beneficiary object (loose). */
export const beneficiary = z.looseObject({
  id: z.number().optional(),
  account_number: z.string().optional(),
  account_name: z.string().optional(),
  bank_name: z.string().optional(),
  bank_code: z.string().optional(),
  full_name: z.string().optional(),
  created_at: z.string().optional(),
});
