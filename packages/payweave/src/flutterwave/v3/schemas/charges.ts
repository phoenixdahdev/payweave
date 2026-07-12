/**
 * Zod schemas for the Flutterwave v3 direct-charge module (`POST /charges` with
 * a `?type=` selector) plus `POST /validate-charge`. Fields sourced verbatim
 * from the official v3 reference (version selector v3.0.0):
 *   - Card charge:      https://developer.flutterwave.com/v3.0.0/reference/initiate-a-card-charge
 *   - Bank transfer:    https://developer.flutterwave.com/v3.0.0/reference/initiate-a-bank-transfer-charge
 *   - USSD:             https://developer.flutterwave.com/v3.0.0/reference/initiate-a-ussd-charge
 *   - NG account debit: https://developer.flutterwave.com/v3.0.0/reference/initiate-a-nigeria-bank-account-charge
 *   - Validate charge:  https://developer.flutterwave.com/v3.0.0/reference/validate-a-charge
 *
 * Amounts are MAJOR units (Surface A). The card payload is encrypted (3DES) and
 * sent as `{ client }` — see `../encrypt`; plaintext is NEVER logged.
 */
import { z } from "zod";
import { metaSchema } from "../shared";

/**
 * Card-charge plaintext payload (encrypted before it leaves the process). Card
 * PAN/CVV/expiry live here — this object must never be logged.
 */
export const cardChargeReq = z.object({
  card_number: z.string(),
  cvv: z.string(),
  expiry_month: z.string(),
  expiry_year: z.string(),
  currency: z.string(),
  /** Amount in MAJOR units. Passed through unchanged. */
  amount: z.union([z.number(), z.string()]),
  email: z.string(),
  tx_ref: z.string(),
  fullname: z.string().optional(),
  phone_number: z.string().optional(),
  /** Required only for the AVS/NoAuth authorization flows. */
  redirect_url: z.string().optional(),
  /** 3DS / AVS / PIN authorization sub-object (validated loosely). */
  authorization: z.looseObject({}).optional(),
  preauthorize: z.boolean().optional(),
  meta: metaSchema.optional(),
});
export type CardChargeReq = z.input<typeof cardChargeReq>;

/** POST /charges?type=bank_transfer — request body. */
export const bankTransferChargeReq = z.object({
  tx_ref: z.string(),
  amount: z.union([z.number(), z.string()]),
  email: z.string(),
  currency: z.string().optional(),
  fullname: z.string().optional(),
  phone_number: z.string().optional(),
  /** Whether the generated account/number is reusable (permanent). */
  is_permanent: z.boolean().optional(),
  narration: z.string().optional(),
  meta: metaSchema.optional(),
});
export type BankTransferChargeReq = z.input<typeof bankTransferChargeReq>;

/** POST /charges?type=ussd — request body. */
export const ussdChargeReq = z.object({
  tx_ref: z.string(),
  /** Bank code for the USSD-supported bank, e.g. "057". */
  account_bank: z.string(),
  amount: z.union([z.number(), z.string()]),
  email: z.string(),
  currency: z.string().optional(),
  fullname: z.string().optional(),
  phone_number: z.string().optional(),
  meta: metaSchema.optional(),
});
export type UssdChargeReq = z.input<typeof ussdChargeReq>;

/** POST /charges?type=debit_ng_account — request body. */
export const ngAccountChargeReq = z.object({
  tx_ref: z.string(),
  amount: z.union([z.number(), z.string()]),
  account_bank: z.string(),
  account_number: z.string(),
  email: z.string(),
  currency: z.string().optional(),
  fullname: z.string().optional(),
  phone_number: z.string().optional(),
  /** BVN — required by some banks for the NG account-debit flow. */
  bvn: z.string().optional(),
  meta: metaSchema.optional(),
});
export type NgAccountChargeReq = z.input<typeof ngAccountChargeReq>;

/**
 * POST /validate-charge — request body (OTP/PIN follow-up). `type` names the
 * charge method being validated, e.g. "card" | "account" | "ussd".
 */
export const validateChargeReq = z.object({
  otp: z.string(),
  /** The transaction's `flw_ref` from the initial charge response. */
  flw_ref: z.string(),
  type: z.string().optional(),
});
export type ValidateChargeReq = z.input<typeof validateChargeReq>;

/** A charge/validate response `data` object (loose — mirrors a transaction). */
export const chargeData = z.looseObject({
  id: z.number().optional(),
  tx_ref: z.string().nullable().optional(),
  flw_ref: z.string().nullable().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  status: z.string().optional(),
  payment_type: z.string().nullable().optional(),
  processor_response: z.string().nullable().optional(),
  auth_model: z.string().nullable().optional(),
  created_at: z.string().optional(),
  customer: z.looseObject({}).optional(),
  meta: z.unknown().optional(),
});
