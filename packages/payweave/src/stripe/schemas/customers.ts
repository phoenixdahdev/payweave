/**
 * Zod schemas for the Stripe Customers module. Request fields are
 * sourced verbatim from the official API reference (all verified 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/customers/create
 *   - Retrieve: https://docs.stripe.com/api/customers/retrieve
 *   - Update:   https://docs.stripe.com/api/customers/update
 *   - Delete:   https://docs.stripe.com/api/customers/delete
 *   - List:     https://docs.stripe.com/api/customers/list
 *   - Search:   https://docs.stripe.com/api/customers/search
 *
 * `balance` is an integer in MINOR units — no conversion
 * anywhere. `tax_id_data[].type` is deliberately `z.string()` (the reference
 * lists 100+ country-specific enum values — provider-validated rather than
 * transcribed; conservative). Response schemas are LOOSE:
 * unknown fields pass through, drift is logged, never thrown.
 *
 * Search pagination (verified 2026-07-12 against
 * https://docs.stripe.com/api/pagination/search) is DIFFERENT from list
 * pagination: `query` (required) + `limit` + `page` request params, and a
 * `{ object: "search_result", data, has_more, next_page, url, total_count? }`
 * response — the next page is requested with `page = <next_page token>`, NOT
 * `starting_after`. The shared `iterateStripeList` therefore does not fit;
 * search endpoints get their own iterator (see the resource files).
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema } from "../types";

/**
 * Postal address dictionary — same child fields on `address` and
 * `shipping.address` (https://docs.stripe.com/api/customers/create — verified
 * 2026-07-12).
 */
const addressInput = z.object({
  city: z.string().optional(),
  /** Two-letter country code (ISO 3166-1 alpha-2). */
  country: z.string().optional(),
  line1: z.string().optional(),
  line2: z.string().optional(),
  postal_code: z.string().optional(),
  /** State/county/province/region (ISO 3166-2 recommended). */
  state: z.string().optional(),
});

/** `cash_balance.settings` — verified 2026-07-12. */
const cashBalanceInput = z.object({
  settings: z
    .object({
      reconciliation_mode: z.enum(["automatic", "manual", "merchant_default"]).optional(),
    })
    .optional(),
});

/** `invoice_settings` on create/update — verified 2026-07-12. */
const invoiceSettingsInput = z.object({
  /** Up to 4 custom fields shown on invoices. */
  custom_fields: z
    .array(
      z.object({
        /** ≤40 chars. */
        name: z.string().max(40),
        /** ≤140 chars. */
        value: z.string().max(140),
      }),
    )
    .optional(),
  default_payment_method: z.string().optional(),
  footer: z.string().optional(),
  rendering_options: z
    .object({
      amount_tax_display: z.enum(["exclude_tax", "include_inclusive_tax"]).optional(),
      template: z.string().optional(),
    })
    .optional(),
});

/** `shipping` — `address` and `name` are required when shipping is given. */
const shippingInput = z.object({
  address: addressInput,
  name: z.string(),
  phone: z.string().optional(),
});

/**
 * Fields shared verbatim by create and update
 * (https://docs.stripe.com/api/customers/create +
 * https://docs.stripe.com/api/customers/update — verified 2026-07-12).
 */
const customerSharedFields = {
  /** Required when calculating taxes. */
  address: addressInput.optional(),
  /** Integer MINOR units — a credit/debit applied to future invoices. */
  balance: z.number().int().optional(),
  /** ≤150 chars. */
  business_name: z.string().max(150).optional(),
  cash_balance: cashBalanceInput.optional(),
  description: z.string().optional(),
  /** ≤512 chars. */
  email: z.string().max(512).optional(),
  /** ≤150 chars. */
  individual_name: z.string().max(150).optional(),
  /** 3–12 uppercase letters or numbers (provider-validated). */
  invoice_prefix: z.string().optional(),
  invoice_settings: invoiceSettingsInput.optional(),
  metadata: metadataSchema.optional(),
  /** ≤256 chars. */
  name: z.string().max(256).optional(),
  next_invoice_sequence: z.number().int().optional(),
  /** ≤20 chars. */
  phone: z.string().max(20).optional(),
  preferred_locales: z.array(z.string()).optional(),
  shipping: shippingInput.optional(),
  /** Payment source id; on update it becomes the new default source. */
  source: z.string().optional(),
  tax_exempt: z.enum(["none", "exempt", "reverse"]).optional(),
};

/**
 * POST /v1/customers — request
 * (https://docs.stripe.com/api/customers/create — verified 2026-07-12).
 * Every field is optional — Stripe allows creating an empty customer.
 */
