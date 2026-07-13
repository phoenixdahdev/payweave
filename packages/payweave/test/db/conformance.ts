/**
 * The `DatabaseAdapter` conformance suite (database.md §6, PW-702) — the
 * contract's EXECUTABLE spec. Every first-party adapter (PW-704+) runs it in
 * CI via {@link runDatabaseConformance}; community adapters are expected to
 * run it too. It covers, per database.md §6:
 *
 * - CRUD + uniqueness invariants for all tables (incl. the partial-unique
 *   active-subscription rule),
 * - `plans.pushVersion` idempotency (same content → same version; changed
 *   content → version + 1; append-only),
 * - `webhookEvents.claim` once-only under parallel claims, stale-claim
 *   re-acquisition timing ("never before"), applied-is-terminal,
 * - `balances.consume` conditional gating (never over-admits, never mutates
 *   on denial) and unconditional negative balances,
 * - the §5 concurrency + period-boundary tests (real `Promise.all` races
 *   with deterministic assertions — `now` is always injected, never slept).
 *
 * RED-BY-DESIGN, CI-SAFE: this file deliberately does NOT match the vitest
 * include glob (`test/**\/*.test.ts`) and nothing in this repo invokes
 * `runDatabaseConformance` yet — no adapter exists until PW-704+, and
 * database.md prescribes no in-memory reference adapter. The suite therefore
 * "lands red" in the sense that zero adapters are green against it, without
 * failing CI. `conformance.smoke.test.ts` dry-runs the registration through
 * {@link collectConformanceTestPlan} so a broken suite still breaks the build.
 *
 * EXTENSIBILITY (PW-903): the suite is a flat list of named scenarios
 * ({@link coreConformanceScenarios}); metering scenarios are appended via
 * `options.scenarios` (or by extending the core list) without reshaping the
 * `runDatabaseConformance(name, makeAdapter, options?)` signature.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DatabaseAdapter,
  PwConsumeInput,
  PwCustomer,
  PwFeatureBalanceInit,
  PwPlanVersionInput,
  PwSubscriptionInput,
} from "../../src/db/index";
import {
  DEFAULT_STALE_CLAIM_AFTER_MS,
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  pwCustomerSchema,
  pwFeatureBalanceSchema,
  pwPlanVersionSchema,
  pwSubscriptionSchema,
} from "../../src/db/schema";
import { advance, DAY_MS } from "../../src/products/period";
import type { ResolvedProduct } from "../../src/core/config";
import { resetBalancesForPlanChange } from "../../src/products/apply";

// ── Public shapes ────────────────────────────────────────────────────────────

/**
 * The slice of the vitest API the suite registers through. Injected (rather
 * than hard-bound) so the smoke test can dry-run the whole registration with
 * a collector, proving the suite registers cleanly with zero adapters.
 */
export interface ConformanceTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
  beforeEach(fn: () => void | Promise<void>): void;
  afterEach(fn: () => void | Promise<void>): void;
}

/** Factory result carrying an optional per-test teardown (docker truncation, pool close, …). */
export interface DatabaseAdapterHandle {
  adapter: DatabaseAdapter;
  teardown?: () => void | Promise<void>;
}

/**
 * Builds a FRESH, ISOLATED adapter (empty tables) for every test. Called in
 * `beforeEach` only — registration itself must never construct an adapter.
 */
export type DatabaseAdapterFactory = () =>
  | DatabaseAdapter
  | DatabaseAdapterHandle
  | Promise<DatabaseAdapter | DatabaseAdapterHandle>;

export interface DatabaseConformanceOptions {
  /**
   * false = the adapter's documented non-transactional fallback mode (e.g.
   * MongoDB standalone, database.md §4) — the rollback-on-throw test is
   * replaced by an error-propagation test. Default true. Adapters that
   * support both modes run the suite twice (database.md §6).
   */
  atomicTransactions?: boolean;
  /** Extra scenarios appended AFTER the core list (PW-903 metering scenarios). */
  scenarios?: readonly DatabaseConformanceScenario[];
}

/** What a scenario sees: the current test's adapter + the resolved options. */
export interface DatabaseConformanceContext {
  adapter(): DatabaseAdapter;
  options: Readonly<Required<Pick<DatabaseConformanceOptions, "atomicTransactions">>>;
}

/** One named group of conformance tests. `register` runs at collection time. */
export interface DatabaseConformanceScenario {
  name: string;
  register(api: ConformanceTestApi, ctx: DatabaseConformanceContext): void;
}

// ── Spec constants (database.md §5/§6 — fixed, NOT configurable: lowering
// them would weaken the executable spec) ─────────────────────────────────────

/** §5: N parallel conditional consumes ... */
export const CONSUME_RACE_CALLS = 50;
/** ... against this limit must yield exactly `limit` applied results. */
export const CONSUME_RACE_LIMIT = 30;
/** §6: parallel claims of one dedupe key — exactly one may win. */
export const CLAIM_RACE_CALLS = 20;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Mid-month UTC anchor; month boundaries land on the 15th at 12:00Z. */
const T0 = new Date("2026-01-15T12:00:00.000Z");
/** End-of-month anchor for the §5 clamping / no-drift boundary cases. */
const EOM_ANCHOR = new Date("2026-01-31T00:00:00.000Z");

const atMonths = (anchor: Date, n: number): Date => new Date(advance(anchor.getTime(), "month", n));
const plusMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

function makeInit(overrides: Partial<PwFeatureBalanceInit> = {}): PwFeatureBalanceInit {
  return {
    limit: 100,
    resetInterval: "month",
    anchor: T0,
    planId: "free",
    planVersion: 1,
    ...overrides,
  };
}

function makePlanInput(overrides: Partial<PwPlanVersionInput> = {}): PwPlanVersionInput {
  return {
    planId: "pro",
    group: "base",
    isDefault: false,
    name: "Pro",
    priceMinor: 1900,
    priceCurrency: "USD",
    priceInterval: "month",
    features: { messages: { type: "metered", limit: 2000, reset: "month" } },
    providerRefs: {},
    ...overrides,
  };
}

