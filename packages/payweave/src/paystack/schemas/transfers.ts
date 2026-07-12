/**
 * Zod schemas for Paystack Transfer Recipients, Transfers, and Balance.
 * Docs:
 *   - Transfer recipient: https://paystack.com/docs/api/transfer-recipient/
 *   - Transfer:           https://paystack.com/docs/api/transfer/
 *   - Balance:            https://paystack.com/docs/api/transfer/#balance
 */
import { z } from "zod";
import { metadataSchema } from "../types";

/** POST /transferrecipient — request. */
export const createRecipientReq = z.object({
  /** Recipient type, e.g. "nuban", "mobile_money", "basa". Required. */
  type: z.string(),
  /** Recipient name. Required. */
  name: z.string(),
  account_number: z.string().optional(),
  bank_code: z.string().optional(),
  description: z.string().optional(),
  currency: z.string().optional(),
  authorization_code: z.string().optional(),
  metadata: metadataSchema.optional(),
});
export type CreateRecipientReq = z.input<typeof createRecipientReq>;

/** GET /transferrecipient — query. */
export const listRecipientsQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListRecipientsQuery = z.input<typeof listRecipientsQuery>;

/** A transfer recipient object (loose). */
export const recipient = z.looseObject({
  id: z.number().optional(),
  integration: z.number().optional(),
  domain: z.string().optional(),
  type: z.string().optional(),
  currency: z.string().optional(),
  name: z.string().optional(),
  recipient_code: z.string().optional(),
  active: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  details: z.looseObject({}).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/** POST /transfer — request. */
export const initiateTransferReq = z.object({
  /** Where to debit, currently only "balance". Required. */
  source: z.string(),
  /** Amount in KOBO (minor units). Required. */
  amount: z.number().int().nonnegative(),
  /** Recipient code (`RCP_...`). Required. */
  recipient: z.string(),
  reason: z.string().optional(),
  currency: z.string().optional(),
  reference: z.string().optional(),
});
export type InitiateTransferReq = z.input<typeof initiateTransferReq>;

/** GET /transfer — query. */
export const listTransfersQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  recipient: z.number().int().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListTransfersQuery = z.input<typeof listTransfersQuery>;

/** A transfer object (loose). */
export const transfer = z.looseObject({
  id: z.number().optional(),
  integration: z.number().optional(),
  domain: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().nullable().optional(),
  recipient: z.union([z.number(), z.looseObject({})]).optional(),
  status: z.string().optional(),
  transfer_code: z.string().optional(),
  reference: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/** A single balance row (loose). */
export const balanceEntry = z.looseObject({
  currency: z.string().optional(),
  balance: z.number().optional(),
});
