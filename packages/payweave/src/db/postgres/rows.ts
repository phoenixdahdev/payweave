/**
 * Row (de)serialization between `pg`'s native result rows and the `z.infer`
 * row types in `src/db/schema.ts` (docs/v1/database.md §4 storage mapping:
 * `TIMESTAMPTZ`, `JSONB`, `BOOLEAN`, `BIGINT` — `src/db/migrations/ddl.ts`
 * header).
 *
 * `pg` already parses `TIMESTAMPTZ` -> `Date`, `JSONB` -> plain JS
 * object/array, and `BOOLEAN` -> `boolean` for us (unlike sqlite, which
 * stores everything as INTEGER/TEXT and needs manual encode/decode) — the one
 * thing `pg` does NOT do by default is `BIGINT`/`int8` (`used`, `"limit"`):
 * it returns those as strings to avoid silent precision loss for values
 * beyond `Number.MAX_SAFE_INTEGER`. Payweave's usage counters are always
 * well within safe-integer range (AGENTS.md §2 rule 7 — integers throughout),
 * so this module converts them back to `number` explicitly, per row, rather
 * than installing a process-wide `pg.types` parser override (which would
 * silently change how the CALLER's own, unrelated `pg` queries elsewhere in
 * their app parse `BIGINT` — too invasive for a library to do unasked).
 *
 * Every reader is defensive about column types (driver rows are
 * `Record<string, unknown>`) so a `pg` version returning an unexpected shape
 * fails loudly here instead of silently corrupting a row further up the stack.
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
    throw new Error(`postgres adapter: row is missing expected column "${column}"`);
  }
  return row[column];
}

function str(row: SqlRow, column: string): string {
  const value = requireColumn(row, column);
  if (typeof value !== "string") {
    throw new Error(`postgres adapter: expected column "${column}" to be a string, got ${typeof value}`);
  }
  return value;
}

function nullableStr(row: SqlRow, column: string): string | null {
  const value = requireColumn(row, column);
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(
      `postgres adapter: expected column "${column}" to be a string or null, got ${typeof value}`,
    );
  }
  return value;
}

/** `INTEGER` columns — `pg` already returns these as `number`. */
function int(row: SqlRow, column: string): number {
  const value = requireColumn(row, column);
  if (typeof value !== "number") {
    throw new Error(`postgres adapter: expected column "${column}" to be a number, got ${typeof value}`);
  }
  return value;
}

/** `BIGINT` columns — `pg` returns these as `string`; see the module header. */
function bigint(row: SqlRow, column: string): number {
  const value = requireColumn(row, column);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `postgres adapter: column "${column}" (${value}) is outside Number.isSafeInteger range`,
      );
    }
    return n;
  }
  throw new Error(
    `postgres adapter: expected column "${column}" to be a bigint string or number, got ${typeof value}`,
  );
}

function bool(row: SqlRow, column: string): boolean {
  const value = requireColumn(row, column);
  if (typeof value !== "boolean") {
    throw new Error(`postgres adapter: expected column "${column}" to be a boolean, got ${typeof value}`);
  }
  return value;
}

function dateOf(row: SqlRow, column: string): Date {
  const value = requireColumn(row, column);
  if (!(value instanceof Date)) {
    throw new Error(`postgres adapter: expected column "${column}" to be a Date, got ${typeof value}`);
  }
  return value;
}

function nullableDateOf(row: SqlRow, column: string): Date | null {
  const value = requireColumn(row, column);
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) {
    throw new Error(
      `postgres adapter: expected column "${column}" to be a Date or null, got ${typeof value}`,
    );
  }
  return value;
}

/** `JSONB` columns — `pg` already parses these into a plain JS value. */
function json<T>(row: SqlRow, column: string): T {
  return requireColumn(row, column) as T;
}

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
    version: int(row, "version"),
    group: str(row, "group"),
    isDefault: bool(row, "is_default"),
    name: nullableStr(row, "name"),
    priceMinor: (() => {
      const v = requireColumn(row, "price_minor");
      return v === null ? null : bigint(row, "price_minor");
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
    planVersion: int(row, "plan_version"),
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
    used: bigint(row, "used"),
    limit: bigint(row, "limit"),
    resetInterval: str(row, "reset_interval") as PwFeatureBalance["resetInterval"],
    anchor: dateOf(row, "anchor"),
    periodStart: dateOf(row, "period_start"),
    periodEnd: dateOf(row, "period_end"),
    planId: str(row, "plan_id"),
    planVersion: int(row, "plan_version"),
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
