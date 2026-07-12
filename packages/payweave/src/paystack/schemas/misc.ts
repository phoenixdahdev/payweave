/**
 * Zod schemas for Paystack Verification + Miscellaneous endpoints.
 * Docs:
 *   - Banks:            https://paystack.com/docs/api/miscellaneous/#bank
 *   - Countries:        https://paystack.com/docs/api/miscellaneous/#country
 *   - States (AVS):     https://paystack.com/docs/api/miscellaneous/#avs-states
 *   - Resolve account:  https://paystack.com/docs/api/verification/#resolve-account
 *   - Resolve card BIN: https://paystack.com/docs/api/verification/#resolve-card-bin
 */
import { z } from "zod";

/** GET /bank — query. */
export const listBanksQuery = z.object({
  /** Country name, e.g. "nigeria" (lowercase, as Paystack documents). */
  country: z.string().optional(),
  use_cursor: z.boolean().optional(),
  perPage: z.number().int().positive().optional(),
  pay_with_bank_transfer: z.boolean().optional(),
  pay_with_bank: z.boolean().optional(),
  gateway: z.string().optional(),
  type: z.string().optional(),
  currency: z.string().optional(),
  next: z.string().optional(),
  previous: z.string().optional(),
});
export type ListBanksQuery = z.input<typeof listBanksQuery>;

/** A bank object (loose). */
export const bank = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  code: z.string().optional(),
  longcode: z.string().nullable().optional(),
  gateway: z.string().nullable().optional(),
  pay_with_bank: z.boolean().optional(),
  active: z.boolean().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
  type: z.string().optional(),
});

/** GET /bank/resolve — query. */
export const resolveAccountQuery = z.object({
  account_number: z.string(),
  bank_code: z.string(),
});
export type ResolveAccountQuery = z.input<typeof resolveAccountQuery>;

/** GET /bank/resolve — response data. */
export const resolvedAccount = z.looseObject({
  account_number: z.string(),
  account_name: z.string(),
  bank_id: z.number().optional(),
});

// NOTE(verify): the AVS "list states" endpoint path (`/address_verification/states`)
// and its item shape (name/slug/abbreviation) are per the Miscellaneous docs; the
// response schema is loose so any drift is logged, never thrown.
/** GET /address_verification/states — query. */
export const listStatesQuery = z.object({
  /** Country code, e.g. "CA" or "NG". */
  country: z.string(),
});
export type ListStatesQuery = z.input<typeof listStatesQuery>;

/** A country object (loose). */
export const country = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  iso_code: z.string().optional(),
  default_currency_code: z.string().optional(),
});

/** A state/AVS object (loose). */
export const avsState = z.looseObject({
  name: z.string().optional(),
  slug: z.string().optional(),
  abbreviation: z.string().optional(),
});

/** GET /decision/bin/:bin — response data. */
export const cardBin = z.looseObject({
  bin: z.string().optional(),
  brand: z.string().optional(),
  sub_brand: z.string().optional(),
  country_code: z.string().optional(),
  country_name: z.string().optional(),
  card_type: z.string().optional(),
  bank: z.string().optional(),
  linked_bank_id: z.number().optional(),
});