function makeSubscriptionInput(
  customerId: string,
  overrides: Partial<PwSubscriptionInput> = {},
): PwSubscriptionInput {
  return {
    customerId,
    planId: "pro",
    planVersion: 1,
    group: "base",
    status: "active",
    provider: "stripe",
    providerSubscriptionRef: "sub_123",
    currentPeriodStart: T0,
    currentPeriodEnd: atMonths(T0, 1),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

async function seedCustomer(db: DatabaseAdapter, externalId = "user_1"): Promise<PwCustomer> {
  return pwCustomerSchema.parse(
    await db.customers.upsert({ externalId, email: `${externalId}@example.com` }),
  );
}

/** consume() argument builder — defaults to an unconditional 1-unit decrement at T0+1h. */
function consumeArgs(customerId: string, overrides: Partial<PwConsumeInput> = {}): PwConsumeInput {
  return {
    customerId,
    featureId: "messages",
    group: "base",
    amount: 1,
    init: makeInit(),
    now: plusMs(T0, 3_600_000),
    ...overrides,
  };
}

/** Race `n` copies of `task` for real — the §5/§6 tests are Promise.all races, never sleeps. */
function inParallel<T>(n: number, task: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => task(i)));
}

const CLAIM_META = { provider: "stripe", type: "customer.subscription.updated" } as const;

// ── PW-903 fixtures: resolved plans for `resetBalancesForPlanChange` ────────
// `FeatureInclusion`/`ResolvedProduct` are plain structural types (the hidden
// brand `feature()` stamps on is a module-private Symbol never part of the
// TYPE, `src/products/feature.ts`'s own doc comment) — built as literals here
// rather than via `feature()`/`plan()`, which are `src/products/*` read-only
// territory for this ticket.
const FREE_PLAN_RESOLVED: ResolvedProduct = {
  id: "free",
  name: "Free",
  group: "base",
  default: true,
  price: undefined,
  includes: [{ featureId: "messages", type: "metered", limit: 100, reset: "month" }],
};

const PRO_PLAN_RESOLVED: ResolvedProduct = {
  id: "pro",
  name: "Pro",
  group: "base",
  default: false,
  price: undefined,
  includes: [
    { featureId: "messages", type: "metered", limit: 2_000, reset: "month" },
    { featureId: "pro_models", type: "boolean" },
  ],
};

// ── Scenarios ────────────────────────────────────────────────────────────────

const customersScenario: DatabaseConformanceScenario = {
  name: "customers — CRUD + external-id uniqueness",
  register(api, ctx) {
    api.it("getByExternalId returns null for an unknown external id", async () => {
      expect(await ctx.adapter().customers.getByExternalId("nobody")).toBeNull();
    });

    api.it("upsert creates a schema-valid row that getByExternalId round-trips", async () => {
      const db = ctx.adapter();
      const created = await seedCustomer(db, "user_rt");
      expect(created.externalId).toBe("user_rt");
      expect(created.email).toBe("user_rt@example.com");
      const fetched = pwCustomerSchema.parse(await db.customers.getByExternalId("user_rt"));
      expect(fetched).toEqual(created);
    });

    api.it("upsert is idempotent per externalId — same id, updated fields, one logical row", async () => {
      const db = ctx.adapter();
      const first = await seedCustomer(db, "user_up");
      const second = pwCustomerSchema.parse(
        await db.customers.upsert({ externalId: "user_up", email: "new@example.com" }),
      );
      expect(second.id).toBe(first.id);
      expect(second.email).toBe("new@example.com");
      const fetched = pwCustomerSchema.parse(await db.customers.getByExternalId("user_up"));
      expect(fetched.id).toBe(first.id);
      expect(fetched.email).toBe("new@example.com");
    });

    api.it("linkProviderRef merges refs without clobbering other providers", async () => {
      const db = ctx.adapter();
      await seedCustomer(db, "user_link");
      await db.customers.linkProviderRef("user_link", "stripe", "cus_1");
      await db.customers.linkProviderRef("user_link", "paystack", "CUS_2");
      const row = pwCustomerSchema.parse(await db.customers.getByExternalId("user_link"));
      expect(row.providerIds).toEqual({ stripe: "cus_1", paystack: "CUS_2" });
    });
  },
};

const plansScenario: DatabaseConformanceScenario = {
  name: "plans — append-only versions + pushVersion idempotency",
  register(api, ctx) {
    api.it("getActiveVersion/listActive are empty before any push", async () => {
      const db = ctx.adapter();
      expect(await db.plans.getActiveVersion("pro")).toBeNull();
      expect(await db.plans.listActive()).toEqual([]);
    });

    api.it("first push creates version 1 (schema-valid, input round-tripped)", async () => {
      const db = ctx.adapter();
      const input = makePlanInput();
      const pushed = pwPlanVersionSchema.parse(await db.plans.pushVersion(input));
      expect(pushed.version).toBe(1);
      expect(pushed.planId).toBe("pro");
      expect(pushed.features).toEqual(input.features);
      expect(pushed.priceMinor).toBe(1900);
    });

    api.it("re-pushing identical content is a no-op — same version, same row", async () => {
      const db = ctx.adapter();
      const first = pwPlanVersionSchema.parse(await db.plans.pushVersion(makePlanInput()));
      const again = pwPlanVersionSchema.parse(await db.plans.pushVersion(makePlanInput()));
      expect(again.version).toBe(first.version);
      expect(again.id).toBe(first.id);
      expect(await db.plans.listActive()).toHaveLength(1);
    });

    api.it("changed content appends version + 1 and becomes the active version", async () => {
      const db = ctx.adapter();
      await db.plans.pushVersion(makePlanInput());
      const v2 = pwPlanVersionSchema.parse(
        await db.plans.pushVersion(
          makePlanInput({ features: { messages: { type: "metered", limit: 5000, reset: "month" } } }),
        ),
      );
      expect(v2.version).toBe(2);
      const active = pwPlanVersionSchema.parse(await db.plans.getActiveVersion("pro"));
      expect(active.version).toBe(2);
      expect(active.features.messages).toEqual({ type: "metered", limit: 5000, reset: "month" });
    });

    api.it("pushing older content again appends a NEW version — history is never mutated", async () => {
      const db = ctx.adapter();
      const v1 = await db.plans.pushVersion(makePlanInput());
      await db.plans.pushVersion(makePlanInput({ priceMinor: 2900 }));
      // Content differs from the ACTIVE version (v2), so this appends v3 even
      // though it equals v1 — append-only means v1 itself is never touched.
      const v3 = pwPlanVersionSchema.parse(await db.plans.pushVersion(makePlanInput()));
      expect(v3.version).toBe(3);
      expect(v3.id).not.toBe(pwPlanVersionSchema.parse(v1).id);
    });

    api.it("listActive returns exactly the active version of each plan id", async () => {
      const db = ctx.adapter();
      await db.plans.pushVersion(makePlanInput());
      await db.plans.pushVersion(makePlanInput({ priceMinor: 2900 }));
      await db.plans.pushVersion(makePlanInput({ planId: "free", isDefault: true, priceMinor: null, priceCurrency: null, priceInterval: null, name: "Free" }));
      const active = (await db.plans.listActive()).map((p) => pwPlanVersionSchema.parse(p));
      expect(active).toHaveLength(2);
      const byId = new Map(active.map((p) => [p.planId, p.version]));
      expect(byId.get("pro")).toBe(2);
      expect(byId.get("free")).toBe(1);
    });
  },
};

