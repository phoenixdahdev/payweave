/**
 * Stripe Refunds resource (Surface A, `payweave.stripe.refunds`). Every method
 * validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope. All amounts are integer
 * minor units.
 *
 * Refunds MOVE MONEY: `create` is a bare POST and is therefore never
 * auto-retried — pass `idempotencyKey` to make it safely
 * replayable and retry-eligible.
 *
 * Docs: https://docs.stripe.com/api/refunds
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
  refund,
  refundCreateReq,
  refundListQuery,
  refundUpdateReq,
  type RefundCreateReq,
  type RefundListQuery,
  type RefundUpdateReq,
} from "../schemas/refunds";

const refundListRes = stripeList(refund);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class Refunds {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a refund. Target either a `charge` or a `payment_intent` (the
   * unified layer refunds against the payment intent);
   * one of the two is required unless `origin: "customer_balance"`. `amount`
   * is integer MINOR units and defaults to the full remaining unrefunded
   * amount. Stripe errors if the target is already fully refunded (surfaced
   * as {@link PayweaveValidationError} with providerCode
   * `charge_already_refunded` on the 400).
   *
   * Money-moving POST: never auto-retried bare — pass `idempotencyKey` to
   * make it safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/refunds/create
   *
   * @example
   * const re = await payweave.stripe.refunds.create({
   *   payment_intent: "pi_123",
   *   amount: 500, // partial refund, minor units
   *   reason: "requested_by_customer",
   * }, { idempotencyKey: "order-8123-refund" });
   * console.log(re.status); // "succeeded" | "pending" | ...
   */
  async create(input: RefundCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(refundCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/refunds",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: refund,
    });
  }

  /**
   * Retrieve a refund by id (`re_*`). A 404 for an unknown id surfaces as
   * {@link PayweaveNotFoundError}.
   *
   * Docs: https://docs.stripe.com/api/refunds/retrieve
   *
   * @example
   * const re = await payweave.stripe.refunds.retrieve("re_123");
   * if (re.status === "succeeded") { }
   */
  async retrieve(id: string) {
    const refundId = requireId(id, "refund");
    return this.http.request({
      method: "GET",
      path: `/v1/refunds/${encodeURIComponent(refundId)}`,
      schema: refund,
    });
  }

  /**
   * Update a refund. `metadata` is the ONLY updatable field; unset individual
   * keys by posting an empty string value.
   *
   * Docs: https://docs.stripe.com/api/refunds/update
   *
   * @example
   * const re = await payweave.stripe.refunds.update("re_123", {
   *   metadata: { order_id: "6735" },
   * });
   */
  async update(id: string, input: RefundUpdateReq = {}) {
    const refundId = requireId(id, "refund");
    const body = parseRequest(refundUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/refunds/${encodeURIComponent(refundId)}`,
      ...bodyIfNonEmpty(body),
      schema: refund,
    });
  }

  /**
   * Cancel a refund. ONLY valid while the refund's status is
   * `requires_action` — "you can't cancel refunds in other states" (only
   * refunds for payment methods that require customer action ever enter that
   * state); Stripe raises an error otherwise (surfaced as
   * {@link PayweaveValidationError} on the 400). Takes no body parameters.
   *
   * Docs: https://docs.stripe.com/api/refunds/cancel
   *
   * @example
   * const re = await payweave.stripe.refunds.cancel("re_123");
   * console.log(re.status); // "canceled"
   */
  async cancel(id: string) {
    const refundId = requireId(id, "refund");
    return this.http.request({
      method: "POST",
      path: `/v1/refunds/${encodeURIComponent(refundId)}/cancel`,
      schema: refund,
    });
  }

  /**
   * List refunds (newest first). Filter by `charge` or `payment_intent`;
   * cursor pagination via `limit` + `starting_after`/`ending_before`; the
   * `created` window becomes bracket query keys (`created[gte]`).
   *
   * Docs: https://docs.stripe.com/api/refunds/list
   *
   * @example
   * const page = await payweave.stripe.refunds.list({ payment_intent: "pi_123", limit: 50 });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: RefundListQuery = {}) {
    const q = parseRequest(refundListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/refunds",
      query: flattenQuery(q),
      schema: refundListRes,
    });
  }

  /**
   * Async iterator over ALL refunds matching `query`, transparently following
   * `has_more` with `starting_after = <last id>`.
   *
   * Docs: https://docs.stripe.com/api/refunds/list
   *
   * @example
   * for await (const re of payweave.stripe.refunds.iterate({ charge: "ch_123" })) {
   *   console.log(re.id, re.status);
   * }
   */
  async *iterate(query: RefundListQuery = {}) {
    const base = parseRequest(refundListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/refunds",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: refundListRes,
      }),
    );
  }
}
