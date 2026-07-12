/**
 * Zod schemas for the Flutterwave v3 Banks + account-resolution module. Fields
 * sourced verbatim from the official v3 reference (version selector v3.0.0):
 *   - Banks by country: https://developer.flutterwave.com/v3.0.0/reference/get-all-banks
 *   - Bank branches:    https://developer.flutterwave.com/v3.0.0/reference/get-bank-branches
 *   - Resolve account:  https://developer.flutterwave.com/v3.0.0/reference/resolve-account-details
 */
import { z } from "zod";

/** A bank object as returned by `GET /banks/:country` (loose). */
export const bank = z.looseObject({
  id: z.number().optional(),
  code: z.string().optional(),
  name: z.string().optional(),
});

/** A bank branch as returned by `GET /banks/:id/branches` (loose). */
export const bankBranch = z.looseObject({
  id: z.number().optional(),
  branch_code: z.string().optional(),
  branch_name: z.string().optional(),
  swift_code: z.string().nullable().optional(),
  bic: z.string().nullable().optional(),
  bank_id: z.number().optional(),
});

/** POST /accounts/resolve — request body. */
export const resolveAccountReq = z.object({
  account_number: z.string(),
  /** The bank code (from `GET /banks/:country`). */
  account_bank: z.string(),
});
export type ResolveAccountReq = z.input<typeof resolveAccountReq>;

/** POST /accounts/resolve — response data (loose). */
export const resolvedAccount = z.looseObject({
  account_number: z.string().optional(),
  account_name: z.string().optional(),
});
