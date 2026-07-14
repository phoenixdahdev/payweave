/**
 * Stripe Prices resource (Surface A, `payweave.stripe.prices`).
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope. All `unit_amount`s are
 * integer minor units.
 *
 * `payweave push` syncs Payweave plan pricing onto prices. Prices are largely IMMUTABLE — amount,
 * currency, product and recurring cannot change after creation, and there is
 * NO delete endpoint: a price change means creating a NEW Price and archiving
 * the old one (`update(id, { active: false })`), optionally moving the
 * `lookup_key` across with `transfer_lookup_key: true`.
 *
 * Docs: https://docs.stripe.com/api/prices
 */
import type { HttpClient } from "../../core/http";
import type { QueryValue } from "../../core/http";
import {
  flattenQuery,
  iterateStripeList,
  parseRequest,
  requireId,
  stripeList,
  type StripeRequestOptions,
  iterateStripeSearch,
  stripeSearchResult,
} from "../types";
import {
  price,
  priceCreateReq,
  priceListQuery,
  priceSearchReq,
  priceUpdateReq,
  type PriceCreateReq,
  type PriceListQuery,
  type PriceSearchReq,
  type PriceUpdateReq,
} from "../schemas/prices";

const priceListRes = stripeList(price);
const priceSearchRes = stripeSearchResult(price);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class Prices {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a Price. `unit_amount` is integer MINOR units (e.g. 1500 = $15.00)
   * and is sent to Stripe unchanged; `recurring` makes it a subscription
   * price; `lookup_key` (+ `transfer_lookup_key`) gives it a stable
   * identifier that survives price rotation. Amount, currency, product and
   * recurring are IMMUTABLE afterwards. Pass `idempotencyKey` to make the
   * POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/prices/create
   *
   * @example
   * const pr = await payweave.stripe.prices.create({
   *   currency: "usd",
   *   unit_amount: 1500,
   *   product: "prod_123",
   *   recurring: { interval: "month" },
   *   lookup_key: "pro-monthly",
   * }, { idempotencyKey: "push-pro-monthly-v2" });
   * console.log(pr.id);
   */
  async create(input: PriceCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(priceCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/prices",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: price,
    });
  }

  /**
   * Retrieve a Price by id (`price_*`). A 404 for an unknown id surfaces as
   * {@link PayweaveNotFoundError}.
   *
   * Docs: https://docs.stripe.com/api/prices/retrieve
   *
   * @example
   * const pr = await payweave.stripe.prices.retrieve("price_123");
   * console.log(pr.unit_amount, pr.currency);
   */
  async retrieve(id: string) {
    const priceId = requireId(id, "price");
    return this.http.request({
      method: "GET",
      path: `/v1/prices/${encodeURIComponent(priceId)}`,
      schema: price,
    });
  }

  /**
   * Update a Price. ONLY `active`, `lookup_key`/`transfer_lookup_key`,
   * `metadata`, `nickname` and `tax_behavior` (until set) are updatable —
   * amount/currency/product/recurring are immutable, and prices cannot be
   * deleted: rotate by creating a new Price and archiving this one with
   * `active: false`. Pass `idempotencyKey` to
   * make the POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/prices/update
   *
   * @example
   * const archived = await payweave.stripe.prices.update("price_123", {
   *   active: false,
   * });
   * console.log(archived.active); // false
   */
  async update(id: string, input: PriceUpdateReq = {}, opts: StripeRequestOptions = {}) {
    const priceId = requireId(id, "price");
    const body = parseRequest(priceUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/prices/${encodeURIComponent(priceId)}`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: price,
    });
  }

  /**
   * List Prices (newest first). Cursor pagination: `limit` +
   * `starting_after`/`ending_before`; `created`/`recurring` become bracket
   * query keys (`recurring[interval]`) and `lookup_keys` explicit indices
   * (`lookup_keys[0]=...`).
   *
   * Docs: https://docs.stripe.com/api/prices/list
   *
   * @example
   * const page = await payweave.stripe.prices.list({ product: "prod_123", active: true });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: PriceListQuery = {}) {
    const { lookup_keys, ...rest } = parseRequest(priceListQuery, query);
    const q: Record<string, QueryValue> = flattenQuery(rest);
    lookup_keys?.forEach((key, i) => {
      q[`lookup_keys[${i}]`] = key;
    });
    return this.http.request({
      method: "GET",
      path: "/v1/prices",
      query: q,
      schema: priceListRes,
    });
  }

  /**
   * Async iterator over ALL Prices matching `query`, transparently following
   * `has_more` with `starting_after = <last id>`.
   *
   * Docs: https://docs.stripe.com/api/prices/list
   *
   * @example
   * for await (const pr of payweave.stripe.prices.iterate({ product: "prod_123" })) {
   *   console.log(pr.id, pr.unit_amount);
   * }
   */
  async *iterate(query: PriceListQuery = {}) {
    const { lookup_keys, ...base } = parseRequest(priceListQuery, query);
    const lookupPairs: Record<string, QueryValue> = {};
    lookup_keys?.forEach((key, i) => {
      lookupPairs[`lookup_keys[${i}]`] = key;
    });
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/prices",
        query: {
          ...flattenQuery({ ...base, starting_after: startingAfter }),
          ...lookupPairs,
        },
        schema: priceListRes,
      }),
    );
  }

  /**
   * Search Prices with Stripe's search query language (e.g.
   * `active:'true' AND lookup_key:'pro-monthly'`). Pagination is TOKEN-based:
   * pass the previous page's `next_page` as `page` (never `starting_after`).
   * Search is eventually consistent — don't use it in read-after-write flows.
   *
   * Docs: https://docs.stripe.com/api/prices/search
   *
   * @example
   * const found = await payweave.stripe.prices.search({
   *   query: "metadata['pwv_reference']:'pwv_plan_pro'",
   * });
   * console.log(found.data[0]?.id, found.next_page);
   */
  async search(input: PriceSearchReq) {
    const q = parseRequest(priceSearchReq, input);
    return this.http.request({
      method: "GET",
      path: "/v1/prices/search",
      query: flattenQuery(q),
      schema: priceSearchRes,
    });
  }

  /**
   * Async iterator over ALL Prices matching a search query, transparently
   * following `has_more` with `page = <next_page token>` — search pagination
   * differs from list pagination (https://docs.stripe.com/api/pagination/search).
   *
   * Docs: https://docs.stripe.com/api/prices/search
   *
   * @example
   * for await (const pr of payweave.stripe.prices.iterateSearch({
   *   query: "type:'recurring'",
   * })) {
   *   console.log(pr.id);
   * }
   */
  async *iterateSearch(input: PriceSearchReq) {
    const base = parseRequest(priceSearchReq, input);
    yield* iterateStripeSearch((page) =>
      this.http.request({
        method: "GET",
        path: "/v1/prices/search",
        query: flattenQuery({ ...base, page }),
        schema: priceSearchRes,
      }),
    );
  }
}
