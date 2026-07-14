/**
 * Stripe Products resource (Surface A, `payweave.stripe.products`).
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope.
 *
 * PW-803 syncs Payweave plans onto products (`payweave push`,
 * plans-and-features.md §12): sync flows ARCHIVE a product
 * (`update(id, { active: false })`) instead of deleting it — DELETE only
 * succeeds for products with no prices attached. `name`, `metadata` and
 * `active` are the fields the push loop keys on.
 *
 * Docs: https://docs.stripe.com/api/products
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
  deletedProduct,
  product,
  productCreateReq,
  productListQuery,
  productSearchReq,
  productUpdateReq,
  type ProductCreateReq,
  type ProductListQuery,
  type ProductSearchReq,
  type ProductUpdateReq,
} from "../schemas/products";

const productListRes = stripeList(product);
const productSearchRes = stripeSearchResult(product);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class Products {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a Product. `default_price_data` creates the product's default
   * Price in the same call — its `unit_amount` is integer MINOR units, sent
   * to Stripe unchanged. Pass `idempotencyKey` to make the POST safely
   * replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/products/create
   *
   * @example
   * const prod = await payweave.stripe.products.create({
   *   name: "Pro Plan",
   *   metadata: { pwv_reference: "pwv_plan_pro" },
   *   default_price_data: {
   *     currency: "usd",
   *     unit_amount: 1500, // $15.00 in minor units
   *     recurring: { interval: "month" },
   *   },
   * }, { idempotencyKey: "push-pro-plan-v1" });
   * console.log(prod.id, prod.default_price);
   */
  async create(input: ProductCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(productCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/products",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: product,
    });
  }

  /**
   * Retrieve a Product by id (`prod_*`). A 404 for an unknown id surfaces as
   * {@link PayweaveNotFoundError}.
   *
   * Docs: https://docs.stripe.com/api/products/retrieve
   *
   * @example
   * const prod = await payweave.stripe.products.retrieve("prod_123");
   * console.log(prod.name, prod.active);
   */
  async retrieve(id: string) {
    const productId = requireId(id, "product");
    return this.http.request({
      method: "GET",
      path: `/v1/products/${encodeURIComponent(productId)}`,
      schema: product,
    });
  }

  /**
   * Update a Product. Fields not provided remain unchanged. `active: false`
   * ARCHIVES the product (no new purchases) — the sync-flow alternative to
   * deletion, since products with prices cannot be deleted (PW-803 relies on
   * this). Pass `idempotencyKey` to make the POST safely replayable (and
   * retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/products/update
   *
   * @example
   * const archived = await payweave.stripe.products.update("prod_123", { active: false });
   * console.log(archived.active); // false
   */
  async update(id: string, input: ProductUpdateReq = {}, opts: StripeRequestOptions = {}) {
    const productId = requireId(id, "product");
    const body = parseRequest(productUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/products/${encodeURIComponent(productId)}`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: product,
    });
  }

  /**
   * Delete a Product. Only succeeds when the product has NO prices attached
   * (and, for `type=good`, no SKUs) — otherwise Stripe rejects with a 400
   * (surfaced as {@link PayweaveValidationError}). Sync flows should archive
   * with `update(id, { active: false })` instead. Returns the deletion stub
   * `{ id, object: "product", deleted: true }`.
   *
   * Docs: https://docs.stripe.com/api/products/delete
   *
   * @example
   * const gone = await payweave.stripe.products.delete("prod_123");
   * console.log(gone.deleted); // true
   */
  async delete(id: string) {
    const productId = requireId(id, "product");
    return this.http.request({
      method: "DELETE",
      path: `/v1/products/${encodeURIComponent(productId)}`,
      schema: deletedProduct,
    });
  }

  /**
   * List Products (newest first). Cursor pagination: `limit` +
   * `starting_after`/`ending_before`; `created` becomes bracket query keys
   * and `ids` explicit indices (`ids[0]=...` — cannot combine `ids` with the
   * cursor params).
   *
   * Docs: https://docs.stripe.com/api/products/list
   *
   * @example
   * const page = await payweave.stripe.products.list({ active: true, limit: 50 });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: ProductListQuery = {}) {
    const { ids, ...rest } = parseRequest(productListQuery, query);
    const q: Record<string, QueryValue> = flattenQuery(rest);
    ids?.forEach((id, i) => {
      q[`ids[${i}]`] = id;
    });
    return this.http.request({
      method: "GET",
      path: "/v1/products",
      query: q,
      schema: productListRes,
    });
  }

  /**
   * Async iterator over ALL Products matching `query`, transparently
   * following `has_more` with `starting_after = <last id>` (providers.md
   * §3.1). `ids` is not supported here — Stripe forbids combining it with
   * cursors; use {@link Products.list}.
   *
   * Docs: https://docs.stripe.com/api/products/list
   *
   * @example
   * for await (const prod of payweave.stripe.products.iterate({ active: true })) {
   *   console.log(prod.id, prod.name);
   * }
   */
  async *iterate(query: Omit<ProductListQuery, "ids"> = {}) {
    const base = parseRequest(productListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/products",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: productListRes,
      }),
    );
  }

  /**
   * Search Products with Stripe's search query language (e.g.
   * `active:'true' AND metadata['order_id']:'6735'`). Pagination is
   * TOKEN-based: pass the previous page's `next_page` as `page` (never
   * `starting_after`). Search is eventually consistent — don't use it in
   * read-after-write flows.
   *
   * Docs: https://docs.stripe.com/api/products/search
   *
   * @example
   * const found = await payweave.stripe.products.search({
   *   query: "metadata['pwv_reference']:'pwv_plan_pro'",
   * });
   * console.log(found.data[0]?.id, found.has_more);
   */
  async search(input: ProductSearchReq) {
    const q = parseRequest(productSearchReq, input);
    return this.http.request({
      method: "GET",
      path: "/v1/products/search",
      query: flattenQuery(q),
      schema: productSearchRes,
    });
  }

  /**
   * Async iterator over ALL Products matching a search query, transparently
   * following `has_more` with `page = <next_page token>` — search pagination
   * differs from list pagination (https://docs.stripe.com/api/pagination/search).
   *
   * Docs: https://docs.stripe.com/api/products/search
   *
   * @example
   * for await (const prod of payweave.stripe.products.iterateSearch({
   *   query: "active:'true'",
   * })) {
   *   console.log(prod.id);
   * }
   */
  async *iterateSearch(input: ProductSearchReq) {
    const base = parseRequest(productSearchReq, input);
    yield* iterateStripeSearch((page) =>
      this.http.request({
        method: "GET",
        path: "/v1/products/search",
        query: flattenQuery({ ...base, page }),
        schema: productSearchRes,
      }),
    );
  }
}
