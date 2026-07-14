/**
 * Zod schemas for the Stripe Prices module. Request fields are
 * sourced verbatim from the official API reference (all verified 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/prices/create
 *   - Retrieve: https://docs.stripe.com/api/prices/retrieve
 *   - Update:   https://docs.stripe.com/api/prices/update
 *   - List:     https://docs.stripe.com/api/prices/list
 *   - Search:   https://docs.stripe.com/api/prices/search
 *
 * Prices are PW-803's sync target for Payweave plan pricing (`payweave push`,
 * plans-and-features.md §12). Two facts the push loop leans on (both verified
 * 2026-07-12 on the pages above):
 *   1. Prices are largely IMMUTABLE — `unit_amount`, `currency`, `product`,
 *      `recurring`, `billing_scheme`, `tiers` etc. cannot change after
 *      creation. The update endpoint accepts ONLY `active`, `lookup_key`,
 *      `metadata`, `nickname`, `tax_behavior` (until set to
 *      inclusive/exclusive), `transfer_lookup_key` and `currency_options`.
 *      A price change means a NEW Price + archiving the old one
 *      (`active: false`) — there is NO delete endpoint for prices.
 *   2. `lookup_key` (≤200 chars) + `transfer_lookup_key: true` atomically
 *      move a stable identifier onto the replacement price.
 *
 * `unit_amount` is integer MINOR units end to end — no
 * conversion anywhere. `currency_options` (per-currency amounts keyed by a
 * dynamic currency code) is deliberately NOT typed in this P0 subset
 * (conservative per AGENTS.md §8, PW-602 precedent) — add it with a docs
 * re-check when multi-currency sync is needed. Response schemas are LOOSE:
 * unknown fields pass through, drift is logged, never thrown.
 */
import { z } from "zod";
import { createdRange, listCursorFields, metadataSchema } from "../types";
import { searchReqFields } from "./customers";

/**
 * `custom_unit_amount` — customer-adjustable amounts during Checkout/Payment
 * Links (verified 2026-07-12). All amounts integer minor units.
 */
const customUnitAmountInput = z.object({
  /** Pass `true` to enable — otherwise omit the whole object. */
  enabled: z.boolean(),
  maximum: z.number().int().optional(),
  minimum: z.number().int().optional(),
  preset: z.number().int().optional(),
});

/**
 * `recurring` — the components of a recurring price
 * (https://docs.stripe.com/api/prices/create — verified 2026-07-12).
 */
const recurringInput = z.object({
  interval: z.enum(["day", "week", "month", "year"]),
  /** Intervals between billings — max 3 years (36 months, 156 weeks). */
  interval_count: z.number().int().optional(),
  /** Defaults to `licensed`. */
  usage_type: z.enum(["licensed", "metered"]).optional(),
  /** Billing Meter id tracking usage for a metered price. */
  meter: z.string().optional(),
});

/**
 * One `tiers[]` element — required when `billing_scheme=tiered`
 * (verified 2026-07-12). `up_to` is an integer bound or the literal `"inf"`
 * for the fallback tier; amounts are integer minor units (`*_decimal`
 * variants are decimal strings).
 */
const tierInput = z.object({
  /** Upper bound of this tier — `"inf"` for the fallback tier. Required. */
  up_to: z.union([z.literal("inf"), z.number().int()]),
  /** Flat amount for the whole tier, integer minor units. */
  flat_amount: z.number().int().optional(),
  /** Decimal-string alternative to `flat_amount` (only one of the two). */
  flat_amount_decimal: z.string().optional(),
  /** Per-unit amount, integer minor units. */
  unit_amount: z.number().int().optional(),
  /** Decimal-string alternative to `unit_amount` (only one of the two). */
  unit_amount_decimal: z.string().optional(),
});

/**
 * `product_data` — create the backing Product in the same call (alternative
 * to `product`; https://docs.stripe.com/api/prices/create — verified
 * 2026-07-12).
 */
const productDataInput = z.object({
  /** Displayable product name. Required. */
  name: z.string(),
  /** Defaults to true. */
  active: z.boolean().optional(),
  metadata: metadataSchema.optional(),
  /** ≤22 chars; may not include `<`, `>`, `\`, `"`, `'`. */
  statement_descriptor: z.string().max(22).optional(),
  /** Tax code id — recommended when calculating taxes. */
  tax_code: z.string().optional(),
  tax_details: z
    .object({
      tax_code: z.string().optional(),
      /** Tax location id — required/optional/unsupported per tax code. */
      performance_location: z.string().optional(),
    })
    .optional(),
  /** ≤12 chars. */
  unit_label: z.string().max(12).optional(),
});

/**
 * POST /v1/prices — request
 * (https://docs.stripe.com/api/prices/create — verified 2026-07-12).
 * One of `unit_amount` / `unit_amount_decimal` / `custom_unit_amount` is
 * required unless `billing_scheme=tiered`; one of `product` / `product_data`
 * is always required — both provider-validated. `currency_options` is
 * deliberately untyped (see module JSDoc).
 */
