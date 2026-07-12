/**
 * Zod schemas for the Paystack Customers module.
 * Docs: https://paystack.com/docs/api/customer/
 */
import { z } from "zod";
import { metadataSchema } from "../types";

/** POST /customer — request. */
export const createCustomerReq = z.object({
  /** Customer email. Required. */
  email: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  metadata: metadataSchema.optional(),
});
export type CreateCustomerReq = z.input<typeof createCustomerReq>;

/** PUT /customer/:code — request (update). */
export const updateCustomerReq = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  metadata: metadataSchema.optional(),
});
export type UpdateCustomerReq = z.input<typeof updateCustomerReq>;

/** GET /customer — query. */
export const listCustomersQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListCustomersQuery = z.input<typeof listCustomersQuery>;

/**
 * POST /customer/:code/identification — request (validate).
 * Docs: https://paystack.com/docs/api/customer/#validate
 */
export const validateCustomerReq = z.object({
  /** e.g. "NG". Required. */
  country: z.string(),
  /** Predefined type of identification, e.g. "bank_account". Required. */
  type: z.string(),
  account_number: z.string().optional(),
  bvn: z.string().optional(),
  bank_code: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  middle_name: z.string().optional(),
  value: z.string().optional(),
});
export type ValidateCustomerReq = z.input<typeof validateCustomerReq>;

/**
 * POST /customer/set_risk_action — request.
 * Docs: https://paystack.com/docs/api/customer/#whitelist-blacklist
 */
export const setRiskActionReq = z.object({
  /** Customer code or email. Required. */
  customer: z.string(),
  /** allow (whitelist), deny (blacklist), or default. Required. */
  risk_action: z.enum(["default", "allow", "deny"]),
});
export type SetRiskActionReq = z.input<typeof setRiskActionReq>;

/** A customer object (loose). */
export const customer = z.looseObject({
  id: z.number().optional(),
  integration: z.number().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().optional(),
  phone: z.string().nullable().optional(),
  customer_code: z.string().optional(),
  domain: z.string().optional(),
  risk_action: z.string().optional(),
  metadata: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
