/**
 * unified/mappings.ts — the single source of truth for webhook + status
 * normalization (PRD §8.3 unified event names, provider-reference §3 status
 * vocabularies).
 *
 * ⚠️ PUBLIC CONTRACT (AGENTS.md §9). The `unifiedType` / `UnifiedStatus`
 * vocabularies and the provider→unified mappings below are a stable, public
 * contract. Changing their SEMANTICS (renaming a unified value, remapping an
 * existing native event/status to a different unified value) is a breaking
 * change and REQUIRES a `major`/`minor` changeset discussion. ADDING a new
 * native→unified row (so a previously-`unknown` event/status now normalizes) is
 * a `minor`. Never DROP a mapping and never throw on an unmapped input — unknown
 * events fall through to `"unknown"`, unknown statuses fall through to
 * `"pending"` plus a `schema_drift` log.
 *
 * Design: data-driven tables keyed by provider (+ version for Flutterwave, whose
 * v3/v4 status vocabularies differ — v3 `successful` vs v4 `succeeded`). The two
 * exported functions are pure; an optional `logger` is injected by callers so
 * drift can be surfaced without `console.*`.
 */
import type { Logger } from "../core/logger";

/** Provider identifier accepted by the mapping functions. */
export type MappingProvider = "paystack" | "flutterwave";
/** Flutterwave version selector. `undefined` for Paystack (unversioned). */
export type MappingVersion = "v3" | "v4" | undefined;

/**
 * Normalized, provider-agnostic webhook event type (PRD §8.3). `"unknown"` is a
 * first-class value: unmapped native events are delivered as `"unknown"`, never
 * dropped.
 */
export type UnifiedEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "transfer.succeeded"
  | "transfer.failed"
  | "transfer.reversed"
  | "refund.processed"
  | "subscription.created"
  | "dispute.created"
  | "unknown";

/** Normalized transaction status (provider-reference §3). */
export type UnifiedStatus = "success" | "failed" | "pending" | "abandoned" | "reversed";

// ── Event-name tables ────────────────────────────────────────────────────────

/**
 * Paystack native webhook event → unified type. Paystack event names are
 * status-independent (a `charge.success` is always a success), so this is a flat
 * lookup. Anything absent → `"unknown"`.
 */
export const PAYSTACK_EVENT_MAP: Readonly<Record<string, UnifiedEventType>> = {
  "charge.success": "payment.succeeded",
  "transfer.success": "transfer.succeeded",
  "transfer.failed": "transfer.failed",
  "transfer.reversed": "transfer.reversed",
  "refund.processed": "refund.processed",
  "subscription.create": "subscription.created",
  "charge.dispute.create": "dispute.created",
};

/**
 * Flutterwave native webhook events whose unified type SPLITS on the transaction
 * status carried in `data.status` (e.g. `charge.completed` is a success OR a
 * failure depending on the status). Resolved through {@link toUnifiedStatus} so
 * the v3 (`successful`) vs v4 (`succeeded`) vocabulary difference is handled in
 * one place.
 */
export const FLUTTERWAVE_STATUS_SPLIT_MAP: Readonly<
  Record<string, { readonly succeeded: UnifiedEventType; readonly failed: UnifiedEventType }>
> = {
  "charge.completed": { succeeded: "payment.succeeded", failed: "payment.failed" },
  "transfer.completed": { succeeded: "transfer.succeeded", failed: "transfer.failed" },
};

/**
 * Flutterwave native events with a status-independent unified type. Kept minimal
 * and conservative — the v3 event set diverges from the v4 sample payloads.
 * NOTE(verify): extend against the FLW v3 vs v4 doc selectors before promoting
 * refund / chargeback events out of `"unknown"`.
 */
export const FLUTTERWAVE_EVENT_MAP: Readonly<Record<string, UnifiedEventType>> = {
  // Reserved for status-independent FLW events (subscription/refund/chargeback)
  // once their exact native names are verified per doc version.
};

// ── Status tables ────────────────────────────────────────────────────────────

