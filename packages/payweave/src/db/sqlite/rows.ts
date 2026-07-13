/**
 * Row (de)serialization between the sqlite dialect's on-disk encoding and the
 * `z.infer` row types in `src/db/schema.ts` (docs/v1/database.md §4 storage
 * mapping): timestamps are epoch-millisecond `INTEGER`s, JSON columns are
 * `TEXT`, and booleans are `INTEGER` 0|1 (`src/db/migrations/ddl.ts` header).
 *
 * Every reader is defensive about column types (`noUncheckedIndexedAccess` —
 * driver rows are `Record<string, unknown>`) so a driver returning an
 * unexpected shape fails loudly here instead of silently corrupting a row
 * further up the stack.
 */
import type {
  PwCustomer,
  PwFeatureBalance,
  PwPlanVersion,
  PwSubscription,
  PwWebhookEvent,
} from "../schema";

/** One driver-returned row: column name -> raw value. */
export type SqlRow = Record<string, unknown>;

function requireColumn(row: SqlRow, column: string): unknown {
  if (!(column in row)) {
    throw new Error(`sqlite adapter: row is missing expected column "${column}"`);
  }
  return row[column];
}

function str(row: SqlRow, column: string): string {
  const value = requireColumn(row, column);
  if (typeof value !== "string") {
    throw new Error(`sqlite adapter: expected column "${column}" to be a string, got ${typeof value}`);
  }
  return value;
}

function nullableStr(row: SqlRow, column: string): string | null {
  const value = requireColumn(row, column);
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`sqlite adapter: expected column "${column}" to be a string or null, got ${typeof value}`);
  }
  return value;
}

function num(row: SqlRow, column: string): number {
  const value = requireColumn(row, column);
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") {
    throw new Error(`sqlite adapter: expected column "${column}" to be a number, got ${typeof value}`);
  }
  return value;
}

function bool(row: SqlRow, column: string): boolean {
  return num(row, column) !== 0;
}

function dateOf(row: SqlRow, column: string): Date {
  return new Date(num(row, column));
}

function nullableDateOf(row: SqlRow, column: string): Date | null {
  const value = requireColumn(row, column);
  if (value === null || value === undefined) return null;
  return new Date(num(row, column));
}

function json<T>(row: SqlRow, column: string): T {
  return JSON.parse(str(row, column)) as T;
}

// ── Encoders (JS row field -> sqlite bind param) ────────────────────────────

export const encodeDate = (date: Date): number => date.getTime();
export const encodeNullableDate = (date: Date | null): number | null =>
  date === null ? null : date.getTime();
export const encodeBool = (value: boolean): number => (value ? 1 : 0);
export const encodeJson = (value: unknown): string => JSON.stringify(value);

// ── Row mappers ──────────────────────────────────────────────────────────────

export function rowToCustomer(row: SqlRow): PwCustomer {
  return {
    id: str(row, "id"),
    externalId: str(row, "external_id"),
    providerIds: json<Record<string, string>>(row, "provider_ids"),
    email: nullableStr(row, "email"),
    createdAt: dateOf(row, "created_at"),
    updatedAt: dateOf(row, "updated_at"),
  };
}

export function rowToPlanVersion(row: SqlRow): PwPlanVersion {
  return {
    id: str(row, "id"),
    planId: str(row, "plan_id"),
    version: num(row, "version"),
    group: str(row, "group"),
    isDefault: bool(row, "is_default"),
    name: nullableStr(row, "name"),
    priceMinor: (() => {
      const v = requireColumn(row, "price_minor");
      return v === null ? null : num(row, "price_minor");
    })(),
    priceCurrency: nullableStr(row, "price_currency"),
    priceInterval: nullableStr(row, "price_interval") as PwPlanVersion["priceInterval"],
    features: json(row, "features"),
    providerRefs: json(row, "provider_refs"),
    pushedAt: dateOf(row, "pushed_at"),
  };
}

export function rowToSubscription(row: SqlRow): PwSubscription {
  return {
    id: str(row, "id"),
    customerId: str(row, "customer_id"),
    planId: str(row, "plan_id"),
    planVersion: num(row, "plan_version"),
    group: str(row, "group"),
    status: str(row, "status") as PwSubscription["status"],
    provider: nullableStr(row, "provider"),
    providerSubscriptionRef: nullableStr(row, "provider_subscription_ref"),
    currentPeriodStart: dateOf(row, "current_period_start"),
    currentPeriodEnd: dateOf(row, "current_period_end"),
    cancelAtPeriodEnd: bool(row, "cancel_at_period_end"),
    createdAt: dateOf(row, "created_at"),
    updatedAt: dateOf(row, "updated_at"),
  };
}

export function rowToFeatureBalance(row: SqlRow): PwFeatureBalance {
  return {
    id: str(row, "id"),
    customerId: str(row, "customer_id"),
    featureId: str(row, "feature_id"),
    group: str(row, "group"),
    used: num(row, "used"),
    limit: num(row, "limit"),
    resetInterval: str(row, "reset_interval") as PwFeatureBalance["resetInterval"],
    anchor: dateOf(row, "anchor"),
    periodStart: dateOf(row, "period_start"),
    periodEnd: dateOf(row, "period_end"),
    planId: str(row, "plan_id"),
    planVersion: num(row, "plan_version"),
    updatedAt: dateOf(row, "updated_at"),
  };
}

export function rowToWebhookEvent(row: SqlRow): PwWebhookEvent {
  return {
    dedupeKey: str(row, "dedupe_key"),
    provider: str(row, "provider"),
    type: str(row, "type"),
    receivedAt: dateOf(row, "received_at"),
    claimedAt: nullableDateOf(row, "claimed_at"),
    appliedAt: nullableDateOf(row, "applied_at"),
  };
}