const subscriptionsScenario: DatabaseConformanceScenario = {
  name: "subscriptions — active-row lifecycle + partial-unique rule",
  register(api, ctx) {
    api.it("getActive returns null when the customer has no subscription in the group", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      expect(await db.subscriptions.getActive(customer.id, "base")).toBeNull();
    });

    api.it("create returns a schema-valid row that getActive finds", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const created = pwSubscriptionSchema.parse(
        await db.subscriptions.create(makeSubscriptionInput(customer.id)),
      );
      expect(created.customerId).toBe(customer.id);
      const active = pwSubscriptionSchema.parse(await db.subscriptions.getActive(customer.id, "base"));
      expect(active.id).toBe(created.id);
      expect(active.status).toBe("active");
    });

    api.it("update patches status/period fields and preserves the rest", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const created = await db.subscriptions.create(makeSubscriptionInput(customer.id));
      const patched = pwSubscriptionSchema.parse(
        await db.subscriptions.update(created.id, {
          status: "past_due",
          currentPeriodEnd: atMonths(T0, 2),
          cancelAtPeriodEnd: true,
        }),
      );
      expect(patched.id).toBe(created.id);
      expect(patched.status).toBe("past_due");
      expect(patched.currentPeriodEnd).toEqual(atMonths(T0, 2));
      expect(patched.cancelAtPeriodEnd).toBe(true);
      expect(patched.planId).toBe("pro");
      expect(patched.providerSubscriptionRef).toBe("sub_123");
    });

    api.it("rejects a second active-set row per (customer, group) — every active-set status", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      await db.subscriptions.create(makeSubscriptionInput(customer.id));
      for (const status of PW_ACTIVE_SUBSCRIPTION_STATUSES) {
        await expect(
          db.subscriptions.create(makeSubscriptionInput(customer.id, { status })),
        ).rejects.toThrow();
      }
    });

    api.it("canceled/incomplete rows do not occupy the partial-unique slot", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      // Historical terminal rows may coexist with a live one...
      await db.subscriptions.create(makeSubscriptionInput(customer.id, { status: "canceled" }));
      await db.subscriptions.create(makeSubscriptionInput(customer.id, { status: "incomplete" }));
      const live = await db.subscriptions.create(makeSubscriptionInput(customer.id));
      // ...and getActive answers from the active set only.
      const active = pwSubscriptionSchema.parse(await db.subscriptions.getActive(customer.id, "base"));
      expect(active.id).toBe(pwSubscriptionSchema.parse(live).id);
    });

    api.it("canceling frees the slot; other groups and customers are independent", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const other = await seedCustomer(db, "user_2");
      const first = await db.subscriptions.create(makeSubscriptionInput(customer.id));
      // Same group, other customer + other group, same customer: both fine.
      await db.subscriptions.create(makeSubscriptionInput(other.id));
      await db.subscriptions.create(makeSubscriptionInput(customer.id, { group: "addons", planId: "seats" }));
      // Cancel, then the (customer, base) slot is reusable.
      await db.subscriptions.update(first.id, { status: "canceled" });
      expect(await db.subscriptions.getActive(customer.id, "base")).toBeNull();
      const replacement = await db.subscriptions.create(
        makeSubscriptionInput(customer.id, { planId: "ultra" }),
      );
      const active = pwSubscriptionSchema.parse(await db.subscriptions.getActive(customer.id, "base"));
      expect(active.id).toBe(pwSubscriptionSchema.parse(replacement).id);
      expect(active.planId).toBe("ultra");
    });

    api.it("getActive treats past_due and trialing as active (the partial-index set)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const created = await db.subscriptions.create(
        makeSubscriptionInput(customer.id, { status: "trialing" }),
      );
      let active = pwSubscriptionSchema.parse(await db.subscriptions.getActive(customer.id, "base"));
      expect(active.status).toBe("trialing");
      await db.subscriptions.update(pwSubscriptionSchema.parse(created).id, { status: "past_due" });
      active = pwSubscriptionSchema.parse(await db.subscriptions.getActive(customer.id, "base"));
      expect(active.status).toBe("past_due");
    });
  },
};

