/**
 * Stripe WebhookEndpoints resource (Surface A,
 * `payweave.stripe.webhookEndpoints`). Plain REST management of webhook
 * endpoints — signature VERIFICATION lives in `src/webhooks/stripe.ts`
 * and is deliberately kept apart. `payweave listen`
 * provisions endpoints through `create` and tears them down through `delete`.
 *
 * Every method validates its input with a request schema (throws
 * {@link PayweaveValidationError} before the network call) and passes a loose
 * response schema to the HttpClient (drift is logged, never thrown). Requests
 * go to the wire as `application/x-www-form-urlencoded` bracket notation;
 * responses are bare JSON resources — no envelope.
 *
 * ⚠️ SECRET: the `create` response is the ONLY one carrying the endpoint's
 * `whsec_*` signing secret ("Only returned at creation" —
 * https://docs.stripe.com/api/webhook_endpoints/object, verified 2026-07-12).
 * Capture it immediately; core `redact` keeps it out of logs.
 *
 * Docs: https://docs.stripe.com/api/webhook_endpoints
 */
import type { HttpClient } from "../../core/http";
import {
  flattenQuery,
  iterateStripeList,
  parseRequest,
  requireId,
  stripeList,
} from "../types";
import {
  webhookEndpoint,
  webhookEndpointCreateReq,
  webhookEndpointDeleted,
  webhookEndpointListQuery,
  webhookEndpointUpdateReq,
  type WebhookEndpointCreateReq,
  type WebhookEndpointListQuery,
  type WebhookEndpointUpdateReq,
} from "../schemas/webhook-endpoints";

const webhookEndpointListRes = stripeList(webhookEndpoint);

/** Spread-helper: include `body` only when the parsed input has any pairs. */
function bodyIfNonEmpty(body: Record<string, unknown>): { body?: unknown } {
  return Object.keys(body).length > 0 ? { body } : {};
}

export class WebhookEndpoints {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a webhook endpoint. `url` and `enabled_events` are required;
   * `enabled_events` bracket-encodes as `enabled_events[0]=...` and `["*"]`
   * enables all events (except those requiring explicit selection).
   *
   * ⚠️ The response is the ONLY place the endpoint's `whsec_*` signing
   * `secret` is ever returned ("Only returned at creation") — persist it
   * immediately (e.g. as the `stripe.webhookSecret` config) or it cannot be
   * recovered; retrieve/update/list responses never include it.
   *
   * Docs: https://docs.stripe.com/api/webhook_endpoints/create
   *
   * @example
   * const we = await payweave.stripe.webhookEndpoints.create({
   *   url: "https://example.com/payweave/webhooks",
   *   enabled_events: ["checkout.session.completed", "payment_intent.succeeded"],
   * });
   * const signingSecret = we.secret; // whsec_* — shown ONCE, store it now
   */
  async create(input: WebhookEndpointCreateReq) {
    const body = parseRequest(webhookEndpointCreateReq, input);
    return this.http.request({
      method: "POST",
      path: "/v1/webhook_endpoints",
      body,
      schema: webhookEndpoint,
    });
  }

  /**
   * Retrieve a webhook endpoint by id (`we_*`). The response does NOT include
   * the signing `secret` (create-only). A 404 for an unknown id surfaces as
   * {@link PayweaveNotFoundError}.
   *
   * Docs: https://docs.stripe.com/api/webhook_endpoints/retrieve
   *
   * @example
   * const we = await payweave.stripe.webhookEndpoints.retrieve("we_123");
   * console.log(we.status, we.enabled_events);
   */
  async retrieve(id: string) {
    const endpointId = requireId(id, "webhook endpoint");
    return this.http.request({
      method: "GET",
      path: `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
      schema: webhookEndpoint,
    });
  }

  /**
   * Update a webhook endpoint (`description`, `enabled_events`, `url`,
   * `metadata`, or `disabled: true` to disable it). The response does NOT
   * include the signing `secret` (create-only).
   *
   * Docs: https://docs.stripe.com/api/webhook_endpoints/update
   *
   * @example
   * const we = await payweave.stripe.webhookEndpoints.update("we_123", {
   *   disabled: true,
   * });
   * console.log(we.status); // "disabled"
   */
  async update(id: string, input: WebhookEndpointUpdateReq = {}) {
    const endpointId = requireId(id, "webhook endpoint");
    const body = parseRequest(webhookEndpointUpdateReq, input);
    return this.http.request({
      method: "POST",
      path: `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
      ...bodyIfNonEmpty(body),
      schema: webhookEndpoint,
    });
  }

  /**
   * Delete a webhook endpoint. Returns `{ id, object, deleted: true }`;
   * deleting an already-deleted endpoint raises a Stripe error (404 →
   * {@link PayweaveNotFoundError}). `payweave listen` calls this on
   * teardown.
   *
   * Docs: https://docs.stripe.com/api/webhook_endpoints/delete
   *
   * @example
   * const gone = await payweave.stripe.webhookEndpoints.delete("we_123");
   * console.log(gone.deleted); // true
   */
  async delete(id: string) {
    const endpointId = requireId(id, "webhook endpoint");
    return this.http.request({
      method: "DELETE",
      path: `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
      schema: webhookEndpointDeleted,
    });
  }

  /**
   * List webhook endpoints. Cursor pagination only (`limit` +
   * `starting_after`/`ending_before`) — no other documented filters.
   * Responses never include signing secrets.
   *
   * Docs: https://docs.stripe.com/api/webhook_endpoints/list
   *
   * @example
   * const page = await payweave.stripe.webhookEndpoints.list({ limit: 20 });
   * console.log(page.data.map((we) => we.url));
   */
  async list(query: WebhookEndpointListQuery = {}) {
    const q = parseRequest(webhookEndpointListQuery, query);
    return this.http.request({
      method: "GET",
      path: "/v1/webhook_endpoints",
      query: flattenQuery(q),
      schema: webhookEndpointListRes,
    });
  }

  /**
   * Async iterator over ALL webhook endpoints, transparently following
   * `has_more` with `starting_after = <last id>`.
   *
   * Docs: https://docs.stripe.com/api/webhook_endpoints/list
   *
   * @example
   * for await (const we of payweave.stripe.webhookEndpoints.iterate()) {
   *   console.log(we.id, we.url, we.status);
   * }
   */
  async *iterate(query: WebhookEndpointListQuery = {}) {
    const base = parseRequest(webhookEndpointListQuery, query);
    yield* iterateStripeList((startingAfter) =>
      this.http.request({
        method: "GET",
        path: "/v1/webhook_endpoints",
        query: flattenQuery({ ...base, starting_after: startingAfter }),
        schema: webhookEndpointListRes,
      }),
    );
  }
}
