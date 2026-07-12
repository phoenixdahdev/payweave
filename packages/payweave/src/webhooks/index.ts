// webhooks/ — signature-verification primitives + the `constructEvent`
// normalizer the SDK facade delegates to (TDD §10). The three pure, timing-safe
// verify functions stay the security boundary; `constructEvent` reuses the
// facade's already-wired verify dispatch (never re-implements verification),
// then parses the RAW bytes and normalizes via `unified/mappings.ts`.
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

export { verifyPaystack } from "./paystack";
export { verifyFlutterwaveV3 } from "./flutterwave";
export { verifyFlutterwaveV4 } from "./flutterwave-v4";

/**
 * A verified + normalized webhook event. Extends the core {@link UnifiedEvent}
 * with the provider-supplied webhook `id` (Flutterwave sends one; Paystack does
 * not — see {@link ConstructEventParams} for the dedupe-key scheme).
 */
export interface WebhookEvent extends UnifiedEvent {
  provider: MappingProvider;
  /** Provider webhook id when present (Flutterwave `wbk_*` / v3 payload id). */
  id?: string;
  /** Always populated — the idempotency key consumers should dedupe on. */
  dedupeKey: string;
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
  provider: MappingProvider;
  version: MappingVersion;
  /** The facade's verify dispatch (throws {@link PayweaveConfigError} for FLW without `webhookSecret`). */
  verify(input: { rawBody: string | Uint8Array; headers: HeaderLookup }): boolean;
  /** Optional injected logger for status drift. */
  logger?: Logger | undefined;
}

function decodeBody(rawBody: string | Uint8Array): string {
  return typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Native event name: Paystack uses `event`; FLW v4 uses `type`, v3 uses `event`. */
function extractNativeType(root: Record<string, unknown>, provider: MappingProvider): string {
  const candidate = provider === "flutterwave" ? (root.type ?? root.event) : root.event;
  return typeof candidate === "string" ? candidate : "unknown";
}

/** Flutterwave webhook id (`wbk_*` on v4; sometimes present on v3 payloads). */
function extractWebhookId(root: Record<string, unknown>): string | undefined {
  return typeof root.id === "string" && root.id.length > 0 ? root.id : undefined;
}

/**
 * Idempotency key (PRD §8.4):
 * - Flutterwave: the webhook `id` when present, else `data.id + ':' + status`.
 * - Paystack (no webhook id): `sha256(event + ':' + data.id + ':' + data.status)`.
 */
function computeDedupeKey(
  provider: MappingProvider,
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
  const { rawBody, headers, provider, version, verify, logger } = params;

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
  const unifiedType = toUnifiedEventType(provider, version, nativeType, data);
  const dataRecord = asRecord(data);
  // Normalize the transaction status for its drift side effect: an unrecognized
  // status emits a `schema_drift` log (never throws) so table gaps surface.
  if (typeof dataRecord?.status === "string") {
    toUnifiedStatus(provider, version, dataRecord.status, logger);
  }
  const webhookId = provider === "flutterwave" ? extractWebhookId(root) : undefined;
  const dedupeKey = computeDedupeKey(provider, nativeType, dataRecord, webhookId);

  return {
    provider,
    type: nativeType,
    unifiedType,
    data,
    raw: parsed,
    dedupeKey,
    ...(webhookId !== undefined ? { id: webhookId } : {}),
  };
}