const balancesScenario: DatabaseConformanceScenario = {
  name: "balances.consume — lazy creation + conditional gate (§3)",
  register(api, ctx) {
    api.it("get returns null before first touch; consume(amount 0) lazily creates from init", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      expect(await db.balances.get(customer.id, "messages", "base")).toBeNull();
      const result = await db.balances.consume(consumeArgs(customer.id, { amount: 0 }));
      expect(result.applied).toBe(true);
      // z.object strips the non-row `applied` flag, leaving the pure row shape.
      const parsed = pwFeatureBalanceSchema.parse(result);
      expect(parsed.used).toBe(0);
      expect(parsed.limit).toBe(100);
      expect(parsed.planId).toBe("free");
      expect(parsed.planVersion).toBe(1);
      expect(parsed.resetInterval).toBe("month");
      expect(parsed.anchor).toEqual(T0);
      // now is inside period 0 → the first anchor-relative window.
      expect(parsed.periodStart).toEqual(T0);
      expect(parsed.periodEnd).toEqual(atMonths(T0, 1));
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"))).toEqual(parsed);
    });

    api.it("unconditional consume decrements and may go negative (report semantics)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ limit: 3 });
      const first = await db.balances.consume(consumeArgs(customer.id, { amount: 2, init }));
      expect(first.applied).toBe(true);
      expect(first.used).toBe(2);
      const second = await db.balances.consume(consumeArgs(customer.id, { amount: 5, init }));
      expect(second.applied).toBe(true);
      expect(second.used).toBe(7); // 4 over the limit of 3 — negative balance by design
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base")).used).toBe(7);
    });

    api.it("conditional consume applies only when remaining ≥ amount and never mutates on denial", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ limit: 10 });
      const ok = await db.balances.consume(
        consumeArgs(customer.id, { amount: 8, conditional: true, init }),
      );
      expect(ok.applied).toBe(true);
      expect(ok.used).toBe(8);
      const before = pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"));
      const denied = await db.balances.consume(
        consumeArgs(customer.id, { amount: 3, conditional: true, init }),
      );
      expect(denied.applied).toBe(false);
      expect(denied.used).toBe(8);
      // "leave the row untouched" — the ENTIRE row is unchanged on denial.
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"))).toEqual(before);
      // Exact fit is allowed (remaining 2 ≥ 2)...
      const exact = await db.balances.consume(
        consumeArgs(customer.id, { amount: 2, conditional: true, init }),
      );
      expect(exact.applied).toBe(true);
      expect(exact.used).toBe(10);
      // ...after which any positive amount is denied but a 0-amount peek applies.
      const over = await db.balances.consume(
        consumeArgs(customer.id, { amount: 1, conditional: true, init }),
      );
      expect(over.applied).toBe(false);
      const peek = await db.balances.consume(
        consumeArgs(customer.id, { amount: 0, conditional: true, init }),
      );
      expect(peek.applied).toBe(true);
      expect(peek.used).toBe(10);
    });

    api.it("init is a creation template only — existing rows ignore it", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      await db.balances.consume(consumeArgs(customer.id, { amount: 1 }));
      const result = await db.balances.consume(
        consumeArgs(customer.id, { amount: 1, init: makeInit({ limit: 7, planId: "pro", planVersion: 3 }) }),
      );
      expect(result.limit).toBe(100);
      expect(result.planId).toBe("free");
      expect(result.planVersion).toBe(1);
      expect(result.used).toBe(2);
    });

    api.it("rows are unique per (customer, feature, group) — neighbors are untouched", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const other = await seedCustomer(db, "user_2");
      await db.balances.consume(consumeArgs(customer.id, { amount: 5 }));
      await db.balances.consume(consumeArgs(customer.id, { amount: 2, featureId: "tokens" }));
      await db.balances.consume(consumeArgs(customer.id, { amount: 3, group: "addons" }));
      await db.balances.consume(consumeArgs(other.id, { amount: 7 }));
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base")).used).toBe(5);
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "tokens", "base")).used).toBe(2);
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "addons")).used).toBe(3);
      expect(pwFeatureBalanceSchema.parse(await db.balances.get(other.id, "messages", "base")).used).toBe(7);
    });

    api.it("resetTo replaces limit/plan/anchor and zeroes usage (plan change)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      await db.balances.consume(consumeArgs(customer.id, { amount: 42 }));
      const changeAt = plusMs(T0, 5 * DAY_MS);
      await db.balances.resetTo(customer.id, "messages", "base", {
        limit: 2000,
        resetInterval: "month",
        anchor: changeAt,
        planId: "pro",
        planVersion: 2,
      });
      const row = pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"));
      expect(row.used).toBe(0);
      expect(row.limit).toBe(2000);
      expect(row.planId).toBe("pro");
      expect(row.planVersion).toBe(2);
      expect(row.anchor).toEqual(changeAt);
    });
  },
};

const consumeConcurrencyScenario: DatabaseConformanceScenario = {
  name: "balances.consume — §5 concurrency (hot path)",
  register(api, ctx) {
    api.it(`${CONSUME_RACE_CALLS} parallel conditional consumes against limit ${CONSUME_RACE_LIMIT} → exactly ${CONSUME_RACE_LIMIT} applied, ${CONSUME_RACE_CALLS - CONSUME_RACE_LIMIT} denied`, async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ limit: CONSUME_RACE_LIMIT });
      await db.balances.consume(consumeArgs(customer.id, { amount: 0, init }));
      const results = await inParallel(CONSUME_RACE_CALLS, () =>
        db.balances.consume(consumeArgs(customer.id, { amount: 1, conditional: true, init })),
      );
      const admitted = results.filter((r) => r.applied).length;
      expect(admitted).toBe(CONSUME_RACE_LIMIT);
      expect(results.length - admitted).toBe(CONSUME_RACE_CALLS - CONSUME_RACE_LIMIT);
      const row = pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"));
      expect(row.used).toBe(CONSUME_RACE_LIMIT); // zero lost updates, zero over-admits
    });

    api.it("parallel unconditional consumes lose zero updates (used === call count)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ limit: 10 }); // far below the call count — report never blocks
      await db.balances.consume(consumeArgs(customer.id, { amount: 0, init }));
      const results = await inParallel(CONSUME_RACE_CALLS, () =>
        db.balances.consume(consumeArgs(customer.id, { amount: 1, init })),
      );
      expect(results.every((r) => r.applied)).toBe(true);
      const row = pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"));
      expect(row.used).toBe(CONSUME_RACE_CALLS);
    });

    api.it("parallel first-touch consumes create exactly one row (atomic lazy creation)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ limit: 5 });
      const results = await inParallel(CLAIM_RACE_CALLS, () =>
        db.balances.consume(consumeArgs(customer.id, { amount: 1, conditional: true, init })),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.applied)).toHaveLength(5);
      const row = pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"));
      expect(row.used).toBe(5);
    });

    api.it("racing consumes across a period boundary reset exactly once (no double-reset)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ limit: CONSUME_RACE_LIMIT });
      // Seed usage inside period 0, then race conditional consumes at the boundary.
      await db.balances.consume(consumeArgs(customer.id, { amount: 10, init }));
      const boundary = atMonths(T0, 1);
      const results = await inParallel(CONSUME_RACE_LIMIT, () =>
        db.balances.consume(
          consumeArgs(customer.id, { amount: 1, conditional: true, init, now: boundary }),
        ),
      );
      // A second reset mid-race would wipe admitted decrements → used < limit.
      expect(results.filter((r) => r.applied)).toHaveLength(CONSUME_RACE_LIMIT);
      const row = pwFeatureBalanceSchema.parse(await db.balances.get(customer.id, "messages", "base"));
      expect(row.used).toBe(CONSUME_RACE_LIMIT);
      expect(row.periodStart).toEqual(atMonths(T0, 1));
      expect(row.periodEnd).toEqual(atMonths(T0, 2));
    });
  },
};

