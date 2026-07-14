/**
 * Zod schemas for the Stripe WebhookEndpoints module. Request fields
 * are sourced verbatim from the official API reference (all verified
 * 2026-07-12):
 *   - Create:   https://docs.stripe.com/api/webhook_endpoints/create
 *   - Retrieve: https://docs.stripe.com/api/webhook_endpoints/retrieve
 *   - Update:   https://docs.stripe.com/api/webhook_endpoints/update
 *   - Delete:   https://docs.stripe.com/api/webhook_endpoints/delete
 *   - List:     https://docs.stripe.com/api/webhook_endpoints/list
 *   - Object:   https://docs.stripe.com/api/webhook_endpoints/object
 *
 * SECRET HANDLING: the endpoint's signing secret (`whsec_*`)
 * is "Only returned at creation" (object docs, verified 2026-07-12) — the
 * response schema names `secret` so `create` callers can capture it ONCE;
 * retrieve/update/list responses never carry it. Core `redact` masks any
 * `secret`-named key (`/secret/i`), so the value never survives into logs or
 * `PayweaveError.toJSON()`. Fixtures only ever contain clearly-fake
 * placeholders. Response schemas are LOOSE: unknown fields pass through,
 * drift is logged, never thrown.
 */
import { z } from "zod";
import { listCursorFields, metadataSchema } from "../types";

/**
 * `enabled_events` — the list of event types to enable (`["*"]` enables all
 * events except those that require explicit selection). Event names are an
 * open, version-dependent enum on Stripe's side — kept `string` here
 * (conservative, AGENTS.md §8). Non-empty: an endpoint must listen to
 * something, and the form encoder emits no pairs for an empty array.
 */
const enabledEvents = z.array(z.string()).min(1);

/**
 * POST /v1/webhook_endpoints — request
 * (https://docs.stripe.com/api/webhook_endpoints/create — verified 2026-07-12).
 */
export const webhookEndpointCreateReq = z.object({
  /** The URL of the webhook endpoint. Required. */
  url: z.string(),
  /**
   * The list of events to enable for this endpoint; `["*"]` enables all
   * events except those that require explicit selection. Required. Encodes as
   * `enabled_events[0]=...`.
   */
  enabled_events: enabledEvents,
  /**
   * Events sent to this endpoint are rendered with this Stripe version
   * instead of the account default.
   */
  api_version: z.string().optional(),
  /**
   * `true` = receive events from connected accounts; `false` (default) = from
   * your own account.
   */
  connect: z.boolean().optional(),
  /** Optional description of what the webhook is used for. */
  description: z.string().optional(),
  metadata: metadataSchema.optional(),
});
export type WebhookEndpointCreateReq = z.input<typeof webhookEndpointCreateReq>;

/**
 * POST /v1/webhook_endpoints/{id} — request
 * (https://docs.stripe.com/api/webhook_endpoints/update — verified 2026-07-12).
 */
export const webhookEndpointUpdateReq = z.object({
  /** Optional description of what the webhook is used for. */
  description: z.string().optional(),
  /** Disable the webhook endpoint if set to true. */
  disabled: z.boolean().optional(),
  /** Replacement list of enabled events (`["*"]` = all). */
  enabled_events: enabledEvents.optional(),
  metadata: metadataSchema.optional(),
  /** The URL of the webhook endpoint. */
  url: z.string().optional(),
});
export type WebhookEndpointUpdateReq = z.input<typeof webhookEndpointUpdateReq>;

/**
 * GET /v1/webhook_endpoints — query params
 * (https://docs.stripe.com/api/webhook_endpoints/list — verified 2026-07-12).
 * Cursor pagination only — no other documented filters.
 */
export const webhookEndpointListQuery = z.object({
  ...listCursorFields,
});
export type WebhookEndpointListQuery = z.input<typeof webhookEndpointListQuery>;

/**
 * A WebhookEndpoint as returned by create/retrieve/update/list
 * (https://docs.stripe.com/api/webhook_endpoints/object — verified
 * 2026-07-12). LOOSE: only stable documented fields are named; everything
 * else passes through.
 */
export const webhookEndpoint = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  /** API version events are rendered as for this endpoint. */
  api_version: z.string().nullable().optional(),
  /** ID of the associated Connect application. */
  application: z.string().nullable().optional(),
  created: z.number().optional(),
  description: z.string().nullable().optional(),
  /** `["*"]` indicates all events (except explicit-selection ones). */
  enabled_events: z.array(z.string()).optional(),
  livemode: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  /**
   * The endpoint's signing secret (`whsec_*`), used to verify webhook
   * signatures. ⚠️ "Only returned at creation"
   * (https://docs.stripe.com/api/webhook_endpoints/object — verified
   * 2026-07-12) — capture it from the `create` response or it is gone;
   * retrieve/update/list never include it. Store it as the provider config's
   * `webhookSecret`; core `redact` masks it from all logs.
   */
  secret: z.string().optional(),
  /** `enabled` | `disabled` — kept loose (drift logs, never throws). */
  status: z.string().optional(),
  url: z.string().optional(),
});

/**
 * DELETE /v1/webhook_endpoints/{id} — response
 * (https://docs.stripe.com/api/webhook_endpoints/delete — verified
 * 2026-07-12): "An object with the deleted webhook endpoint's ID"
 * (`{ id, object, deleted: true }`).
 */
export const webhookEndpointDeleted = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  deleted: z.boolean().optional(),
});
