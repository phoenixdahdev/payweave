/**
 * Zod schemas for Paystack Plans + Subscriptions.
 * Docs:
 *   - Plan:         https://paystack.com/docs/api/plan/
 *   - Subscription: https://paystack.com/docs/api/subscription/
 */
import { z } from "zod";

/** Billing intervals Paystack documents for plans. */
const planInterval = z.enum([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "biannually",
  "annually",
]);

/** POST /plan — request. */
export const createPlanReq = z.object({
  /** Plan name. Required. */
  name: z.string(),
  /** Amount in KOBO (minor units). Required. */
  amount: z.number().int().nonnegative(),
  /** Billing interval. Required. */
  interval: planInterval,
  description: z.string().optional(),
  send_invoices: z.boolean().optional(),
  send_sms: z.boolean().optional(),
  currency: z.string().optional(),
  invoice_limit: z.number().int().optional(),
});
export type CreatePlanReq = z.input<typeof createPlanReq>;

/** GET /plan — query. */
export const listPlansQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  status: z.string().optional(),
  interval: planInterval.optional(),
  amount: z.number().int().optional(),
});
export type ListPlansQuery = z.input<typeof listPlansQuery>;

/** A plan object (loose). */
export const plan = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  plan_code: z.string().optional(),
  description: z.string().nullable().optional(),
  amount: z.number().optional(),
  interval: z.string().optional(),
  currency: z.string().optional(),
  send_invoices: z.boolean().optional(),
  send_sms: z.boolean().optional(),
  hosted_page: z.boolean().optional(),
  integration: z.number().optional(),
  domain: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/** POST /subscription — request. */
export const createSubscriptionReq = z.object({
  /** Customer code or email. Required. */
  customer: z.string(),
  /** Plan code. Required. */
  plan: z.string(),
  /** Authorization code to charge (optional; defaults to the customer's). */
  authorization: z.string().optional(),
  start_date: z.string().optional(),
});
export type CreateSubscriptionReq = z.input<typeof createSubscriptionReq>;

/** GET /subscription — query. */
export const listSubscriptionsQuery = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  customer: z.number().int().optional(),
  plan: z.number().int().optional(),
});
export type ListSubscriptionsQuery = z.input<typeof listSubscriptionsQuery>;

/** POST /subscription/enable | /subscription/disable — request. */
export const toggleSubscriptionReq = z.object({
  /** Subscription code. Required. */
  code: z.string(),
  /** Email token from the subscription. Required. */
  token: z.string(),
});
export type ToggleSubscriptionReq = z.input<typeof toggleSubscriptionReq>;

/** A subscription object (loose). */
export const subscription = z.looseObject({
  id: z.number().optional(),
  subscription_code: z.string().optional(),
  email_token: z.string().optional(),
  status: z.string().optional(),
  amount: z.number().optional(),
  quantity: z.number().optional(),
  customer: z.union([z.number(), z.looseObject({})]).optional(),
  plan: z.union([z.number(), z.looseObject({})]).optional(),
  authorization: z.looseObject({}).optional(),
  start: z.number().optional(),
  next_payment_date: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
