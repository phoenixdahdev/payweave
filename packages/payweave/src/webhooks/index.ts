// webhooks/ — signature-verification primitives + the `constructEvent`
// normalizer the SDK facade delegates to. The four pure, timing-safe
// verify functions stay the security boundary; `constructEvent` reuses the
// facade's already-wired verify dispatch (never re-implements verification),
// then parses the RAW bytes and normalizes via `unified/mappings.ts`. The
// multi-provider header dispatcher for `createPayweave` lives in `dispatch.ts`.
// Public subpath: `payweave/webhooks`.
import { createHash } from "node:crypto";
import { PayweaveWebhookVerificationError } from "../core/errors";
import type { HeaderLookup, UnifiedEvent } from "../core/provider";
import type { Logger } from "../core/logger";
import {
  toUnifiedEventType,
  toUnifiedStatus,
  type MappingProvider,
  type MappingVersion,
} from "../unified/mappings";
import {
  applyWebhookEvent,
  type ApplyOptions,
  type ApplyResult,
  type BillingApplyContext,
} from "../products/apply";

/** A `database`-less billing context — `event.apply()` always exists (mirrors `subscribe`/`check`/`report`), but calling it without a database throws `PayweaveConfigError`. */
const NO_DATABASE_CONTEXT: BillingApplyContext = { database: undefined, products: undefined };

export { verifyPaystack } from "./paystack";
export { verifyFlutterwaveV3 } from "./flutterwave";
export { verifyFlutterwaveV4 } from "./flutterwave-v4";
export { verifyStripe } from "./stripe";

/**
 * Providers whose webhooks `constructEvent` can normalize. Stripe's
 * events are normalized through the SAME `STRIPE_EVENT_MAP`/
 * `STRIPE_EVENT_STATUS_SPLIT_MAP` tables (`unified/mappings.ts`) that
 * `toUnifiedEventType` already used for every other provider —
 * unmapped Stripe events still fall through to `unifiedType: "unknown"`,
 * exactly like an unmapped Paystack/Flutterwave event.
 */
export type WebhookProvider = MappingProvider | "stripe";

/**
 * A verified + normalized webhook event. Extends the core {@link UnifiedEvent}
 * with the provider-supplied webhook `id` (Flutterwave and Stripe send one;
 * Paystack does not — see {@link ConstructEventParams} for the dedupe-key
 * scheme).
 */
export interface WebhookEvent extends UnifiedEvent {
  provider: WebhookProvider;
  /** Provider webhook id when present (Flutterwave `wbk_*` / v3 payload id; Stripe `evt_*`). */
  id?: string;
  /** Always populated — the idempotency key consumers should dedupe on. */
  dedupeKey: string;
  /**
   * Idempotently apply this event's billing-state transition — subscription
   * status/period flips, driven by `webhookEvents.claim`'s once-only gate.
   * ALWAYS present (mirrors `payweave.subscribe`/`check`/`report`: the method
   * exists on every client; without a `database` configured, CALLING it
   * throws {@link PayweaveConfigError} rather than the method being absent).
   * See `src/products/apply.ts` for the full contract.
   */
  apply(options?: ApplyOptions): Promise<ApplyResult>;
}

/**
 * Inputs for {@link constructEvent}. `verify` is the facade's own dispatch
 * closure (provider + version already bound), so verification stays in the
 * timing-safe primitives and a v3 client can never accept a v4 signature (its
 * header is absent) and vice versa.
 */
export interface ConstructEventParams {
  /** Exact received bytes — never a re-serialized object. */
  rawBody: string | Uint8Array;
  /** `Headers` or a plain/array header map; looked up case-insensitively. */
  headers: HeaderLookup;
  provider: WebhookProvider;
  version: MappingVersion;
  /** The facade's verify dispatch (throws {@link PayweaveConfigError} for FLW without `webhookSecret`). */
  verify(input: { rawBody: string | Uint8Array; headers: HeaderLookup }): boolean;
  /** Optional injected logger for status drift. */
  logger?: Logger | undefined;
  /**
   * The `database`/`products` slice `event.apply()` runs against.
   * `undefined` when the webhooks namespace was built without a database —
   * `apply()` still exists on the returned event but throws
   * {@link PayweaveConfigError} when called.
   */
  billing?: BillingApplyContext | undefined;
}

