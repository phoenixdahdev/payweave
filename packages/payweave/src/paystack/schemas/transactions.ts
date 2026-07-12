/**
 * Zod schemas for the Paystack Transactions module. Request fields are sourced
 * verbatim from the official API reference:
 *   - Initialize: https://paystack.com/docs/api/transaction/#initialize
 *   - Verify:     https://paystack.com/docs/api/transaction/#verify
 *   - List:       https://paystack.com/docs/api/transaction/#list
 *   - Fetch:      https://paystack.com/docs/api/transaction/#fetch
 *   - Charge auth:https://paystack.com/docs/api/transaction/#charge-authorization
 *   - Partial debit: https://paystack.com/docs/api/transaction/#partial-debit
 *
 * Amounts are in KOBO (minor units) and are passed through unchanged.
 */
import { z } from "zod";
import { metadataSchema } from "../types";

/** Payment channels Paystack recognises (loose — provider may add more). */
const channelEnum = z.enum([
  "card",
  "bank",
  "ussd",
  "qr",
  "mobile_money",
  "bank_transfer",
  "eft",
]);

/** POST /transaction/initialize — request. */
export const initializeReq = z.object({
  /** Customer email. Required by Paystack. */
  email: z.string(),
  /** Amount in KOBO (minor units) — passed through unchanged (e.g. 500000 = ₦5,000). */
  amount: z.number().int().nonnegative(),
  currency: z.string().optional(),
  /** Your unique transaction reference. If omitted, Paystack generates one. */
  reference: z.string().optional(),
  callback_url: z.string().optional(),
  plan: z.string().optional(),
  invoice_limit: z.number().int().optional(),
  metadata: metadataSchema.optional(),
  channels: z.array(channelEnum).optional(),
  split_code: z.string().optional(),
  subaccount: z.string().optional(),
  transaction_charge: z.number().int().optional(),
  bearer: z.enum(["account", "subaccount"]).optional(),
});
export type InitializeReq = z.input<typeof initializeReq>;

/** POST /transaction/initialize — response data. */
export const initializeData = z.looseObject({
  authorization_url: z.string(),
  access_code: z.string(),
  reference: z.string(),
});

/**
 * A transaction object as returned by verify/list/fetch. Loose: only the
 * stable, documented top-level fields are named; everything else passes through.
 */
export const transaction = z.looseObject({
  id: z.number(),
  domain: z.string().optional(),
  status: z.string().optional(),
  reference: z.string().optional(),
  amount: z.number().optional(),
  message: z.string().nullable().optional(),
  gateway_response: z.string().nullable().optional(),
  paid_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  channel: z.string().nullable().optional(),
  currency: z.string().optional(),
  ip_address: z.string().nullable().optional(),
  metadata: z.unknown().optional(),
  customer: z.looseObject({}).optional(),
  authorization: z.looseObject({}).optional(),
  requested_amount: z.number().optional(),
});

/** GET /transaction — query params. */
export const listQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  customer: z.number().int().optional(),
  terminalid: z.string().optional(),
  status: z.enum(["failed", "success", "abandoned"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  amount: z.number().int().optional(),
});
export type ListQuery = z.input<typeof listQuery>;

/** POST /transaction/charge_authorization — request. */
export const chargeAuthorizationReq = z.object({
  email: z.string(),
  amount: z.number().int().nonnegative(),
  /** Reusable authorization code (`AUTH_...`) from a prior charge. Required. */
  authorization_code: z.string(),
  currency: z.string().optional(),
  reference: z.string().optional(),
  metadata: metadataSchema.optional(),
  channels: z.array(channelEnum).optional(),
  subaccount: z.string().optional(),
  transaction_charge: z.number().int().optional(),
  bearer: z.enum(["account", "subaccount"]).optional(),
  queue: z.boolean().optional(),
});
export type ChargeAuthorizationReq = z.input<typeof chargeAuthorizationReq>;

/** POST /transaction/partial_debit — request. */
export const partialDebitReq = z.object({
  authorization_code: z.string(),
  /** Currency to debit — required by Paystack for partial debit. */
  currency: z.string(),
  amount: z.number().int().nonnegative(),
  email: z.string(),
  reference: z.string().optional(),
  at_least: z.number().int().optional(),
});
export type PartialDebitReq = z.input<typeof partialDebitReq>;

/** GET /transaction/totals — query params. */
export const totalsQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type TotalsQuery = z.input<typeof totalsQuery>;
