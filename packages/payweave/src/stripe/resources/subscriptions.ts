/**
 * Stripe Subscriptions resource (Surface A, `payweave.stripe.subscriptions`).
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope. All amounts are integer
 * minor units.
 *
 * Cancellation is exposed as Stripe documents it, never merged:
 * - `cancel(id)` — IMMEDIATE: `DELETE /v1/subscriptions/{id}`.
 * - `update(id, { cancel_at_period_end: true })` — END-OF-PERIOD: the
 *   subscription stays `active` until the period closes.
 * - `resume(id)` — only for STATUS `paused` subscriptions; unpausing payment
 *   COLLECTION is `update(id, { pause_collection: "" })` instead.
 *
 * Docs: https://docs.stripe.com/api/subscriptions
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
  subscription,
  subscriptionCancelReq,
  subscriptionCreateReq,
  subscriptionListQuery,
  subscriptionResumeReq,
  subscriptionUpdateReq,
  type SubscriptionCancelReq,
  type SubscriptionCreateReq,
  type SubscriptionListQuery,
  type SubscriptionResumeReq,
  type SubscriptionUpdateReq,
} from "../schemas/subscriptions";

const subscriptionListRes = stripeList(subscription);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class Subscriptions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a subscription for an existing customer — the first invoice is
   * attempted immediately unless a trial or `billing_cycle_anchor` defers it.
   * `items` (up to 20, each with a `price` or inline `price_data`) is
   * required. Pass `idempotencyKey` to make the POST safely replayable (and
   * retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/subscriptions/create
   *
   * @example
   * const sub = await payweave.stripe.subscriptions.create({
   *   customer: "cus_123",
   *   items: [{ price: "price_123", quantity: 1 }],
   *   metadata: { pwv_plan: "pro" },
   * }, { idempotencyKey: "sub-cus_123-pro" });
   * console.log(sub.status, sub.items?.data[0]?.current_period_end);
   */
  async create(input: SubscriptionCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(subscriptionCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/subscriptions",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: subscription,
    });
  }

  /**
   * Retrieve a subscription by id (`sub_*`). A 404 for an unknown id surfaces
   * as {@link PayweaveNotFoundError}. Period boundaries live on the embedded
   * items (`sub.items.data[].current_period_start/end`) on the SDK's pinned
   * API version.
   *
   * Docs: https://docs.stripe.com/api/subscriptions/retrieve
   *
   * @example
   * const sub = await payweave.stripe.subscriptions.retrieve("sub_123");
   * if (sub.status === "active") { }
   */
  async retrieve(id: string) {
    const subscriptionId = requireId(id, "subscription");
    return this.http.request({
      method: "GET",
      path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      schema: subscription,
    });
  }

  /**
   * Update a subscription: change items/quantities (proration per
   * `proration_behavior`), schedule an END-OF-PERIOD cancellation with
   * `cancel_at_period_end: true` (or clear one with `false`), pause payment
   * collection with `pause_collection` (unset with `""` to resume
   * collection), etc. For IMMEDIATE cancellation use {@link cancel} instead.
   * Pass `idempotencyKey` to make the POST safely replayable (and
   * retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/subscriptions/update
   *
   * @example
   * // Cancel when the current billing period ends — NOT immediate:
   * const sub = await payweave.stripe.subscriptions.update("sub_123", {
   *   cancel_at_period_end: true,
   * });
   * console.log(sub.status, sub.cancel_at_period_end); // "active", true
   */
  async update(
    id: string,
    input: SubscriptionUpdateReq = {},
    opts: StripeRequestOptions = {},
  ) {
    const subscriptionId = requireId(id, "subscription");
    const body = parseRequest(subscriptionUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: subscription,
    });
  }

  /**
   * Cancel a subscription IMMEDIATELY (`DELETE /v1/subscriptions/{id}`) —
   * the customer is not charged again, and pending prorations are dropped
   * unless `invoice_now`/`prorate` say otherwise. To cancel at the END of the
   * current period instead, use
   * `update(id, { cancel_at_period_end: true })` — the two shapes are
   * distinct on Stripe and the local billing state machine relies on that.
   *
   * Docs: https://docs.stripe.com/api/subscriptions/cancel
   *
   * @example
   * const sub = await payweave.stripe.subscriptions.cancel("sub_123", {
   *   invoice_now: true,
   *   prorate: true,
   *   cancellation_details: { feedback: "too_expensive" },
   * });
   * console.log(sub.status); // "canceled"
   */
  async cancel(id: string, input: SubscriptionCancelReq = {}) {
    const subscriptionId = requireId(id, "subscription");
    const body = parseRequest(subscriptionCancelReq, input);
    return this.http.request({
      method: "DELETE",
      path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      ...bodyIfNonEmpty(body),
      schema: subscription,
    });
  }

  /**
   * Resume a subscription whose STATUS is `paused` (e.g. a trial that ended
   * with `trial_settings.end_behavior.missing_payment_method: "pause"`) —
   * only available under `charge_automatically` collection. Not for paused
   * payment COLLECTION: unset that via
   * `update(id, { pause_collection: "" })`. `billing_cycle_anchor` defaults
   * to `now` (resets the cycle; no prorations); `unchanged` keeps the anchor
   * and prorates per `proration_behavior`. Pass `idempotencyKey` to make the
   * POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/subscriptions/resume
   *
   * @example
   * const sub = await payweave.stripe.subscriptions.resume("sub_123", {
   *   billing_cycle_anchor: "now",
   * });
   * console.log(sub.status); // "active"
   */
  async resume(
    id: string,
    input: SubscriptionResumeReq = {},
    opts: StripeRequestOptions = {},
  ) {
    const subscriptionId = requireId(id, "subscription");
    const body = parseRequest(subscriptionResumeReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/resume`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: subscription,
    });
  }

  /**
   * List subscriptions. By default only non-canceled subscriptions are
   * returned — pass `status: "canceled"`, `"ended"`, or `"all"` to widen.
   * Filters are query params; range filters become bracket keys
   * (`current_period_end[gte]`).
   *
   * Docs: https://docs.stripe.com/api/subscriptions/list
   *
   * @example
   * const page = await payweave.stripe.subscriptions.list({
   *   customer: "cus_123",
   *   status: "all",
   *   limit: 50,
   * });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: SubscriptionListQuery = {}) {
    const q = parseRequest(subscriptionListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/subscriptions",
      query: flattenQuery(q),
      schema: subscriptionListRes,
    });
  }

  /**
   * Async iterator over ALL subscriptions matching `query`, transparently
   * following `has_more` with `starting_after = <last id>`.
   *
   * Docs: https://docs.stripe.com/api/subscriptions/list
   *
   * @example
   * for await (const sub of payweave.stripe.subscriptions.iterate({ customer: "cus_123" })) {
   *   console.log(sub.id, sub.status);
   * }
   */
  async *iterate(query: SubscriptionListQuery = {}) {
    const base = parseRequest(subscriptionListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/subscriptions",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: subscriptionListRes,
      }),
    );
  }
}