const boundaryScenario: DatabaseConformanceScenario = {
  name: "balances.consume — §5 period boundaries (lazy reset)",
  register(api, ctx) {
    api.it("does not reset strictly before period_end (now = end − 1ms)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      await db.balances.consume(consumeArgs(customer.id, { amount: 3 }));
      const result = await db.balances.consume(
        consumeArgs(customer.id, { amount: 2, now: plusMs(atMonths(T0, 1), -1) }),
      );
      expect(result.used).toBe(5);
      expect(result.periodStart).toEqual(T0);
      expect(result.periodEnd).toEqual(atMonths(T0, 1));
    });

    api.it("resets at exactly period_end — periods are half-open [start, end)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      await db.balances.consume(consumeArgs(customer.id, { amount: 3 }));
      const result = await db.balances.consume(
        consumeArgs(customer.id, { amount: 2, now: atMonths(T0, 1) }),
      );
      expect(result.used).toBe(2); // reset to 0, THEN decremented
      expect(result.periodStart).toEqual(atMonths(T0, 1));
      expect(result.periodEnd).toEqual(atMonths(T0, 2));
    });

    api.it("idle rows roll forward to the CURRENT window, not the next-oldest one", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      await db.balances.consume(consumeArgs(customer.id, { amount: 9 }));
      // ~3.5 months idle: the current window is period 3, skipping 1 and 2.
      const result = await db.balances.consume(
        consumeArgs(customer.id, { amount: 1, now: plusMs(atMonths(T0, 3), 12 * 3_600_000) }),
      );
      expect(result.used).toBe(1);
      expect(result.periodStart).toEqual(atMonths(T0, 3));
      expect(result.periodEnd).toEqual(atMonths(T0, 4));
    });

    api.it("end-of-month anchors clamp per-period without drift (Jan 31 → Feb 28 → Mar 31)", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ anchor: EOM_ANCHOR });
      // now falls in the anchor's third window: [Mar 31, Apr 30) for 2026.
      const result = await db.balances.consume(
        consumeArgs(customer.id, { amount: 1, init, now: new Date("2026-04-10T00:00:00.000Z") }),
      );
      // Hard-coded oracle: iterating on clamped outputs would have yielded Mar 28.
      expect(result.periodStart).toEqual(new Date("2026-03-31T00:00:00.000Z"));
      expect(result.periodEnd).toEqual(new Date("2026-04-30T00:00:00.000Z"));
      expect(result.periodStart).toEqual(atMonths(EOM_ANCHOR, 2));
      expect(result.periodEnd).toEqual(atMonths(EOM_ANCHOR, 3));
    });

    api.it("day resets are fixed 24h multiples of the anchor", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db);
      const init = makeInit({ resetInterval: "day" });
      const result = await db.balances.consume(
        consumeArgs(customer.id, { amount: 1, init, now: plusMs(T0, 36 * 3_600_000) }),
      );
      expect(result.periodStart).toEqual(plusMs(T0, DAY_MS));
      expect(result.periodEnd).toEqual(plusMs(T0, 2 * DAY_MS));
    });
  },
};

