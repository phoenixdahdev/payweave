/**
 * Row-schema parsing tests (PW-701): every table's schema accepts a valid
 * logical row and rejects the spec-relevant invalid shapes (database.md §2 —
 * integer money/counters, nullable-vs-required columns, `pwv_<ulid>` ids,
 * UTC Date timestamps).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_CLAIM_AFTER_MS,
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  PW_TABLE_PREFIX,
  PW_TABLES,
  pwCustomerSchema,
  pwCustomerUpsertSchema,
  pwFeatureBalanceInitSchema,
  pwFeatureBalanceSchema,
  pwFeatureInclusionSchema,
  pwIdSchema,
  pwMigrationRecordSchema,
  pwPlanVersionInputSchema,
  pwPlanVersionSchema,
  pwSubscriptionInputSchema,
  pwSubscriptionPatchSchema,
  pwSubscriptionSchema,
  pwWebhookEventSchema,
} from "../../src/db/schema";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID = `pwv_${ULID}`;
const AT = new Date("2026-01-15T12:00:00.000Z");

const customer = {
  id: ID,
  externalId: "user_42",
  providerIds: { stripe: "cus_123", paystack: "CUS_456" },
  email: "user@example.com",
  createdAt: AT,
  updatedAt: AT,
};

const planVersion = {
  id: ID,
  planId: "pro",
  version: 2,
  group: "base",
  isDefault: false,
  name: "Pro",
  priceMinor: 1900,
  priceCurrency: "USD",
  priceInterval: "month" as const,
  features: {
    messages: { type: "metered" as const, limit: 2000, reset: "month" as const },
    "pro-models": { type: "boolean" as const },
  },
  providerRefs: { stripe: { productId: "prod_1", priceId: "price_1" } },
  pushedAt: AT,
};

const subscription = {
  id: ID,
  customerId: ID,
  planId: "pro",
  planVersion: 2,
  group: "base",
  status: "active" as const,
  provider: "stripe",
  providerSubscriptionRef: "sub_123",
  currentPeriodStart: AT,
  currentPeriodEnd: new Date("2026-02-15T12:00:00.000Z"),
  cancelAtPeriodEnd: false,
  createdAt: AT,
  updatedAt: AT,
};

const balance = {
  id: ID,
  customerId: ID,
  featureId: "messages",
  group: "base",
  used: 5,
  limit: 100,
  resetInterval: "month" as const,
  anchor: AT,
  periodStart: AT,
  periodEnd: new Date("2026-02-15T12:00:00.000Z"),
  planId: "free",
  planVersion: 1,
  updatedAt: AT,
};

const webhookEvent = {
  dedupeKey: "stripe:evt_1",
  provider: "stripe",
  type: "invoice.paid",
  receivedAt: AT,
  claimedAt: AT,
  appliedAt: null,
};

describe("storage constants (database.md §2/§3)", () => {
  it("prefixes every table with pw_ and names them per spec", () => {
    expect(PW_TABLE_PREFIX).toBe("pw_");
    expect(PW_TABLES).toEqual({
      customers: "pw_customers",
      plans: "pw_plans",
      subscriptions: "pw_subscriptions",
      featureBalances: "pw_feature_balances",
      webhookEvents: "pw_webhook_events",
      migrations: "pw_migrations",
    });
  });

  it("pins the stale-claim default and the partial-unique status set", () => {
    expect(DEFAULT_STALE_CLAIM_AFTER_MS).toBe(60_000);
    expect(PW_ACTIVE_SUBSCRIPTION_STATUSES).toEqual(["active", "past_due", "trialing"]);
  });
});

describe("pwIdSchema — pwv_<ulid>", () => {
  it("accepts canonical and lowercase ULIDs (Crockford decode is case-insensitive)", () => {
    expect(pwIdSchema.parse(ID)).toBe(ID);
    expect(pwIdSchema.parse(`pwv_${ULID.toLowerCase()}`)).toBe(`pwv_${ULID.toLowerCase()}`);
  });

  it("rejects missing prefix, wrong length, and excluded ULID letters", () => {
    // Last case: right length, but leading "I" is outside the Crockford alphabet.
    for (const bad of [ULID, `pw_${ULID}`, "pwv_", `pwv_${ULID}X`, `pwv_I${ULID.slice(1)}`]) {
      expect(pwIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("pw_customers row schema", () => {
  it("parses a valid row and a null email", () => {
    expect(pwCustomerSchema.parse(customer)).toEqual(customer);
    expect(pwCustomerSchema.parse({ ...customer, email: null }).email).toBeNull();
  });

  it("rejects undefined email (nullable column, not optional key)", () => {
    const withoutEmail: Record<string, unknown> = { ...customer };
    delete withoutEmail.email;
    expect(pwCustomerSchema.safeParse(withoutEmail).success).toBe(false);
  });

  it("rejects empty externalId, non-string provider refs, and string timestamps", () => {
    expect(pwCustomerSchema.safeParse({ ...customer, externalId: "" }).success).toBe(false);
    expect(
      pwCustomerSchema.safeParse({ ...customer, providerIds: { stripe: 1 } }).success,
    ).toBe(false);
    expect(
      pwCustomerSchema.safeParse({ ...customer, createdAt: "2026-01-15T12:00:00Z" }).success,
    ).toBe(false);
  });

  it("upsert input requires externalId; email stays optional", () => {
    expect(pwCustomerUpsertSchema.parse({ externalId: "user_1" })).toEqual({
      externalId: "user_1",
    });
    expect(pwCustomerUpsertSchema.safeParse({ email: "a@b.c" }).success).toBe(false);
  });
});

describe("pw_plans row schema", () => {
  it("parses a paid plan version and a free (all-null price) version", () => {
    expect(pwPlanVersionSchema.parse(planVersion)).toEqual(planVersion);
    const free = {
      ...planVersion,
      planId: "free",
      isDefault: true,
      name: null,
      priceMinor: null,
      priceCurrency: null,
      priceInterval: null,
    };
    expect(pwPlanVersionSchema.parse(free)).toEqual(free);
  });

  it("rejects float or negative money — integer minor units only (golden rule 7)", () => {
    expect(pwPlanVersionSchema.safeParse({ ...planVersion, priceMinor: 19.99 }).success).toBe(
      false,
    );
    expect(pwPlanVersionSchema.safeParse({ ...planVersion, priceMinor: -1 }).success).toBe(false);
  });

  it("rejects non-positive versions and unknown price intervals", () => {
    expect(pwPlanVersionSchema.safeParse({ ...planVersion, version: 0 }).success).toBe(false);
    expect(pwPlanVersionSchema.safeParse({ ...planVersion, version: 1.5 }).success).toBe(false);
    expect(pwPlanVersionSchema.safeParse({ ...planVersion, priceInterval: "week" }).success).toBe(
      false,
    );
  });

  it("validates the features record: metered needs limit+reset, extras survive", () => {
    expect(
      pwFeatureInclusionSchema.parse({ type: "metered", limit: 10, reset: "day", label: "x" }),
    ).toEqual({ type: "metered", limit: 10, reset: "day", label: "x" });
    expect(pwFeatureInclusionSchema.safeParse({ type: "metered", limit: 10 }).success).toBe(false);
    expect(pwFeatureInclusionSchema.safeParse({ type: "metered", limit: 0, reset: "day" }).success).toBe(false);
    expect(
      pwPlanVersionSchema.safeParse({
        ...planVersion,
        features: { messages: { type: "metered", limit: "many", reset: "month" } },
      }).success,
    ).toBe(false);
  });

  it("pushVersion input strips adapter-assigned columns (id/version/pushedAt)", () => {
    const parsed = pwPlanVersionInputSchema.parse(planVersion);
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("version");
    expect(parsed).not.toHaveProperty("pushedAt");
    expect(parsed.planId).toBe("pro");
  });
});

describe("pw_subscriptions row schema", () => {
  it("parses provider-backed and local (null-provider) rows", () => {
    expect(pwSubscriptionSchema.parse(subscription)).toEqual(subscription);
    const local = { ...subscription, provider: null, providerSubscriptionRef: null };
    expect(pwSubscriptionSchema.parse(local)).toEqual(local);
  });

  it("rejects unknown statuses and non-pwv customer ids", () => {
    expect(pwSubscriptionSchema.safeParse({ ...subscription, status: "paused" }).success).toBe(
      false,
    );
    expect(
      pwSubscriptionSchema.safeParse({ ...subscription, customerId: "user_42" }).success,
    ).toBe(false);
  });

  it("input drops id/timestamps; patch is partial and never moves customer/group", () => {
    const input = pwSubscriptionInputSchema.parse(subscription);
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("createdAt");
    expect(pwSubscriptionPatchSchema.parse({ status: "canceled" })).toEqual({
      status: "canceled",
    });
    // Unknown-to-the-patch keys (customerId/group) are stripped, not applied.
    expect(pwSubscriptionPatchSchema.parse({ customerId: ID, group: "other" })).toEqual({});
  });
});

describe("pw_feature_balances row schema", () => {
  it("parses a valid row — and a negative `used` (unconditional consume may overdraw)", () => {
    expect(pwFeatureBalanceSchema.parse(balance)).toEqual(balance);
    expect(pwFeatureBalanceSchema.parse({ ...balance, used: -3 }).used).toBe(-3);
  });

  it("rejects float counters, negative limits, and unknown reset intervals", () => {
    expect(pwFeatureBalanceSchema.safeParse({ ...balance, used: 0.5 }).success).toBe(false);
    expect(pwFeatureBalanceSchema.safeParse({ ...balance, limit: -1 }).success).toBe(false);
    expect(
      pwFeatureBalanceSchema.safeParse({ ...balance, resetInterval: "fortnight" }).success,
    ).toBe(false);
  });

  it("init template carries exactly the underivable fields", () => {
    const init = {
      limit: 100,
      resetInterval: "month" as const,
      anchor: AT,
      planId: "free",
      planVersion: 1,
    };
    expect(pwFeatureBalanceInitSchema.parse(init)).toEqual(init);
    expect(pwFeatureBalanceInitSchema.safeParse({ ...init, anchor: AT.getTime() }).success).toBe(
      false,
    );
    // `used`/period bounds are derived by the adapter — not part of the template.
    expect(pwFeatureBalanceInitSchema.parse({ ...init, used: 5 })).not.toHaveProperty("used");
  });
});

describe("pw_webhook_events row schema", () => {
  it("parses claimed/unclaimed/applied combinations", () => {
    expect(pwWebhookEventSchema.parse(webhookEvent)).toEqual(webhookEvent);
    const fresh = { ...webhookEvent, claimedAt: null, appliedAt: null };
    expect(pwWebhookEventSchema.parse(fresh)).toEqual(fresh);
  });

  it("rejects an empty dedupe key and missing claim columns", () => {
    expect(pwWebhookEventSchema.safeParse({ ...webhookEvent, dedupeKey: "" }).success).toBe(false);
    const withoutClaimedAt: Record<string, unknown> = { ...webhookEvent };
    delete withoutClaimedAt.claimedAt;
    expect(pwWebhookEventSchema.safeParse(withoutClaimedAt).success).toBe(false);
  });
});

describe("pw_migrations row schema", () => {
  it("parses a ledger row and rejects a missing checksum", () => {
    const row = { name: "0001_init", appliedAt: AT, checksum: "sha256:abc" };
    expect(pwMigrationRecordSchema.parse(row)).toEqual(row);
    expect(pwMigrationRecordSchema.safeParse({ name: "0001_init", appliedAt: AT }).success).toBe(
      false,
    );
  });
});
