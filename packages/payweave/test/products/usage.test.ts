/**
 * PW-902 — `check()` + `report()` (metered-usage.md §1–§7, minus the
 * conformance-matrix runs which are PW-903's job). End-to-end against a REAL
 * in-memory sqlite `DatabaseAdapter` (PW-706) and a REAL `createPayweave`
 * client — mirrors `test/products/subscribe.test.ts`'s style. Active
 * subscriptions are seeded directly via `database.subscriptions.create`
 * (bypassing checkout) since `check`/`report` never touch a provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayweave } from "../../src/index";
import { PayweaveConfigError, PayweaveValidationError } from "../../src/core/errors";
import { feature } from "../../src/products/feature";
import { plan } from "../../src/products/plan";
import { advance } from "../../src/products/period";
import { sqliteAdapter } from "../../src/db/sqlite";
import type { DatabaseAdapter, PwCustomer, PwSubscription } from "../../src/db/index";

// ── Products fixture ─────────────────────────────────────────────────────────
// "base" group has a default plan (free) — the common path. "addons" group
// deliberately has NO default plan, to exercise the config-error branch.

const messages = feature({ id: "messages", type: "metered" });
const proModels = feature({ id: "pro_models", type: "boolean" });
const exportsFeature = feature({ id: "exports", type: "metered" });
const seats = feature({ id: "seats", type: "metered" });

const freePlan = plan({
  id: "free",
  name: "Free",
  group: "base",
  default: true,
  includes: [messages({ limit: 100, reset: "month" })],
});

const proPlan = plan({
  id: "pro",
  name: "Pro",
  group: "base",
  price: { amount: 19, currency: "USD", interval: "month" },
  includes: [
    messages({ limit: 2_000, reset: "month" }),
    proModels(),
    exportsFeature({ limit: 50, reset: "month" }),
  ],
});

const seatsAddonPlan = plan({
  id: "seats-addon",
  name: "Extra seats",
  group: "addons",
  includes: [seats({ limit: 2, reset: "day" })],
});

const products = [freePlan, proPlan, seatsAddonPlan];

// ── DB / client helpers ──────────────────────────────────────────────────────

async function makeDb(): Promise<DatabaseAdapter> {
  const db = sqliteAdapter({ url: ":memory:" });
  await db.migrations.apply();
  return db;
}

function makeClient(db: DatabaseAdapter) {
  return createPayweave({
    stripe: { secretKey: "sk_test_stripe" },
    database: db,
    products,
  });
}

/** Seeds an ACTIVE subscription row directly (bypassing checkout — check/report never call a provider). */
async function seedActiveSubscription(
  db: DatabaseAdapter,
  externalId: string,
  planId: string,
  group: string,
  opts: { planVersion?: number; periodStart?: Date; periodEnd?: Date } = {},
): Promise<{ customer: PwCustomer; subscription: PwSubscription }> {
  const customer = await db.customers.upsert({ externalId });
  const periodStart = opts.periodStart ?? new Date();
  const periodEnd = opts.periodEnd ?? new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
  const subscription = await db.subscriptions.create({
    customerId: customer.id,
    planId,
    planVersion: opts.planVersion ?? 1,
    group,
    status: "active",
    provider: "stripe",
    providerSubscriptionRef: "sub_test_1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
  });
  return { customer, subscription };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("check() — boolean features (§4, §7 bullet 4)", () => {
  it("not included in the resolved (default) plan → denied, nulls, default plan id", async () => {
    const db = await makeDb();
    const client = makeClient(db);

    const result = await client.check({ customerId: "u_bool_1", featureId: "pro_models" });

    expect(result).toEqual({
      allowed: false,
      balance: null,
      limit: null,
      resetsAt: null,
      planId: "free",
    });
  });

  it("included via an active subscription → allowed, nulls still", async () => {
    const db = await makeDb();
    await seedActiveSubscription(db, "u_bool_2", "pro", "base");
    const client = makeClient(db);

    const result = await client.check({ customerId: "u_bool_2", featureId: "pro_models" });

    expect(result).toEqual({
      allowed: true,
      balance: null,
      limit: null,
      resetsAt: null,
      planId: "pro",
    });
  });
});

describe("report() — metered decrements + lazy creation (§4, §5)", () => {
  it("first report lazily creates the balance row seeded from the default plan", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const before = Date.now();

    const result = await client.report({ customerId: "u_lazy_1", featureId: "messages", amount: 1 });

    expect(result.balance).toBe(99);
    expect(result.resetsAt).toBeInstanceOf(Date);

    const customer = await db.customers.getByExternalId("u_lazy_1");
    expect(customer).not.toBeNull();
    const row = await db.balances.get(customer!.id, "messages", "base");
    expect(row).toMatchObject({
      used: 1,
      limit: 100,
      resetInterval: "month",
      planId: "free",
      planVersion: 1,
    });
    // Default-plan balances anchor at first use (§5) — not before "now".
    expect(row!.anchor.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.anchor.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row!.periodEnd.getTime()).toBe(advance(row!.anchor.getTime(), "month", 1));
  });

  it("subsequent reports decrement further; a plain check does not mutate beyond the peek", async () => {
    const db = await makeDb();
    const client = makeClient(db);

    await client.report({ customerId: "u_dec_1", featureId: "messages", amount: 1 });
    await client.report({ customerId: "u_dec_1", featureId: "messages", amount: 2 });

    const afterReports = await client.check({ customerId: "u_dec_1", featureId: "messages" });
    expect(afterReports).toMatchObject({ allowed: true, balance: 97, limit: 100 });

    // A plain check (amount: 0) must not decrement further.
    const again = await client.check({ customerId: "u_dec_1", featureId: "messages" });
    expect(again.balance).toBe(97);
  });

  it("active-subscription (pro) plan resolves its own limit and plan id", async () => {
    const db = await makeDb();
    await seedActiveSubscription(db, "u_pro_1", "pro", "base", { planVersion: 3 });
    const client = makeClient(db);

    const result = await client.report({ customerId: "u_pro_1", featureId: "messages", amount: 500 });
    expect(result.balance).toBe(1_500); // 2000 - 500

    const customer = await db.customers.getByExternalId("u_pro_1");
    const row = await db.balances.get(customer!.id, "messages", "base");
    expect(row).toMatchObject({ limit: 2_000, planId: "pro", planVersion: 3 });
  });
});