export const priceCreateReq = z.object({
  /** Three-letter ISO currency code, lowercase. Required. */
  currency: z.string(),
  /** Integer minor units (or 0 for a free price). */
  unit_amount: z.number().int().nonnegative().optional(),
  /** Decimal string alternative to `unit_amount` (≤12 decimal places). */
  unit_amount_decimal: z.string().optional(),
  custom_unit_amount: customUnitAmountInput.optional(),
  /** Usable for new purchases. Defaults to true; `false` = archived. */
  active: z.boolean().optional(),
  /** Defaults to `per_unit`. */
  billing_scheme: z.enum(["per_unit", "tiered"]).optional(),
  /** Stable retrieval key (≤200 chars) — PW-803's price identifier. */
  lookup_key: z.string().max(200).optional(),
  /** Atomically move `lookup_key` off the price currently holding it. */
  transfer_lookup_key: z.boolean().optional(),
  metadata: metadataSchema.optional(),
  /** Internal description, hidden from customers. */
  nickname: z.string().optional(),
  /** Existing Product id (`prod_*`). Alternative to `product_data`. */
  product: z.string().optional(),
  /** Inline Product creation. Alternative to `product`. */
  product_data: productDataInput.optional(),
  recurring: recurringInput.optional(),
  /** Cannot be changed after being set to `inclusive`/`exclusive`. */
  tax_behavior: z.enum(["inclusive", "exclusive", "unspecified"]).optional(),
  /** Required when `billing_scheme=tiered`. */
  tiers: z.array(tierInput).optional(),
  /** Required when `billing_scheme=tiered`. */
  tiers_mode: z.enum(["graduated", "volume"]).optional(),
  /** Transform reported quantity before billing — cannot combine with tiers. */
  transform_quantity: z
    .object({
      divide_by: z.number().int(),
      round: z.enum(["up", "down"]),
    })
    .optional(),
});
export type PriceCreateReq = z.input<typeof priceCreateReq>;

/**
 * POST /v1/prices/{id} — request
 * (https://docs.stripe.com/api/prices/update — verified 2026-07-12).
 * ONLY these fields are updatable — amount/currency/product/recurring are
 * immutable after creation (see module JSDoc; a price change = new Price +
 * `active: false` on the old one). `currency_options` is deliberately
 * untyped (see module JSDoc).
 */
export const priceUpdateReq = z.object({
  /** `false` archives the price for new purchases (PW-803 price rotation). */
  active: z.boolean().optional(),
  /** Stable retrieval key (≤200 chars). */
  lookup_key: z.string().max(200).optional(),
  /** Atomically move `lookup_key` off the price currently holding it. */
  transfer_lookup_key: z.boolean().optional(),
  metadata: metadataSchema.optional(),
  /** Internal description, hidden from customers. */
  nickname: z.string().optional(),
  /** Cannot be changed after being set to `inclusive`/`exclusive`. */
  tax_behavior: z.enum(["inclusive", "exclusive", "unspecified"]).optional(),
});
export type PriceUpdateReq = z.input<typeof priceUpdateReq>;

/**
 * GET /v1/prices — query params
 * (https://docs.stripe.com/api/prices/list — verified 2026-07-12).
 * `created`/`recurring` reach the URL as bracket keys (`recurring[interval]`);
 * `lookup_keys` as explicit indices (`lookup_keys[0]=...`).
 */
export const priceListQuery = z.object({
  ...listCursorFields,
  /** Only active (or only archived) prices. */
  active: z.boolean().optional(),
  /** Creation-date window (Unix timestamps). */
  created: createdRange.optional(),
  /** Filter by currency code. */
  currency: z.string().optional(),
  /** Only prices with these lookup_keys (up to 10). */
  lookup_keys: z.array(z.string()).optional(),
  /** Filter by Product id. */
  product: z.string().optional(),
  /** Filter by recurring components. */
  recurring: z
    .object({
      interval: z.enum(["day", "week", "month", "year"]).optional(),
      /** Filter by the price's Billing Meter id. */
      meter: z.string().optional(),
      usage_type: z.enum(["licensed", "metered"]).optional(),
    })
    .optional(),
  type: z.enum(["one_time", "recurring"]).optional(),
});
export type PriceListQuery = z.input<typeof priceListQuery>;

/**
 * GET /v1/prices/search — request
 * (https://docs.stripe.com/api/prices/search — verified 2026-07-12).
 */
export const priceSearchReq = z.object({ ...searchReqFields });
export type PriceSearchReq = z.input<typeof priceSearchReq>;

/**
 * A Price as returned by every endpoint
 * (https://docs.stripe.com/api/prices/object). LOOSE: only stable documented
 * fields are named; everything else passes through. `unit_amount` is integer
 * minor units (null for tiered/custom-amount prices).
 */
export const price = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  active: z.boolean().optional(),
  /** `per_unit` | `tiered`. */
  billing_scheme: z.string().optional(),
  created: z.number().optional(),
  currency: z.string().optional(),
  custom_unit_amount: z.looseObject({}).nullable().optional(),
  livemode: z.boolean().optional(),
  lookup_key: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  nickname: z.string().nullable().optional(),
  /** Product id string, or an expanded object — kept unknown. */
  product: z.unknown().optional(),
  recurring: z
    .looseObject({
      interval: z.string().optional(),
      interval_count: z.number().nullable().optional(),
      trial_period_days: z.number().nullable().optional(),
      usage_type: z.string().optional(),
      meter: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  tax_behavior: z.string().nullable().optional(),
  /** `graduated` | `volume` — null unless tiered. */
  tiers_mode: z.string().nullable().optional(),
  transform_quantity: z.looseObject({}).nullable().optional(),
  /** `one_time` | `recurring`. */
  type: z.string().optional(),
  /** Integer minor units — null for tiered/custom-amount prices. */
  unit_amount: z.number().nullable().optional(),
  unit_amount_decimal: z.string().nullable().optional(),
});
