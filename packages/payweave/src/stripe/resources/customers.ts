/**
 * Stripe Customers resource (Surface A, `payweave.stripe.customers`).
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope (providers.md §3.1).
 *
 * PW-803 upserts customers here during `subscribe()` — `metadata` (with the
 * `pwv_` reference) and `email` are the fields its create-or-adopt loop keys
 * on.
 *
 * Docs: https://docs.stripe.com/api/customers
 */
import type { HttpClient } from "../../core/http";
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
  customer,
  customerCreateReq,
  customerListQuery,
  customerSearchReq,
  customerUpdateReq,
  deletedCustomer,
  type CustomerCreateReq,
  type CustomerListQuery,
  type CustomerSearchReq,
  type CustomerUpdateReq,
} from "../schemas/customers";

const customerListRes = stripeList(customer);
const customerSearchRes = stripeSearchResult(customer);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class Customers {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a Customer. Every field is optional — Stripe allows an empty
   * customer. `metadata` maps go to the wire as bracket pairs
   * (`metadata[pwv_reference]=...`). Pass `idempotencyKey` to make the POST
   * safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/customers/create
   *
   * @example
   * const cus = await payweave.stripe.customers.create({
   *   email: "jenny.rosen@example.com",
   *   name: "Jenny Rosen",
   *   metadata: { pwv_reference: "pwv_ref_0001" },
   * }, { idempotencyKey: "signup-8123-customer" });
   * console.log(cus.id);
   */
  async create(input: CustomerCreateReq = {}, opts: StripeRequestOptions = {}) {
    const body = parseRequest(customerCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/customers",
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: customer,
    });
  }

  /**
   * Retrieve a Customer by id (`cus_*`). A 404 for an unknown id surfaces as
   * {@link PayweaveNotFoundError}. DELETED customers stay retrievable (to
   * track history) and come back as a reduced stub with `deleted: true` —
   * check that flag before using other fields.
   *
   * Docs: https://docs.stripe.com/api/customers/retrieve
   *
   * @example
   * const cus = await payweave.stripe.customers.retrieve("cus_123");
   * if (!cus.deleted) console.log(cus.email);
   */
  async retrieve(id: string) {
    const customerId = requireId(id, "customer");
    return this.http.request({
      method: "GET",
      path: `/v1/customers/${encodeURIComponent(customerId)}`,
      schema: customer,
    });
  }

  /**
   * Update a Customer. Fields not provided remain unchanged; unset an
   * individual `metadata` key by posting an empty string value for it. Pass
   * `idempotencyKey` to make the POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/customers/update
   *
   * @example
   * const cus = await payweave.stripe.customers.update("cus_123", {
   *   metadata: { pwv_reference: "pwv_ref_0001", legacy_id: "" }, // "" unsets
   * });
   */
  async update(id: string, input: CustomerUpdateReq = {}, opts: StripeRequestOptions = {}) {
    const customerId = requireId(id, "customer");
    const body = parseRequest(customerUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(customerId)}`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: customer,
    });
  }

  /**
   * PERMANENTLY delete a Customer — cannot be undone. Immediately cancels
   * any active subscriptions, removes all stored payment details, and blocks
   * further operations on the customer. Returns the deletion stub
   * `{ id, object: "customer", deleted: true }`; the customer remains
   * retrievable afterwards (as a deleted stub) for history.
   *
   * Docs: https://docs.stripe.com/api/customers/delete
   *
   * @example
   * const gone = await payweave.stripe.customers.delete("cus_123");
   * console.log(gone.deleted); // true
   */
  async delete(id: string) {
    const customerId = requireId(id, "customer");
    return this.http.request({
      method: "DELETE",
      path: `/v1/customers/${encodeURIComponent(customerId)}`,
      schema: deletedCustomer,
    });
  }

  /**
   * List Customers (newest first). Cursor pagination: `limit` +
   * `starting_after`/`ending_before`; the `created` window becomes bracket
   * query keys (`created[gte]`).
   *
   * Docs: https://docs.stripe.com/api/customers/list
   *
   * @example
   * const page = await payweave.stripe.customers.list({ email: "jenny.rosen@example.com" });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: CustomerListQuery = {}) {
    const q = parseRequest(customerListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/customers",
      query: flattenQuery(q),
      schema: customerListRes,
    });
  }

  /**
   * Async iterator over ALL Customers matching `query`, transparently
   * following `has_more` with `starting_after = <last id>` (providers.md §3.1).
   *
   * Docs: https://docs.stripe.com/api/customers/list
   *
   * @example
   * for await (const cus of payweave.stripe.customers.iterate({ email: "a@example.com" })) {
   *   console.log(cus.id);
   * }
   */
  async *iterate(query: CustomerListQuery = {}) {
    const base = parseRequest(customerListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/customers",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: customerListRes,
      }),
    );
  }

  /**
   * Search Customers with Stripe's search query language (e.g.
   * `name:'Jane Doe' AND metadata['foo']:'bar'`). Pagination is TOKEN-based:
   * pass the previous page's `next_page` as `page` (never `starting_after`).
   * Search is eventually consistent (typically <1 minute; up to an hour
   * during outages) — don't use it in read-after-write flows.
   *
   * Docs: https://docs.stripe.com/api/customers/search
   *
   * @example
   * const found = await payweave.stripe.customers.search({
   *   query: "metadata['pwv_reference']:'pwv_ref_0001'",
   * });
   * console.log(found.data[0]?.id, found.next_page);
   */
  async search(input: CustomerSearchReq) {
    const q = parseRequest(customerSearchReq, input);
    return this.http.request({
      method: "GET",
      path: "/v1/customers/search",
      query: flattenQuery(q),
      schema: customerSearchRes,
    });
  }

  /**
   * Async iterator over ALL Customers matching a search query, transparently
   * following `has_more` with `page = <next_page token>` — search pagination
   * differs from list pagination (https://docs.stripe.com/api/pagination/search).
   *
   * Docs: https://docs.stripe.com/api/customers/search
   *
   * @example
   * for await (const cus of payweave.stripe.customers.iterateSearch({
   *   query: "email:'jenny.rosen@example.com'",
   * })) {
   *   console.log(cus.id);
   * }
   */
  async *iterateSearch(input: CustomerSearchReq) {
    const base = parseRequest(customerSearchReq, input);
    yield* iterateStripeSearch((page) =>
      this.http.request({
        method: "GET",
        path: "/v1/customers/search",
        query: flattenQuery({ ...base, page }),
        schema: customerSearchRes,
      }),
    );
  }
}