describe("check()/report() — metered walkthrough (§1, §7): 100 allowed, 101st denies, lazy reset", () => {
  it("exhausts the default plan's limit, denies the 101st check, then resets after the period ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z
    vi.setSystemTime(t0);

    const db = await makeDb();
    const client = makeClient(db);

    for (let i = 0; i < 100; i++) {
      const result = await client.report({ customerId: "u_walk_1", featureId: "messages", amount: 1 });
      expect(result.balance).toBe(100 - (i + 1));
    }

    const denied = await client.check({ customerId: "u_walk_1", featureId: "messages" });
    expect(denied).toMatchObject({ allowed: false, balance: 0, limit: 100, planId: "free" });

    // Advance past the period end (half-open — exactly at period_end already
    // belongs to the NEXT period, metered-usage.md §5 / period.ts).
    const periodEnd = advance(t0, "month", 1);
    vi.setSystemTime(periodEnd);

    const afterReset = await client.check({ customerId: "u_walk_1", featureId: "messages" });
    expect(afterReset).toMatchObject({ allowed: true, balance: 100, limit: 100, planId: "free" });
    expect(afterReset.resetsAt?.getTime()).toBe(advance(t0, "month", 2));

    const customer = await db.customers.getByExternalId("u_walk_1");
    const row = await db.balances.get(customer!.id, "messages", "base");
    expect(row).toMatchObject({ used: 0, limit: 100 });
    expect(row!.periodStart.getTime()).toBe(periodEnd);
  });
});