/** Paystack transaction `status` strings → unified status. */
export const PAYSTACK_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  success: "success",
  failed: "failed",
  pending: "pending",
  ongoing: "pending",
  processing: "pending",
  queued: "pending",
  abandoned: "abandoned",
  reversed: "reversed",
};

/** Flutterwave v3 transaction `status` strings → unified status (`successful`). */
export const FLUTTERWAVE_V3_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  successful: "success",
  failed: "failed",
  pending: "pending",
  processing: "pending",
  queued: "pending",
};

/** Flutterwave v4 transaction `status` strings → unified status (`succeeded`). */
export const FLUTTERWAVE_V4_STATUS_MAP: Readonly<Record<string, UnifiedStatus>> = {
  succeeded: "success",
  failed: "failed",
  pending: "pending",
  processing: "pending",
  queued: "pending",
};

function statusTableFor(
  provider: MappingProvider,
  version: MappingVersion,
): Readonly<Record<string, UnifiedStatus>> {
  if (provider === "paystack") return PAYSTACK_STATUS_MAP;
  return version === "v4" ? FLUTTERWAVE_V4_STATUS_MAP : FLUTTERWAVE_V3_STATUS_MAP;
}

// ── Pure mapping functions ───────────────────────────────────────────────────

/**
 * Normalize a provider transaction status to a {@link UnifiedStatus}. Matching
 * is case-insensitive. An unrecognized status NEVER throws: it returns
 * `"pending"` (the safe default — never grant value off a webhook) and emits a
 * `schema_drift` log if a `logger` is supplied.
 *
 * @param provider - `"paystack"` | `"flutterwave"`.
 * @param version - Flutterwave version (`"v3"` | `"v4"`); `undefined` for Paystack.
 * @param nativeStatus - Provider-native status string (e.g. `"successful"`).
 * @param logger - Optional injected logger for drift reporting.
 */
export function toUnifiedStatus(
  provider: MappingProvider,
  version: MappingVersion,
  nativeStatus: string | null | undefined,
  logger?: Logger,
): UnifiedStatus {
  const key = typeof nativeStatus === "string" ? nativeStatus.trim().toLowerCase() : "";
  const table = statusTableFor(provider, version);
  const mapped = table[key];
  if (mapped !== undefined) return mapped;
  logger?.({
    type: "schema_drift",
    message: "Unknown transaction status; defaulting to 'pending'.",
    provider,
    version,
    nativeStatus,
  });
  return "pending";
}

/**
 * Normalize a provider-native webhook event name to a {@link UnifiedEventType}.
 * For Flutterwave events whose meaning depends on the transaction outcome
 * (`charge.completed`, `transfer.completed`), the split is resolved from
 * `data.status` via {@link toUnifiedStatus}. Anything unmapped → `"unknown"`
 * (delivered, never dropped).
 *
 * @param provider - `"paystack"` | `"flutterwave"`.
 * @param version - Flutterwave version; `undefined` for Paystack.
 * @param nativeType - Provider-native event name (e.g. `"charge.success"`).
 * @param data - The event's `data` object, used only for FLW status splits.
 */
export function toUnifiedEventType(
  provider: MappingProvider,
  version: MappingVersion,
  nativeType: string | null | undefined,
  data?: unknown,
): UnifiedEventType {
  const key = typeof nativeType === "string" ? nativeType.trim() : "";
  if (provider === "paystack") {
    return PAYSTACK_EVENT_MAP[key] ?? "unknown";
  }
  const split = FLUTTERWAVE_STATUS_SPLIT_MAP[key];
  if (split) {
    const status = readStatus(data);
    if (status === undefined) return "unknown";
    const unified = toUnifiedStatus(provider, version, status);
    if (unified === "success") return split.succeeded;
    if (unified === "failed") return split.failed;
    return "unknown";
  }
  return FLUTTERWAVE_EVENT_MAP[key] ?? "unknown";
}

function readStatus(data: unknown): string | undefined {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const status = (data as Record<string, unknown>).status;
    if (typeof status === "string") return status;
  }
  return undefined;
}