function decodeBody(rawBody: string | Uint8Array): string {
  return typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Native event name: Paystack uses `event`; FLW v4 uses `type`, v3 uses `event`; Stripe uses `type`. */
function extractNativeType(root: Record<string, unknown>, provider: WebhookProvider): string {
  const candidate =
    provider === "flutterwave"
      ? (root.type ?? root.event)
      : provider === "stripe"
        ? root.type
        : root.event;
  return typeof candidate === "string" ? candidate : "unknown";
}

/** Provider webhook id (`wbk_*` on FLW v4, sometimes on v3 payloads; `evt_*` on Stripe). */
function extractWebhookId(root: Record<string, unknown>): string | undefined {
  return typeof root.id === "string" && root.id.length > 0 ? root.id : undefined;
}

/**
 * Idempotency key:
 * - Flutterwave: the webhook `id` when present, else `data.id + ':' + status`.
 * - Paystack (no webhook id): `sha256(event + ':' + data.id + ':' + data.status)`.
 * - Stripe: the globally-unique event `id` (`evt_*`); Paystack-style hash as a
 *   defensive fallback (Stripe always sends one).
 */
function computeDedupeKey(
  provider: WebhookProvider,
  nativeType: string,
  data: Record<string, unknown> | undefined,
  webhookId: string | undefined,
): string {
  // Fall back through common per-resource identifiers: many non-transaction
  // events (transfers, subscriptions, customers) carry no `data.id` but do
  // carry a unique code. Without this the key collapses to `type:status` and
  // distinct webhooks collide and get wrongly deduped.
  const idCandidate =
    data?.id ??
    data?.reference ??
    data?.transfer_code ??
    data?.subscription_code ??
    data?.customer_code;
  const dataId =
    idCandidate !== undefined && idCandidate !== null ? String(idCandidate) : "";
  const status = typeof data?.status === "string" ? data.status : "";
  if (provider === "flutterwave") {
    if (webhookId !== undefined) return webhookId;
    return `${dataId}:${status}`;
  }
  if (provider === "stripe" && webhookId !== undefined) return webhookId;
  return createHash("sha256").update(`${nativeType}:${dataId}:${status}`).digest("hex");
}

/**
 * Verify (via the facade's dispatch) → `JSON.parse` the raw bytes → normalize.
 * Fails closed: a bad signature throws {@link PayweaveWebhookVerificationError};
 * malformed JSON on an otherwise-verified body likewise throws. Unmapped events
 * are still returned with `unifiedType: "unknown"` and the native `type`
 * preserved — never dropped.
 *
 * Verification runs on the EXACT bytes and the body is NEVER re-serialized: the
 * returned `data`/`raw` come straight from `JSON.parse(rawBody)`.
 */
export function constructEvent(params: ConstructEventParams): WebhookEvent {
  const { rawBody, headers, provider, version, verify, logger, billing } = params;

  // Reuse the facade's verify dispatch (may throw PayweaveConfigError for FLW
  // without a webhookSecret — propagate that, fail closed).
  if (!verify({ rawBody, headers })) {
    throw new PayweaveWebhookVerificationError("Webhook signature verification failed.", {
      provider,
      isRetryable: false,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBody(rawBody));
  } catch (cause) {
    throw new PayweaveWebhookVerificationError("Webhook body is not valid JSON.", {
      provider,
      isRetryable: false,
      cause,
    });
  }

  const root = asRecord(parsed) ?? {};
  const data = root.data;
  const nativeType = extractNativeType(root, provider);
  // Every provider — Stripe included — normalizes through the SAME
  // `unified/mappings.ts` tables. Stripe's own event-name rows (flat
  // `STRIPE_EVENT_MAP` + nested-resource `STRIPE_EVENT_STATUS_SPLIT_MAP`)
  // live inside `toUnifiedEventType` itself; an unmapped
  // Stripe event falls through to `"unknown"` exactly like an unmapped
  // Paystack/Flutterwave event — never a special case here.
  const unifiedType = toUnifiedEventType(provider, version, nativeType, data);
  const dataRecord = asRecord(data);
  // Normalize the transaction status for its drift side effect: an unrecognized
  // status emits a `schema_drift` log (never throws) so table gaps surface.
  // Stripe is excluded here (not from unifiedType mapping above) because its
  // event envelope nests the resource one level down (`data.object.<field>`,
  // e.g. Checkout Session `payment_status` or PaymentIntent `status`) rather
  // than the flat `data.status` Paystack/Flutterwave carry — reading
  // `dataRecord?.status` for Stripe would just be `undefined` every time and
  // emit spurious drift logs. `toUnifiedEventType`'s own Stripe branch already
  // reads the correct nested field per event via `STRIPE_EVENT_STATUS_SPLIT_MAP`.
  if (provider !== "stripe" && typeof dataRecord?.status === "string") {
    toUnifiedStatus(provider, version, dataRecord.status, logger);
  }
  const webhookId =
    provider === "flutterwave" || provider === "stripe" ? extractWebhookId(root) : undefined;
  const dedupeKey = computeDedupeKey(provider, nativeType, dataRecord, webhookId);

  // Built WITHOUT `apply` first: `apply`'s closure needs to reference the
  // finished event (`dedupeKey`/`type`/`unifiedType`/`data`/`provider`), so it
  // is attached in a second step rather than inline in this literal.
  const base: Omit<WebhookEvent, "apply"> = {
    provider,
    type: nativeType,
    unifiedType,
    data,
    raw: parsed,
    dedupeKey,
    ...(webhookId !== undefined ? { id: webhookId } : {}),
  };

  return {
    ...base,
    // always present (see the `WebhookEvent.apply` doc comment);
    // `billing` is `undefined` for a database-less client, in which case
    // `applyWebhookEvent` itself throws `PayweaveConfigError` when called.
    apply: (options) => applyWebhookEvent(billing ?? NO_DATABASE_CONTEXT, base, { logger, ...options }),
  };
}
