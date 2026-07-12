/**
 * Zod schemas for the Flutterwave v3 Standard Payments module. Request fields
 * are sourced verbatim from the official v3 reference (version selector pinned
 * to v3.0.0):
 *   - Create payment (Standard): https://developer.flutterwave.com/v3.0.0/reference/standard
 *
 * Amounts are in MAJOR units (naira) — Surface A passes them through unchanged
 * (provider-reference §1); the unified layer owns minor↔major conversion later.
 */
import { z } from "zod";
import { metaSchema } from "../shared";

/** Customer block on a Standard payment. `email` is required by Flutterwave. */
export const paymentCustomer = z.object({
  email: z.string(),
  name: z.string().optional(),
  phonenumber: z.string().optional(),
});

/** Checkout customizations (branding on the hosted page). */
export const paymentCustomizations = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  logo: z.string().optional(),
});

/** A subaccount split entry. Shape kept loose beyond the documented keys. */
export const paymentSubaccount = z.looseObject({
  id: z.string(),
  transaction_split_ratio: z.number().optional(),
  transaction_charge_type: z.string().optional(),
  transaction_charge: z.number().optional(),
});

/** POST /payments — request (Standard hosted checkout). */
export const createPaymentReq = z.object({
  /** Your unique transaction reference. Required. */
  tx_ref: z.string(),
  /** Amount in MAJOR units (e.g. 5000 = ₦5,000). Passed through unchanged. */
  amount: z.union([z.number(), z.string()]),
  /** ISO currency, e.g. "NGN". Defaults to NGN on Flutterwave's side if omitted. */
  currency: z.string().optional(),
  /** URL Flutterwave redirects to after payment. */
  redirect_url: z.string().optional(),
  customer: paymentCustomer,
  /** Comma-separated payment methods, e.g. "card,banktransfer,ussd". */
  payment_options: z.string().optional(),
  customizations: paymentCustomizations.optional(),
  /** Existing payment-plan id to subscribe the customer to. */
  payment_plan: z.union([z.string(), z.number()]).optional(),
  subaccounts: z.array(paymentSubaccount).optional(),
  meta: metaSchema.optional(),
  /** Checkout session lifetime in minutes. */
  session_duration: z.number().optional(),
  /** Max number of retries allowed on the checkout. */
  max_retry_attempt: z.number().optional(),
});
export type CreatePaymentReq = z.input<typeof createPaymentReq>;

/**
 * POST /payments — response data. The hosted checkout URL lives at `data.link`.
 * Loose: only the stable documented field is pinned.
 */
export const paymentInitData = z.looseObject({
  link: z.string(),
});