describe("check({ consume: true }) — atomic gate (§6)", () => {
  it("allowed attempts consume; the denied attempt leaves the balance untouched", async () => {
    const db = await makeDb();
    await seedActiveSubscription(db, "u_gate_1", "seats-addon", "addons");
    const client = makeClient(db);

    const first = await client.check({ customerId: "u_gate_1", featureId: "seats", consume: true });
    expect(first).toMatchObject({ allowed: true, balance: 1, limit: 2 });

    const second = await client.check({ customerId: "u_gate_1", featureId: "seats", consume: true });
    expect(second).toMatchObject({ allowed: true, balance: 0, limit: 2 });

    const third = await client.check({ customerId: "u_gate_1", featureId: "seats", consume: true });
    expect(third).toMatchObject({ allowed: false, balance: 0, limit: 2 });

    const customer = await db.customers.getByExternalId("u_gate_1");
    const row = await db.balances.get(customer!.id, "seats", "addons");
    // Exactly 2 consumed — the denied 3rd attempt did not decrement further.
    expect(row!.used).toBe(2);
  });
});

describe("check()/report() — missing database guard (unified-config.md §3)", () => {
  it("check throws PayweaveConfigError when no database is configured", async () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" } });
    await expect(
      client.check({ customerId: "u_no_db", featureId: "anything" as never }),
    ).rejects.toBeInstanceOf(PayweaveConfigError);
  });

  it("report throws PayweaveConfigError when no database is configured", async () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" } });
    await expect(
      client.report({ customerId: "u_no_db", featureId: "anything" as never, amount: 1 }),
    ).rejects.toBeInstanceOf(PayweaveConfigError);
  });
});

describe("check()/report() — unknown feature / plan / amount guards (§6)", () => {
  it("check on an unknown featureId throws PayweaveValidationError", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    await expect(
      client.check({ customerId: "u_unknown_1", featureId: "does-not-exist" as never }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it("check with `database` configured but no `products` at all throws PayweaveValidationError", async () => {
    const db = await makeDb();
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" }, database: db });
    await expect(
      client.check({ customerId: "u_unknown_3", featureId: "anything" as never }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it("report on an unknown featureId throws PayweaveValidationError", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    await expect(
      client.report({ customerId: "u_unknown_2", featureId: "does-not-exist" as never, amount: 1 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it("report on a boolean feature throws PayweaveValidationError", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    await expect(
      client.report({ customerId: "u_bool_report", featureId: "pro_models" as never, amount: 1 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it.each([0, -1, 1.5])("report with an invalid amount (%s) throws PayweaveValidationError", async (amount) => {
    const db = await makeDb();
    const client = makeClient(db);
    await expect(
      client.report({ customerId: "u_bad_amount", featureId: "messages", amount }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it("report defaults amount to 1 when omitted", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const result = await client.report({ customerId: "u_default_amount", featureId: "messages" });
    expect(result.balance).toBe(99);
  });

  it("an active subscription referencing a plan no longer in `products` throws PayweaveValidationError", async () => {
    const db = await makeDb();
    await seedActiveSubscription(db, "u_ghost_1", "ghost-plan", "base");
    const client = makeClient(db);
    await expect(
      client.check({ customerId: "u_ghost_1", featureId: "messages" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it("a feature whose group has no default plan and no active subscription throws PayweaveConfigError", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    await expect(
      client.check({ customerId: "u_no_default_group", featureId: "seats" }),
    ).rejects.toBeInstanceOf(PayweaveConfigError);
  });

  it("check answers allowed: false (not an error) for a metered feature the resolved plan excludes", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const result = await client.check({ customerId: "u_not_included_1", featureId: "exports" });
    expect(result).toEqual({ allowed: false, balance: null, limit: null, resetsAt: null, planId: "free" });
  });

  it("report on a metered feature the resolved plan excludes throws PayweaveValidationError", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    await expect(
      client.report({ customerId: "u_not_included_2", featureId: "exports", amount: 1 }),
    ).rejects.toMatchObject({ constructor: PayweaveValidationError, message: expect.stringContaining("not included") });
  });
});
