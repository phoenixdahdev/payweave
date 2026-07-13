/**
 * Stripe Checkout Sessions resource (Surface A, `payweave.stripe.checkout.sessions`).
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope (providers.md §3.1). All amounts are integer
 * minor units.
 *
 * Docs: https://docs.stripe.com/api/checkout/sessions
 */
import type { HttpClient } from "../../core/http";
import {
  flattenQuery,
  iterateStripeList,
  parseRequest,
  requireId,
  stripeList,
  type StripeRequestOptions,
} from "../types";
import {
  checkoutSession,
  lineItemsQuery,
  sessionCreateReq,
  sessionLineItem,
  sessionListQuery,
  type LineItemsQuery,
  type SessionCreateReq,
  type SessionListQuery,
} from "../schemas/checkout-sessions";

const sessionListRes = stripeList(checkoutSession);
const lineItemListRes = stripeList(sessionLineItem);

export class CheckoutSessions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a Checkout Session. `session.url` is the hosted checkout page to
   * redirect the customer to. Amounts (`price_data.unit_amount`) are integer
   * minor units, sent to Stripe unchanged. Pass `idempotencyKey` to make the
   * POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/create
   *
   * @example
   * const session = await payweave.stripe.checkout.sessions.create({
   *   mode: "payment",
   *   line_items: [{ price: "price_123", quantity: 2 }],
   *   success_url: "https://example.com/success",
   *   cancel_url: "https://example.com/cancel",
   * }, { idempotencyKey: "order-8123-checkout" });
   * console.log(session.url);
   */
  async create(input: SessionCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(sessionCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/checkout/sessions",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: checkoutSession,
    });
  }

  /**
   * Retrieve a Checkout Session by id (`cs_*`). A 404 for an unknown id
   * surfaces as {@link PayweaveNotFoundError}. Note `session.url` is null once
   * the session is no longer open.
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/retrieve
   *
   * @example
   * const session = await payweave.stripe.checkout.sessions.retrieve("cs_test_123");
   * if (session.payment_status === "paid") { }
   */
  async retrieve(id: string) {
    const sessionId = requireId(id, "checkout session");
    return this.http.request({
      method: "GET",
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      schema: checkoutSession,
    });
  }

  /**
   * List Checkout Sessions (newest first). Cursor pagination: `limit` +
   * `starting_after`/`ending_before`; nested filters (`created`,
   * `customer_details`) become bracket query keys.
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/list
   *
   * @example
   * const page = await payweave.stripe.checkout.sessions.list({ status: "complete", limit: 50 });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: SessionListQuery = {}) {
    const q = parseRequest(sessionListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/checkout/sessions",
      query: flattenQuery(q),
      schema: sessionListRes,
    });
  }

  /**
   * Async iterator over ALL sessions matching `query`, transparently following
   * `has_more` with `starting_after = <last id>` (providers.md §3.1).
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/list
   *
   * @example
   * for await (const session of payweave.stripe.checkout.sessions.iterate({ status: "open" })) {
   *   console.log(session.id);
   * }
   */
  async *iterate(query: SessionListQuery = {}) {
    const base = parseRequest(sessionListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/checkout/sessions",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: sessionListRes,
      }),
    );
  }

  /**
   * Expire an OPEN Checkout Session so it can no longer be paid — Stripe
   * errors when the session is not `open` (surfaced as
   * {@link PayweaveValidationError} on the 400). Returns the session with
   * `status: "expired"`.
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/expire
   *
   * @example
   * const expired = await payweave.stripe.checkout.sessions.expire("cs_test_123");
   * console.log(expired.status); // "expired"
   */
  async expire(id: string) {
    const sessionId = requireId(id, "checkout session");
    return this.http.request({
      method: "POST",
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      schema: checkoutSession,
    });
  }

  /**
   * List a session's line items (cursor-paginated; `amount_*` are integer
   * minor units).
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/line_items
   *
   * @example
   * const items = await payweave.stripe.checkout.sessions.lineItems("cs_test_123", { limit: 20 });
   * console.log(items.data[0]?.amount_total);
   */
  async lineItems(id: string, query: LineItemsQuery = {}) {
    const sessionId = requireId(id, "checkout session");
    const q = parseRequest(lineItemsQuery, query);
    return this.http.request({
      method: "GET",
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`,
      query: flattenQuery(q),
      schema: lineItemListRes,
    });
  }

  /**
   * Async iterator over ALL line items of a session, following `has_more`
   * with `starting_after = <last id>` — line items are themselves a paginated
   * list (PW-602 work order).
   *
   * Docs: https://docs.stripe.com/api/checkout/sessions/line_items
   *
   * @example
   * for await (const item of payweave.stripe.checkout.sessions.iterateLineItems("cs_test_123")) {
   *   console.log(item.description, item.quantity);
   * }
   */
  async *iterateLineItems(id: string, query: LineItemsQuery = {}) {
    const sessionId = requireId(id, "checkout session");
    const base = parseRequest(lineItemsQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`,
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: lineItemListRes,
      }),
    );
  }
}
