/**
 * Zod schemas for the Stripe Products module (PW-603). Request fields are
 * sourced verbatim from the official API reference (all verified 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/products/create
 *   - Retrieve: https://docs.stripe.com/api/products/retrieve
 *   - Update:   https://docs.stripe.com/api/products/update
 *   - Delete:   https://docs.stripe.com/api/products/delete
 *   - List:     https://docs.stripe.com/api/products/list
 *   - Search:   https://docs.stripe.com/api/products/search
 *
 * Products are PW-803's sync target for Payweave plans (`payweave push`,
 * plans-and-features.md §12): in sync flows a product is ARCHIVED
 * (`update({ active: false })`) rather than deleted — DELETE only succeeds
 * for products with no prices attached. `name`, `metadata` and `active` are
 * the fields the push loop leans on.
 *
 * `default_price_data.unit_amount` is integer MINOR units (providers.md
 * §3.1). `default_price_data.currency_options` (per-currency amounts keyed
 * by a dynamic currency code) is deliberately NOT typed in this P0 subset
 * (conservative per AGENTS.md §8, PW-602 precedent) — add it with a docs
 * re-check when multi-currency sync is needed. Response schemas are LOOSE:
 * unknown fields pass through, drift is logged, never thrown.
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema } from "../types";
import { searchReqFields } from "./customers";

/** `marketing_features[]` — up to 15 entries, `name` ≤80 chars. */
const marketingFeatureInput = z.object({
  /** ≤80 chars. */
  name: z.string().max(80),
});

/** `package_dimensions` — all four measurements required when given. */
const packageDimensionsInput = z.object({
  /** Inches, ≤2 decimal places. */
  height: z.number(),
  /** Inches, ≤2 decimal places. */
  length: z.number(),
  /** Ounces, ≤2 decimal places. */
  weight: z.number(),
  /** Inches, ≤2 decimal places. */
  width: z.number(),
});

/** `tax_details` — recommended when calculating taxes (verified 2026-07-12). */
const taxDetailsInput = z.object({
  tax_code: z.string().optional(),
  /** Tax location id — required/optional/unsupported depending on tax code. */
  performance_location: z.string().optional(),
});

/**
 * `default_price_data.custom_unit_amount` — customer-adjustable amounts
 * (verified 2026-07-12). All amounts integer minor units.
 */
const customUnitAmountInput = z.object({
  /** Pass `true` to enable — otherwise omit the whole object. */
  enabled: z.boolean(),
  maximum: z.number().int().optional(),
  minimum: z.number().int().optional(),
  preset: z.number().int().optional(),
});

/**
 * `default_price_data` — generates the product's default Price in the same
 * call (https://docs.stripe.com/api/products/create — verified 2026-07-12).
 * `currency_options` is deliberately untyped here (see module JSDoc).
 */
const defaultPriceDataInput = z.object({
  /** Three-letter ISO currency code, lowercase. Required. */
  currency: z.string(),
  /** Integer minor units (or 0 for a free price). */
  unit_amount: z.number().int().nonnegative().optional(),
  /** Decimal string alternative to `unit_amount` (≤12 decimal places). */
  unit_amount_decimal: z.string().optional(),
  custom_unit_amount: customUnitAmountInput.optional(),
  metadata: metadataSchema.optional(),
  recurring: z
    .object({
      interval: z.enum(["day", "week", "month", "year"]),
      /** Intervals between billings — max 3 years (36 months, 156 weeks). */
      interval_count: z.number().int().optional(),
    })
    .optional(),
  /** Cannot be changed after being set to `inclusive`/`exclusive`. */
  tax_behavior: z.enum(["inclusive", "exclusive", "unspecified"]).optional(),
});

/**
 * Fields shared verbatim by create and update
 * (https://docs.stripe.com/api/products/create +
 * https://docs.stripe.com/api/products/update — verified 2026-07-12).
 */
