/**
 * Stripe Subscription Items resource (Surface A,
 * `payweave.stripe.subscriptionItems`). Every method validates its input with
 * a request schema (throws {@link PayweaveValidationError} before the network
 * call — and therefore before the form encoder runs) and passes a loose
 * response schema to the HttpClient (drift is logged, never thrown). Requests
 * go to the wire as `application/x-www-form-urlencoded` bracket notation;
 * responses are bare JSON resources — no envelope. All
 * amounts are integer minor units.
 *
 * On the SDK's pinned API version, each item carries the billing-period
 * boundaries (`current_period_start`/`current_period_end`) that EPIC 8's
 * billing loop consumes — they are NOT on the parent subscription object.
 *
 * Docs: https://docs.stripe.com/api/subscription_items
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
  subscriptionItem,
  subscriptionItemCreateReq,
  subscriptionItemDeleted,
  subscriptionItemDeleteReq,
  subscriptionItemListQuery,
  subscriptionItemUpdateReq,
  type SubscriptionItemCreateReq,
  type SubscriptionItemDeleteReq,
  type SubscriptionItemListQuery,
  type SubscriptionItemUpdateReq,
} from "../schemas/subscription-items";

const subscriptionItemListRes = stripeList(subscriptionItem);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class SubscriptionItems {
  constructor(private readonly http: HttpClient) {}

  /**
   * Add a new item (price) to an existing subscription. Prorations follow
   * `proration_behavior` (default `create_prorations`). Pass `idempotencyKey`
   * to make the POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/subscription_items/create
   *
   * @example
   * const item = await payweave.stripe.subscriptionItems.create({
   *   subscription: "sub_123",
   *   price: "price_123",
   *   quantity: 2,
   * }, { idempotencyKey: "sub_123-addon-seat" });
   * console.log(item.id, item.current_period_end);
   */
  async create(input: SubscriptionItemCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(subscriptionItemCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/subscription_items",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: subscriptionItem,
    });
  }

  /**
   * Retrieve a subscription item by id (`si_*`). A 404 for an unknown id
   * surfaces as {@link PayweaveNotFoundError}.
   *
   * Docs: https://docs.stripe.com/api/subscription_items/retrieve
   *
   * @example
   * const item = await payweave.stripe.subscriptionItems.retrieve("si_123");
   * console.log(item.price?.id, item.quantity);
   */
  async retrieve(id: string) {
    const itemId = requireId(id, "subscription item");
    return this.http.request({
      method: "GET",
      path: `/v1/subscription_items/${encodeURIComponent(itemId)}`,
      schema: subscriptionItem,
    });
  }

  /**
   * Update a subscription item — switch its `price`, change `quantity`, etc.
   * Proration parameters (`proration_behavior`, `proration_date`) are passed
   * through exactly as documented. Pass `idempotencyKey` to make the POST
   * safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/subscription_items/update
   *
   * @example
   * const item = await payweave.stripe.subscriptionItems.update("si_123", {
   *   quantity: 5,
   *   proration_behavior: "create_prorations",
   * });
   */
  async update(
    id: string,
    input: SubscriptionItemUpdateReq = {},
    opts: StripeRequestOptions = {},
  ) {
    const itemId = requireId(id, "subscription item");
    const body = parseRequest(subscriptionItemUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/subscription_items/${encodeURIComponent(itemId)}`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: subscriptionItem,
    });
  }

  /**
   * Delete an item from its subscription — removing a price the customer was
   * subscribed to. Optional form params ride the DELETE (`clear_usage` only
   * for metered prices; prorations per `proration_behavior`). Returns the
   * `{ id, object, deleted: true }` acknowledgement. A subscription cannot
   * lose its last item this way — Stripe rejects that with a 400
   * (surfaced as {@link PayweaveValidationError}); cancel the subscription
   * instead.
   *
   * Docs: https://docs.stripe.com/api/subscription_items/delete
   *
   * @example
   * const gone = await payweave.stripe.subscriptionItems.delete("si_123", {
   *   proration_behavior: "none",
   * });
   * console.log(gone.deleted); // true
   */
  async delete(id: string, input: SubscriptionItemDeleteReq = {}) {
    const itemId = requireId(id, "subscription item");
    const body = parseRequest(subscriptionItemDeleteReq, input);
    return this.http.request({
      method: "DELETE",
      path: `/v1/subscription_items/${encodeURIComponent(itemId)}`,
      ...bodyIfNonEmpty(body),
      schema: subscriptionItemDeleted,
    });
  }

  /**
   * List the items of ONE subscription — `subscription` is required by the
   * API. Cursor pagination: `limit` + `starting_after`/`ending_before`.
   *
   * Docs: https://docs.stripe.com/api/subscription_items/list
   *
   * @example
   * const page = await payweave.stripe.subscriptionItems.list({
   *   subscription: "sub_123",
   *   limit: 10,
   * });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: SubscriptionItemListQuery) {
    const q = parseRequest(subscriptionItemListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/subscription_items",
      query: flattenQuery(q),
      schema: subscriptionItemListRes,
    });
  }

  /**
   * Async iterator over ALL items of a subscription, transparently following
   * `has_more` with `starting_after = <last id>`.
   *
   * Docs: https://docs.stripe.com/api/subscription_items/list
   *
   * @example
   * for await (const item of payweave.stripe.subscriptionItems.iterate({ subscription: "sub_123" })) {
   *   console.log(item.id, item.price?.id);
   * }
   */
  async *iterate(query: SubscriptionItemListQuery) {
    const base = parseRequest(subscriptionItemListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/subscription_items",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: subscriptionItemListRes,
      }),
    );
  }
}