const claimScenario: DatabaseConformanceScenario = {
  name: "webhookEvents.claim — once-only + stale re-acquisition (§3)",
  register(api, ctx) {
    const STALE_MS = 5_000;

    api.it("first claim wins; an immediate duplicate loses", async () => {
      const db = ctx.adapter();
      expect(await db.webhookEvents.claim("evt_1", { ...CLAIM_META, now: T0 })).toBe(true);
      expect(await db.webhookEvents.claim("evt_1", { ...CLAIM_META, now: plusMs(T0, 1) })).toBe(false);
    });

    api.it(`${CLAIM_RACE_CALLS} parallel claims of one key → exactly one true`, async () => {
      const db = ctx.adapter();
      const results = await inParallel(CLAIM_RACE_CALLS, () =>
        db.webhookEvents.claim("evt_race", { ...CLAIM_META, now: T0 }),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    api.it("an applied key is never re-claimable — not even long after the stale window", async () => {
      const db = ctx.adapter();
      await db.webhookEvents.claim("evt_done", { ...CLAIM_META, now: T0, staleClaimAfterMs: STALE_MS });
      await db.webhookEvents.markApplied("evt_done");
      expect(
        await db.webhookEvents.claim("evt_done", {
          ...CLAIM_META,
          now: plusMs(T0, 1000 * STALE_MS),
          staleClaimAfterMs: STALE_MS,
        }),
      ).toBe(false);
    });

    api.it("a claimed-but-unapplied key is re-claimable at staleClaimAfterMs — and never before", async () => {
      const db = ctx.adapter();
      await db.webhookEvents.claim("evt_stale", { ...CLAIM_META, now: T0, staleClaimAfterMs: STALE_MS });
      // 1ms early: still owned by the (possibly slow, not dead) claimer.
      expect(
        await db.webhookEvents.claim("evt_stale", {
          ...CLAIM_META,
          now: plusMs(T0, STALE_MS - 1),
          staleClaimAfterMs: STALE_MS,
        }),
      ).toBe(false);
      // Exactly at the window (age >= staleClaimAfterMs): the claim is stale.
      expect(
        await db.webhookEvents.claim("evt_stale", {
          ...CLAIM_META,
          now: plusMs(T0, STALE_MS),
          staleClaimAfterMs: STALE_MS,
        }),
      ).toBe(true);
    });

    api.it("a successful steal refreshes claimed_at — the stealer's claim is fresh", async () => {
      const db = ctx.adapter();
      await db.webhookEvents.claim("evt_steal", { ...CLAIM_META, now: T0, staleClaimAfterMs: STALE_MS });
      const stealAt = plusMs(T0, STALE_MS);
      expect(
        await db.webhookEvents.claim("evt_steal", { ...CLAIM_META, now: stealAt, staleClaimAfterMs: STALE_MS }),
      ).toBe(true);
      expect(
        await db.webhookEvents.claim("evt_steal", {
          ...CLAIM_META,
          now: plusMs(stealAt, 1),
          staleClaimAfterMs: STALE_MS,
        }),
      ).toBe(false);
      expect(
        await db.webhookEvents.claim("evt_steal", {
          ...CLAIM_META,
          now: plusMs(stealAt, STALE_MS),
          staleClaimAfterMs: STALE_MS,
        }),
      ).toBe(true);
    });

    api.it(`staleClaimAfterMs defaults to ${DEFAULT_STALE_CLAIM_AFTER_MS}`, async () => {
      const db = ctx.adapter();
      await db.webhookEvents.claim("evt_default", { ...CLAIM_META, now: T0 });
      expect(
        await db.webhookEvents.claim("evt_default", {
          ...CLAIM_META,
          now: plusMs(T0, DEFAULT_STALE_CLAIM_AFTER_MS - 1),
        }),
      ).toBe(false);
      expect(
        await db.webhookEvents.claim("evt_default", {
          ...CLAIM_META,
          now: plusMs(T0, DEFAULT_STALE_CLAIM_AFTER_MS),
        }),
      ).toBe(true);
    });

    api.it("parallel steal attempts on a stale claim → exactly one true (insert-or-steal is atomic)", async () => {
      const db = ctx.adapter();
      await db.webhookEvents.claim("evt_steal_race", { ...CLAIM_META, now: T0, staleClaimAfterMs: STALE_MS });
      const results = await inParallel(CLAIM_RACE_CALLS, () =>
        db.webhookEvents.claim("evt_steal_race", {
          ...CLAIM_META,
          now: plusMs(T0, STALE_MS),
          staleClaimAfterMs: STALE_MS,
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    api.it("distinct dedupe keys claim independently", async () => {
      const db = ctx.adapter();
      expect(await db.webhookEvents.claim("evt_a", { ...CLAIM_META, now: T0 })).toBe(true);
      expect(await db.webhookEvents.claim("evt_b", { ...CLAIM_META, now: T0 })).toBe(true);
    });
  },
};

const migrationsScenario: DatabaseConformanceScenario = {
  name: "migrations — status/apply contract (§4)",
  register(api, ctx) {
    api.it("status() reports pending/applied as string arrays", async () => {
      const status = await ctx.adapter().migrations.status();
      expect(Array.isArray(status.pending)).toBe(true);
      expect(Array.isArray(status.applied)).toBe(true);
      for (const name of [...status.pending, ...status.applied]) {
        expect(typeof name).toBe("string");
      }
    });

    api.it("apply() is idempotent — a second run applies nothing new", async () => {
      const db = ctx.adapter();
      const first = await db.migrations.apply();
      expect(Array.isArray(first.applied)).toBe(true);
      if (first.instructions !== undefined) {
        // Prisma/Drizzle style: never shells out, tells the user what to run
        // (database.md §4) — applied stays empty and the instructions are stable.
        expect(first.instructions.length).toBeGreaterThan(0);
        expect(first.applied).toEqual([]);
        const second = await db.migrations.apply();
        expect(second.instructions).toBe(first.instructions);
        expect(second.applied).toEqual([]);
        return;
      }
      expect((await db.migrations.status()).pending).toEqual([]);
      const second = await db.migrations.apply();
      expect(second.applied).toEqual([]);
    });
  },
};

const transactionScenario: DatabaseConformanceScenario = {
  name: "transaction — visibility + atomicity (§5)",
  register(api, ctx) {
    api.it("returns the callback's resolved value", async () => {
      expect(await ctx.adapter().transaction(async () => 42)).toBe(42);
    });

    api.it("hands the callback a contract-shaped tx whose writes commit", async () => {
      const db = ctx.adapter();
      await db.transaction(async (tx) => {
        expect(typeof tx.balances.consume).toBe("function");
        expect(typeof tx.webhookEvents.claim).toBe("function");
        expect(typeof tx.customers.upsert).toBe("function");
        await tx.customers.upsert({ externalId: "user_tx" });
      });
      const row = pwCustomerSchema.parse(await db.customers.getByExternalId("user_tx"));
      expect(row.externalId).toBe("user_tx");
    });

    if (ctx.options.atomicTransactions) {
      api.it("rolls back every write when the callback throws", async () => {
        const db = ctx.adapter();
        const boom = new Error("apply failed");
        await expect(
          db.transaction(async (tx) => {
            await tx.customers.upsert({ externalId: "user_rollback" });
            expect(await tx.customers.getByExternalId("user_rollback")).not.toBeNull();
            throw boom;
          }),
        ).rejects.toBe(boom);
        expect(await db.customers.getByExternalId("user_rollback")).toBeNull();
      });
    } else {
      api.it("propagates the callback's error (documented non-atomic fallback mode)", async () => {
        const db = ctx.adapter();
        const boom = new Error("apply failed");
        await expect(
          db.transaction(async () => {
            throw boom;
          }),
        ).rejects.toBe(boom);
      });
    }
  },
};

// ── PW-903: metered-usage.md §7 walkthrough + boundary/race extensions ─────

const meteredWalkthroughScenario: DatabaseConformanceScenario = {
  name: "metering — metered-usage.md §7 walkthrough (PW-903)",
  register(api, ctx) {
    api.it(
      "fresh customer on the default plan: 100 allowed consumes, the 101st denies, clock past period end lazily resets to the fresh limit",
      async () => {
        const db = ctx.adapter();
        const customer = await seedCustomer(db, "user_walkthrough");
        const init = makeInit({ limit: 100 });

        // §1 steps 4–5: 100 `report`-style (unconditional amount:1) consumes all succeed.
        for (let i = 1; i <= 100; i++) {
          const result = await db.balances.consume(consumeArgs(customer.id, { amount: 1, init }));
          expect(result.applied).toBe(true);
          expect(result.used).toBe(i);
        }

        // A `check`-style peek (amount: 0) at the limit — `allowed` would be
        // `balance > 0`, i.e. false; the peek itself must not mutate (§3).
        const atLimit = await db.balances.consume(consumeArgs(customer.id, { amount: 0, init }));
        expect(atLimit.used).toBe(100);
        expect(atLimit.limit - atLimit.used).toBe(0);

        // The 101st unit is denied under the atomic gate (`check({ consume: true
        // })`, §6) — exactly-at-limit boundary: denied, row left untouched.
        const denied = await db.balances.consume(
          consumeArgs(customer.id, { amount: 1, conditional: true, init }),
        );
        expect(denied.applied).toBe(false);
        expect(denied.used).toBe(100);

        // Advance the injected clock past `periodEnd` (§5/§7) — the next call
        // lazily resets to the plan's FRESH limit via `currentPeriod`, before
        // any decrement is applied.
        const periodEnd = atMonths(T0, 1);
        const afterReset = await db.balances.consume(
          consumeArgs(customer.id, { amount: 0, init, now: periodEnd }),
        );
        expect(afterReset.used).toBe(0);
        expect(afterReset.limit).toBe(100);
        expect(afterReset.periodStart).toEqual(periodEnd);
        expect(afterReset.periodEnd).toEqual(atMonths(T0, 2));

        // Allowed again, immediately.
        const allowedAgain = await db.balances.consume(
          consumeArgs(customer.id, { amount: 1, conditional: true, init, now: periodEnd }),
        );
        expect(allowedAgain.applied).toBe(true);
        expect(allowedAgain.used).toBe(1);
      },
    );

    api.it(
      "boundary: exactly-at-limit AND exactly-at-period-boundary — reaching period_end resets even when the prior period was fully exhausted",
      async () => {
        const db = ctx.adapter();
        const customer = await seedCustomer(db, "user_exact_boundary");
        const init = makeInit({ limit: 5 });

        const exhausted = await db.balances.consume(consumeArgs(customer.id, { amount: 5, init }));
        expect(exhausted.used).toBe(5); // exactly at the limit

        // now === period_end exactly — half-open periods put this in the NEXT window.
        const boundary = atMonths(T0, 1);
        const result = await db.balances.consume(
          consumeArgs(customer.id, { amount: 0, init, now: boundary }),
        );
        expect(result.used).toBe(0);
        expect(result.limit).toBe(5);
        expect(result.periodStart).toEqual(boundary);
        expect(result.periodEnd).toEqual(atMonths(T0, 2));
      },
    );

    api.it(
      "check({ consume: true }) never over-admits under a metered-usage-realistic parallel load (limit 100 — extends the §5 race for metered features)",
      async () => {
        const db = ctx.adapter();
        const customer = await seedCustomer(db, "user_race_100");
        const init = makeInit({ limit: 100 });
        await db.balances.consume(consumeArgs(customer.id, { amount: 0, init }));

        const results = await inParallel(150, () =>
          db.balances.consume(consumeArgs(customer.id, { amount: 1, conditional: true, init })),
        );
        const admitted = results.filter((r) => r.applied).length;
        expect(admitted).toBe(100);
        expect(results.length - admitted).toBe(50);
        const row = pwFeatureBalanceSchema.parse(
          await db.balances.get(customer.id, "messages", "base"),
        );
        expect(row.used).toBe(100); // zero lost updates, zero over-admits
      },
    );
  },
};

// ── PW-903: plan-change reset (PW-805's `resetBalancesForPlanChange` seam) ──

const planChangeResetScenario: DatabaseConformanceScenario = {
  name: "balances.resetTo — plan-change reset via resetBalancesForPlanChange (PW-805 seam, PW-903)",
  register(api, ctx) {
    api.it(
      "an upgrade zeroes usage and reseeds limit/plan/anchor from the NEW plan for every metered feature it includes",
      async () => {
        const db = ctx.adapter();
        const customer = await seedCustomer(db, "user_upgrade");
        // Seed usage on the OLD plan via lazy creation (consume's own injected clock).
        const oldInit = makeInit({ limit: 100, planId: "free", planVersion: 1 });
        await db.balances.consume(consumeArgs(customer.id, { amount: 42, init: oldInit }));

        // `balances.resetTo` has NO injectable clock (database.md §3 — unlike
        // `consume`, it takes no `now`) — anchor it at the real current instant
        // so the period it derives lands in index 0, exactly like production
        // (a plan change's anchor IS "now" — metered-usage.md §5 last bullet).
        const changeAt = new Date();
        await resetBalancesForPlanChange(db, {
          customerId: customer.id,
          group: "base",
          plan: PRO_PLAN_RESOLVED,
          planVersion: 2,
          anchor: changeAt,
        });

        const row = pwFeatureBalanceSchema.parse(
          await db.balances.get(customer.id, "messages", "base"),
        );
        expect(row.used).toBe(0); // no rollover of the old plan's 42 units
        expect(row.limit).toBe(2_000);
        expect(row.planId).toBe("pro");
        expect(row.planVersion).toBe(2);
        expect(row.anchor).toEqual(changeAt);
        expect(row.periodStart).toEqual(changeAt); // new period anchored at change time
        expect(row.periodEnd).toEqual(new Date(advance(changeAt.getTime(), "month", 1)));
      },
    );

    api.it("skips boolean features — only METERED inclusions get a balance row", async () => {
      const db = ctx.adapter();
      const customer = await seedCustomer(db, "user_upgrade_mixed");
      await resetBalancesForPlanChange(db, {
        customerId: customer.id,
        group: "base",
        plan: PRO_PLAN_RESOLVED, // one metered + one boolean inclusion
        planVersion: 1,
        anchor: T0,
      });
      expect(await db.balances.get(customer.id, "messages", "base")).not.toBeNull();
      expect(await db.balances.get(customer.id, "pro_models", "base")).toBeNull();
    });

    api.it(
      "is idempotent — calling it twice with identical params leaves the row in the same state",
      async () => {
        const db = ctx.adapter();
        const customer = await seedCustomer(db, "user_idempotent");
        await db.balances.consume(consumeArgs(customer.id, { amount: 7 }));

        const params = {
          customerId: customer.id,
          group: "base",
          plan: PRO_PLAN_RESOLVED,
          planVersion: 3,
          anchor: new Date(),
        };
        await resetBalancesForPlanChange(db, params);
        const first = pwFeatureBalanceSchema.parse(
          await db.balances.get(customer.id, "messages", "base"),
        );

        await resetBalancesForPlanChange(db, params);
        const second = pwFeatureBalanceSchema.parse(
          await db.balances.get(customer.id, "messages", "base"),
        );

        // Same logical row (`id` survives the ON-CONFLICT update path), same
        // limits/plan/period — replaying the reset is a true no-op observably.
        expect(second.id).toBe(first.id);
        expect(second.used).toBe(0);
        expect(second.limit).toBe(first.limit);
        expect(second.planId).toBe(first.planId);
        expect(second.planVersion).toBe(first.planVersion);
        expect(second.anchor).toEqual(first.anchor);
        expect(second.periodStart).toEqual(first.periodStart);
        expect(second.periodEnd).toEqual(first.periodEnd);
      },
    );

    api.it(
      "a SECOND plan change replaces the first reset's limits again — no rollover across successive changes",
      async () => {
        const db = ctx.adapter();
        const customer = await seedCustomer(db, "user_double_change");

        await resetBalancesForPlanChange(db, {
          customerId: customer.id,
          group: "base",
          plan: FREE_PLAN_RESOLVED,
          planVersion: 1,
          anchor: new Date(),
        });
        // Consume against the row `resetTo` just created — real-clock `now`,
        // consistent with the anchor `resetTo` itself derived from (§5 last
        // bullet: a plan change's anchor is "now", not a fixture timestamp).
        const midway = await db.balances.consume({
          customerId: customer.id,
          featureId: "messages",
          group: "base",
          amount: 60,
          init: makeInit({ limit: 100 }), // ignored — row already exists
          now: new Date(),
        });
        expect(midway.used).toBe(60);

        const secondChangeAt = new Date();
        await resetBalancesForPlanChange(db, {
          customerId: customer.id,
          group: "base",
          plan: PRO_PLAN_RESOLVED,
          planVersion: 2,
          anchor: secondChangeAt,
        });

        const row = pwFeatureBalanceSchema.parse(
          await db.balances.get(customer.id, "messages", "base"),
        );
        expect(row.used).toBe(0); // no rollover of the 60 units consumed on the old plan
        expect(row.limit).toBe(2_000);
        expect(row.planId).toBe("pro");
        expect(row.planVersion).toBe(2);
        expect(row.anchor).toEqual(secondChangeAt);
      },
    );
  },
};

/**
 * The core §6 scenario list, in registration order, PLUS PW-903's metering +
 * plan-change-reset scenarios APPENDED at the end (additive-only extension of
 * this list — see the file header's "EXTENSIBILITY (PW-903)" note; adapters
 * calling {@link runDatabaseConformance} need no changes of their own to pick
 * these up, since they already spread this exported list).
 */
export const coreConformanceScenarios: readonly DatabaseConformanceScenario[] = [
  customersScenario,
  plansScenario,
  subscriptionsScenario,
  balancesScenario,
  consumeConcurrencyScenario,
  boundaryScenario,
  claimScenario,
  migrationsScenario,
  transactionScenario,
  meteredWalkthroughScenario,
  planChangeResetScenario,
];

// ── Runners ──────────────────────────────────────────────────────────────────

/**
 * Register the conformance suite through an injected test API. Registration
 * NEVER constructs an adapter — `makeAdapter` runs in `beforeEach` only, so
 * every test gets a fresh, isolated instance (torn down in `afterEach`).
 */
export function registerDatabaseConformance(
  api: ConformanceTestApi,
  name: string,
  makeAdapter: DatabaseAdapterFactory,
  options: DatabaseConformanceOptions = {},
): void {
  const scenarios = [...coreConformanceScenarios, ...(options.scenarios ?? [])];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.name)) {
      throw new Error(`duplicate conformance scenario name: "${scenario.name}"`);
    }
    seen.add(scenario.name);
  }

  api.describe(`DatabaseAdapter conformance — ${name}`, () => {
    let current: DatabaseAdapterHandle | undefined;
    api.beforeEach(async () => {
      const made = await makeAdapter();
      current = "adapter" in made ? made : { adapter: made };
    });
    api.afterEach(async () => {
      const handle = current;
      current = undefined;
      await handle?.teardown?.();
    });

    const ctx: DatabaseConformanceContext = {
      adapter: () => {
        if (!current) {
          throw new Error("conformance: adapter accessed outside a test body (before beforeEach ran)");
        }
        return current.adapter;
      },
      options: { atomicTransactions: options.atomicTransactions ?? true },
    };

    for (const scenario of scenarios) {
      api.describe(scenario.name, () => {
        scenario.register(api, ctx);
      });
    }
  });
}

/**
 * THE entry point adapters call from their own `*.test.ts` files
 * (database.md §6): registers the suite on the real vitest API.
 */
export function runDatabaseConformance(
  name: string,
  makeAdapter: DatabaseAdapterFactory,
  options: DatabaseConformanceOptions = {},
): void {
  registerDatabaseConformance(
    {
      describe: (title, fn) => {
        describe(title, fn);
      },
      it: (title, fn) => {
        it(title, fn);
      },
      beforeEach: (fn) => {
        beforeEach(fn);
      },
      afterEach: (fn) => {
        afterEach(fn);
      },
    },
    name,
    makeAdapter,
    options,
  );
}

/** Flattened view of what the suite WOULD register — see {@link collectConformanceTestPlan}. */
export interface ConformanceTestPlan {
  /** Full describe-block paths, "outer > inner". */
  suites: string[];
  /** Full test paths, "outer > inner > test title". */
  tests: string[];
}

/**
 * Dry-run the entire registration against a collector API and a factory that
 * throws if invoked. Lets the smoke test prove — with zero adapters in the
 * repo — that the suite registers cleanly, covers every §6 area, and stays
 * extensible for PW-903.
 */
export function collectConformanceTestPlan(
  options: DatabaseConformanceOptions = {},
): ConformanceTestPlan {
  const suites: string[] = [];
  const tests: string[] = [];
  const stack: string[] = [];
  const api: ConformanceTestApi = {
    describe: (title, fn) => {
      stack.push(title);
      suites.push(stack.join(" > "));
      fn();
      stack.pop();
    },
    it: (title) => {
      tests.push([...stack, title].join(" > "));
    },
    beforeEach: () => undefined,
    afterEach: () => undefined,
  };
  registerDatabaseConformance(
    api,
    "test-plan",
    () => {
      throw new Error("collectConformanceTestPlan: registration must never construct an adapter");
    },
    options,
  );
  return { suites, tests };
}