const productSharedFields = {
  /** Available for purchase. Defaults to true; `false` = archived. */
  active: z.boolean().optional(),
  description: z.string().optional(),
  /** Up to 8 image URLs. */
  images: z.array(z.string()).optional(),
  /** Up to 15 marketing features (pricing tables). */
  marketing_features: z.array(marketingFeatureInput).optional(),
  metadata: metadataSchema.optional(),
  package_dimensions: packageDimensionsInput.optional(),
  /** Whether the product is shipped (physical goods). */
  shippable: z.boolean().optional(),
  /** ≤22 chars, `type=service` subscriptions only. */
  statement_descriptor: z.string().max(22).optional(),
  /** Tax code id — recommended when calculating taxes. */
  tax_code: z.string().optional(),
  tax_details: taxDetailsInput.optional(),
  /** ≤12 chars, `type=service` only. */
  unit_label: z.string().max(12).optional(),
  /** Publicly-accessible webpage for the product. */
  url: z.string().optional(),
};

/**
 * POST /v1/products — request
 * (https://docs.stripe.com/api/products/create — verified 2026-07-12).
 */
export const productCreateReq = z.object({
  /** Displayable product name. Required. */
  name: z.string(),
  ...productSharedFields,
  /** Custom unique id (`prod_*` generated when omitted). */
  id: z.string().optional(),
  /** Create the product's default Price in the same call. */
  default_price_data: defaultPriceDataInput.optional(),
});
export type ProductCreateReq = z.input<typeof productCreateReq>;

/**
 * POST /v1/products/{id} — request
 * (https://docs.stripe.com/api/products/update — verified 2026-07-12).
 * Fields not provided remain unchanged. `active: false` ARCHIVES the product
 * — the sync-flow alternative to deletion (PW-803).
 */
export const productUpdateReq = z.object({
  ...productSharedFields,
  /** Existing Price id (`price_*`) to make the default for this product. */
  default_price: z.string().optional(),
  name: z.string().optional(),
});
export type ProductUpdateReq = z.input<typeof productUpdateReq>;

/**
 * GET /v1/products — query params
 * (https://docs.stripe.com/api/products/list — verified 2026-07-12).
 * `created` reaches the URL as bracket keys; `ids` as explicit indices
 * (`ids[0]=...`).
 */
export const productListQuery = z.object({
  ...listCursorFields,
  /** Only active (or only archived) products. */
  active: z.boolean().optional(),
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
  /** Only these product ids — cannot combine with the cursor params. */
  ids: z.array(z.string()).optional(),
  /** Only shippable (physical) products. */
  shippable: z.boolean().optional(),
  /** Only products with this url. */
  url: z.string().optional(),
});
export type ProductListQuery = z.input<typeof productListQuery>;

/**
 * GET /v1/products/search — request
 * (https://docs.stripe.com/api/products/search — verified 2026-07-12).
 * Example query: `active:'true' AND metadata['order_id']:'6735'`.
 */
export const productSearchReq = z.object({ ...searchReqFields });
export type ProductSearchReq = z.input<typeof productSearchReq>;

/**
 * A Product as returned by every endpoint
 * (https://docs.stripe.com/api/products/object). LOOSE: only stable
 * documented fields are named; everything else passes through.
 */
export const product = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  active: z.boolean().optional(),
  created: z.number().optional(),
  /** Price id string, or an expanded object — kept unknown. */
  default_price: z.unknown().optional(),
  description: z.string().nullable().optional(),
  images: z.array(z.string()).optional(),
  marketing_features: z.array(z.looseObject({})).optional(),
  livemode: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  name: z.string().optional(),
  package_dimensions: z.looseObject({}).nullable().optional(),
  shippable: z.boolean().nullable().optional(),
  statement_descriptor: z.string().nullable().optional(),
  /** Tax code id string, or an expanded object — kept unknown. */
  tax_code: z.unknown().optional(),
  unit_label: z.string().nullable().optional(),
  updated: z.number().optional(),
  url: z.string().nullable().optional(),
});

/**
 * DELETE /v1/products/{id} response — the deletion stub
 * `{ id, object: "product", deleted: true }`
 * (https://docs.stripe.com/api/products/delete — verified 2026-07-12).
 */
export const deletedProduct = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  deleted: z.boolean(),
});
