/**
 * Stripe PaymentIntents resource (Surface A, `payweave.stripe.paymentIntents`).
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call — and therefore
 * before the form encoder runs) and passes a loose response schema to the
 * HttpClient (drift is logged, never thrown). Requests go to the wire as
 * `application/x-www-form-urlencoded` bracket notation; responses are bare
 * JSON resources — no envelope (providers.md §3.1). All amounts are integer
 * minor units.
 *
 * Docs: https://docs.stripe.com/api/payment_intents
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
  paymentIntent,
  paymentIntentCancelReq,
  paymentIntentCaptureReq,
  paymentIntentConfirmReq,
  paymentIntentCreateReq,
  paymentIntentListQuery,
  type PaymentIntentCancelReq,
  type PaymentIntentCaptureReq,
  type PaymentIntentConfirmReq,
  type PaymentIntentCreateReq,
  type PaymentIntentListQuery,
} from "../schemas/payment-intents";

const paymentIntentListRes = stripeList(paymentIntent);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class PaymentIntents {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a PaymentIntent. `amount` is a positive integer in MINOR units
   * (e.g. 2000 = $20.00) and is sent to Stripe unchanged. Pass
   * `idempotencyKey` to make the POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/payment_intents/create
   *
   * @example
   * const pi = await payweave.stripe.paymentIntents.create({
   *   amount: 2000,
   *   currency: "usd",
   *   automatic_payment_methods: { enabled: true },
   * }, { idempotencyKey: "order-8123-intent" });
   * console.log(pi.client_secret);
   */
  async create(input: PaymentIntentCreateReq, opts: StripeRequestOptions = {}) {
    const body = parseRequest(paymentIntentCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/payment_intents",
      body,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: paymentIntent,
    });
  }

  /**
   * Retrieve a PaymentIntent by id (`pi_*`). A 404 for an unknown id surfaces
   * as {@link PayweaveNotFoundError}.
   *
   * Docs: https://docs.stripe.com/api/payment_intents/retrieve
   *
   * @example
   * const pi = await payweave.stripe.paymentIntents.retrieve("pi_123");
   * if (pi.status === "succeeded") { }
   */
  async retrieve(id: string) {
    const intentId = requireId(id, "payment intent");
    return this.http.request({
      method: "GET",
      path: `/v1/payment_intents/${encodeURIComponent(intentId)}`,
      schema: paymentIntent,
    });
  }

  /**
   * Confirm a PaymentIntent (attempt payment with the attached/provided
   * payment method). On success the status moves to `succeeded` — or
   * `requires_capture` when `capture_method` is `manual`, or
   * `requires_action` when authentication is needed. Pass `idempotencyKey`
   * to make the POST safely replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/payment_intents/confirm
   *
   * @example
   * const pi = await payweave.stripe.paymentIntents.confirm("pi_123", {
   *   payment_method: "pm_card_visa",
   *   return_url: "https://example.com/return",
   * }, { idempotencyKey: "order-8123-confirm" });
   */
  async confirm(
    id: string,
    input: PaymentIntentConfirmReq = {},
    opts: StripeRequestOptions = {},
  ) {
    const intentId = requireId(id, "payment intent");
    const body = parseRequest(paymentIntentConfirmReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/payment_intents/${encodeURIComponent(intentId)}/confirm`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: paymentIntent,
    });
  }

  /**
   * Capture the funds of a `requires_capture` PaymentIntent (manual capture
   * flow — uncaptured intents cancel after 7 days by default).
   * `amount_to_capture` is integer minor units and defaults to the full
   * `amount_capturable`. Pass `idempotencyKey` to make the POST safely
   * replayable (and retry-eligible).
   *
   * Docs: https://docs.stripe.com/api/payment_intents/capture
   *
   * @example
   * const pi = await payweave.stripe.paymentIntents.capture("pi_123", {
   *   amount_to_capture: 1500,
   * }, { idempotencyKey: "order-8123-capture" });
   * console.log(pi.status); // "succeeded"
   */
  async capture(
    id: string,
    input: PaymentIntentCaptureReq = {},
    opts: StripeRequestOptions = {},
  ) {
    const intentId = requireId(id, "payment intent");
    const body = parseRequest(paymentIntentCaptureReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/payment_intents/${encodeURIComponent(intentId)}/capture`,
      ...bodyIfNonEmpty(body),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      schema: paymentIntent,
    });
  }

  /**
   * Cancel a PaymentIntent. Valid only for statuses
   * `requires_payment_method`, `requires_capture`, `requires_confirmation`,
   * `requires_action` and (rarely) `processing` — Stripe errors otherwise
   * (surfaced as {@link PayweaveValidationError} on the 400). For
   * `requires_capture` intents the remaining `amount_capturable` is
   * automatically refunded.
   *
   * Docs: https://docs.stripe.com/api/payment_intents/cancel
   *
   * @example
   * const pi = await payweave.stripe.paymentIntents.cancel("pi_123", {
   *   cancellation_reason: "requested_by_customer",
   * });
   * console.log(pi.status); // "canceled"
   */
  async cancel(id: string, input: PaymentIntentCancelReq = {}) {
    const intentId = requireId(id, "payment intent");
    const body = parseRequest(paymentIntentCancelReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`,
      ...bodyIfNonEmpty(body),
      schema: paymentIntent,
    });
  }

  /**
   * List PaymentIntents (newest first). Cursor pagination: `limit` +
   * `starting_after`/`ending_before`; the `created` window becomes bracket
   * query keys (`created[gte]`).
   *
   * Docs: https://docs.stripe.com/api/payment_intents/list
   *
   * @example
   * const page = await payweave.stripe.paymentIntents.list({ customer: "cus_123", limit: 50 });
   * console.log(page.data.length, page.has_more);
   */
  async list(query: PaymentIntentListQuery = {}) {
    const q = parseRequest(paymentIntentListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/payment_intents",
      query: flattenQuery(q),
      schema: paymentIntentListRes,
    });
  }

  /**
   * Async iterator over ALL PaymentIntents matching `query`, transparently
   * following `has_more` with `starting_after = <last id>` (providers.md §3.1).
   *
   * Docs: https://docs.stripe.com/api/payment_intents/list
   *
   * @example
   * for await (const pi of payweave.stripe.paymentIntents.iterate({ customer: "cus_123" })) {
   *   console.log(pi.id, pi.status);
   * }
   */
  async *iterate(query: PaymentIntentListQuery = {}) {
    const base = parseRequest(paymentIntentListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/payment_intents",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: paymentIntentListRes,
      }),
    );
  }
}