export const customerCreateReq = z.object({
  ...customerSharedFields,
  /** PaymentMethod id (`pm_*`) to attach to the new customer. */
  payment_method: z.string().optional(),
  /** Tax details — recommended when calculating taxes. */
  tax: z
    .object({
      ip_address: z.string().optional(),
      /** Create documents `deferred` (default) | `immediately`. */
      validate_location: z.enum(["deferred", "immediately"]).optional(),
    })
    .optional(),
  /**
   * The customer's tax IDs. `type` is a country-specific code (e.g. `eu_vat`,
   * `us_ein`) — 100+ documented values, provider-validated (kept `string`).
   */
  tax_id_data: z.array(z.object({ type: z.string(), value: z.string() })).optional(),
  /** Test clock id to attach (test mode). */
  test_clock: z.string().optional(),
});
export type CustomerCreateReq = z.input<typeof customerCreateReq>;

/**
 * POST /v1/customers/{id} — request
 * (https://docs.stripe.com/api/customers/update — verified 2026-07-12).
 * Fields not provided remain unchanged; individual `metadata` keys unset by
 * posting an empty string value.
 */
export const customerUpdateReq = z.object({
  ...customerSharedFields,
  /** Payment source id to make the customer's new default (≤500 chars). */
  default_source: z.string().max(500).optional(),
  /** Tax details — recommended when calculating taxes. */
  tax: z
    .object({
      ip_address: z.string().optional(),
      /** Update documents `auto` (default) | `deferred` | `immediately`. */
      validate_location: z.enum(["auto", "deferred", "immediately"]).optional(),
    })
    .optional(),
});
export type CustomerUpdateReq = z.input<typeof customerUpdateReq>;

/**
 * GET /v1/customers — query params
 * (https://docs.stripe.com/api/customers/list — verified 2026-07-12).
 * `created` reaches the URL as bracket keys (`created[gte]`).
 */
export const customerListQuery = z.object({
  ...listCursorFields,
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
  /** Case-sensitive exact-match filter on email (≤512 chars). */
  email: z.string().max(512).optional(),
  /** Filter by test clock id. */
  test_clock: z.string().optional(),
});
export type CustomerListQuery = z.input<typeof customerListQuery>;

/**
 * Request params shared by every Stripe search endpoint
 * (https://docs.stripe.com/api/pagination/search — verified 2026-07-12):
 * `query` uses Stripe's search query language
 * (https://docs.stripe.com/search#search-query-language); `page` is the
 * `next_page` token of the previous response — never sent on the first call.
 */
export const searchReqFields = {
  /** Search query string, e.g. `name:'Jane' AND metadata['foo']:'bar'`. */
  query: z.string().min(1, "search query must be a non-empty string"),
  /** Page size, 1–100 (Stripe default 10). */
  limit: z.number().int().min(1).max(100).optional(),
  /** Pagination token from the previous page's `next_page` — omit initially. */
  page: z.string().optional(),
};

/**
 * GET /v1/customers/search — request
 * (https://docs.stripe.com/api/customers/search — verified 2026-07-12).
 */
export const customerSearchReq = z.object({ ...searchReqFields });
export type CustomerSearchReq = z.input<typeof customerSearchReq>;

/**
 * A Customer as returned by every endpoint
 * (https://docs.stripe.com/api/customers/object). LOOSE: only stable
 * documented fields are named; everything else passes through. `balance` is
 * integer minor units.
 */
export const customer = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  address: z.looseObject({}).nullable().optional(),
  /** Integer minor units. */
  balance: z.number().optional(),
  created: z.number().optional(),
  currency: z.string().nullable().optional(),
  /** Source id string, or an expanded object — kept unknown. */
  default_source: z.unknown().optional(),
  delinquent: z.boolean().nullable().optional(),
  description: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  invoice_prefix: z.string().nullable().optional(),
  invoice_settings: z.looseObject({}).optional(),
  livemode: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  name: z.string().nullable().optional(),
  next_invoice_sequence: z.number().optional(),
  phone: z.string().nullable().optional(),
  preferred_locales: z.array(z.string()).nullable().optional(),
  shipping: z.looseObject({}).nullable().optional(),
  /** `none` | `exempt` | `reverse`. */
  tax_exempt: z.string().nullable().optional(),
  /** Test clock id string, or an expanded object — kept unknown. */
  test_clock: z.unknown().optional(),
  /**
   * `true` only on the reduced stub `retrieve` returns for a DELETED customer
   * (https://docs.stripe.com/api/customers/retrieve — verified 2026-07-12:
   * deleted customers stay retrievable "to be able to track their history").
   */
  deleted: z.boolean().optional(),
});

/**
 * DELETE /v1/customers/{id} response — the deletion stub
 * `{ id, object: "customer", deleted: true }`
 * (https://docs.stripe.com/api/customers/delete — verified 2026-07-12).
 */
export const deletedCustomer = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  deleted: z.boolean(),
});
