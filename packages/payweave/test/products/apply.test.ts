/**
 * PW-805 — webhook → billing state (`event.apply()`). Security-critical
 * (AGENTS.md rule 6, `docs/v1/implementation/agent-playbook.md`): idempotency
 * and fail-closed correctness are the bar, not just "the happy path works."
 *
 * Vectors are produced by `signWebhook` ONLY (AGENTS.md §7) against a REAL
 * in-memory sqlite `DatabaseAdapter` (PW-706) and a REAL `createPayweave`
 * client, mirroring `subscribe.test.ts`'s (PW-804) conventions exactly — MSW
 * mocks only the network edge, never `HttpClient`/`fetch`.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { SetupServer } from "msw/node";
import { createPayweave } from "../../src/index";
import { PayweaveConfigError } from "../../src/core/errors";
import { STRIPE_BASE_URL } from "../../src/core/config";
import { createMswServer, type MockRoute } from "../../src/testing/msw";
import { signWebhook } from "../../src/testing/sign-webhook";
import { feature } from "../../src/products/feature";
import { plan } from "../../src/products/plan";
import { sqliteAdapter } from "../../src/db/sqlite";
import type { DatabaseAdapter, PwPlanVersionInput } from "../../src/db/index";
import { applyWebhookEvent } from "../../src/products/apply";

const STRIPE_WEBHOOK_SECRET = "whsec_apply_test";
const PAYSTACK_SECRET = "sk_test_apply_paystack";

// ── Products fixture ─────────────────────────────────────────────────────────

const messages = feature({ id: "messages", type: "metered" });

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
  includes: [messages({ limit: 2_000, reset: "month" })],
});
const proPlusPlan = plan({
  id: "pro-plus",
  name: "Pro Plus",
  group: "base",
  price: { amount: 49, currency: "USD", interval: "month" },
  includes: [messages({ limit: 5_000, reset: "month" })],
});
const products = [freePlan, proPlan, proPlusPlan];

const STRIPE_PRICE_ID = "price_test_pro";
const STRIPE_PRODUCT_ID = "prod_test_pro";

// ── DB seeding (mirrors subscribe.test.ts) ──────────────────────────────────

function planInput(
  overrides: Partial<PwPlanVersionInput> & Pick<PwPlanVersionInput, "planId" | "group" | "isDefault">,
): PwPlanVersionInput {
  return {
    name: null,
    priceMinor: null,
    priceCurrency: null,
    priceInterval: null,
    features: {},
    providerRefs: {},
    ...overrides,
  };
}

async function makeDb(): Promise<DatabaseAdapter> {
  const db = sqliteAdapter({ url: ":memory:" });
  await db.migrations.apply();
  await db.plans.pushVersion(planInput({ planId: "free", group: "base", isDefault: true }));
  await db.plans.pushVersion(
    planInput({
      planId: "pro",
      group: "base",
      isDefault: false,
      priceMinor: 1900,
      priceCurrency: "USD",
      priceInterval: "month",
      providerRefs: { stripe: { productId: STRIPE_PRODUCT_ID, priceId: STRIPE_PRICE_ID } },
    }),
  );
  await db.plans.pushVersion(
    planInput({
      planId: "pro-plus",
      group: "base",
      isDefault: false,
      priceMinor: 4900,
      priceCurrency: "USD",
      priceInterval: "month",
    }),
  );
  return db;
}

/** Seed an ACTIVE `pro` subscription directly (bypassing `subscribe()`) for tests focused purely on `apply()`. */
async function seedActivePro(
  db: DatabaseAdapter,
  externalId: string,
  overrides: { currentPeriodStart?: Date; currentPeriodEnd?: Date; providerSubscriptionRef?: string } = {},
) {
  const customer = await db.customers.upsert({ externalId });
  const now = Date.now();
  const row = await db.subscriptions.create({
    customerId: customer.id,
    planId: "pro",
    planVersion: 1,
    group: "base",
    status: "active",
    provider: "stripe",
    providerSubscriptionRef: overrides.providerSubscriptionRef ?? "sub_seed_1",
    currentPeriodStart: overrides.currentPeriodStart ?? new Date(now),
    currentPeriodEnd: overrides.currentPeriodEnd ?? new Date(now + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
  });
  return { customer, row };
}

function makeClient(db: DatabaseAdapter, defaultProvider: "stripe" | "paystack" = "stripe") {
  return createPayweave({
    stripe: { secretKey: "sk_test_stripe", webhookSecret: STRIPE_WEBHOOK_SECRET },
    paystack: { secretKey: PAYSTACK_SECRET },
    defaultProvider,
    database: db,
    products,
  });
}

// ── MSW edge (mirrors subscribe.test.ts) ────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  rawBody: string;
}
interface Edge {
  server: SetupServer;
  requests: () => Promise<CapturedRequest[]>;
  close: () => void;
}
async function startEdge(routes: MockRoute[]): Promise<Edge> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => raw.push(request.clone()));
  server.listen({ onUnhandledRequest: "error" });
  async function parse(req: Request): Promise<CapturedRequest> {
    const url = new URL(req.url);
    return { method: req.method, path: url.pathname, rawBody: await req.text() };
  }
  return { server, requests: () => Promise.all(raw.map(parse)), close: () => server.close() };
}
function asForm(rawBody: string): URLSearchParams {
  return new URLSearchParams(rawBody);
}

const STRIPE_CUSTOMER_ROUTE: MockRoute = {
  method: "post",
  url: `${STRIPE_BASE_URL}/v1/customers`,
  json: { id: "cus_test_1", object: "customer" },
};
const STRIPE_CHECKOUT_ROUTE: MockRoute = {
  method: "post",
  url: `${STRIPE_BASE_URL}/v1/checkout/sessions`,
  json: {
    id: "cs_test_1",
    object: "checkout.session",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    mode: "subscription",
  },
};

let edge: Edge | undefined;
afterEach(() => {
  edge?.close();
  edge = undefined;
});

// ── Stripe event builders (real field names — docs cited in src/products/apply.ts) ──

let evtCounter = 0;
function nextEvtId(): string {
  evtCounter += 1;
  return `evt_apply_test_${evtCounter}`;
}

function stripeEnvelope(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return { id: nextEvtId(), object: "event", type, data: { object } };
}

function signStripe(payload: Record<string, unknown>) {
  return signWebhook("stripe", payload, STRIPE_WEBHOOK_SECRET);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("apply() — needs a database (unified-config.md §5)", () => {
  it("throws PayweaveConfigError via event.apply() on a database-less client", async () => {
    const client = createPayweave({
      stripe: { secretKey: "sk_test_apply_no_db", webhookSecret: STRIPE_WEBHOOK_SECRET },
    });
    const signed = signStripe(
      stripeEnvelope("payment_intent.succeeded", { id: "pi_1", status: "succeeded" }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(typeof evt.apply).toBe("function");
    await expect(evt.apply()).rejects.toMatchObject({
      constructor: PayweaveConfigError,
      message: expect.stringContaining("needs a database"),
    });
  });

  it("throws PayweaveConfigError when applyWebhookEvent() is called directly without one", async () => {
    await expect(
      applyWebhookEvent(
        { database: undefined, products: undefined },
        { provider: "stripe", type: "x", unifiedType: "unknown", data: {}, dedupeKey: "d_no_db" },
      ),
    ).rejects.toMatchObject({ constructor: PayweaveConfigError });
  });
});

describe("apply() — full loop: subscribe() (paid, checkout) → payment.succeeded → active (§13)", () => {
  it("flips the incomplete row to active, sets providerSubscriptionRef, then a real subscription.updated sets the real period (items, CRITICAL finding)", async () => {
    const db = await makeDb();
    edge = await startEdge([STRIPE_CUSTOMER_ROUTE, STRIPE_CHECKOUT_ROUTE]);
    const client = makeClient(db);

    const result = await client.subscribe({ customerId: "user_loop_1", planId: "pro" });
    expect(result.status).toBe("checkout");

    // Pull the EXACT correlation data `subscribe()` sent to Stripe — a real
    // `checkout.session.completed` webhook echoes these fields verbatim
    // (subscribe.ts's own "seams left for PW-805" doc comment).
    const requests = await edge.requests();
    const checkoutReq = requests.find((r) => r.path === "/v1/checkout/sessions");
    expect(checkoutReq).toBeDefined();
    const form = asForm(checkoutReq!.rawBody);
    const rowId = form.get("client_reference_id")!;
    const pwvCustomer = form.get("metadata[pwv_customer]")!;
    const pwvPlan = form.get("metadata[pwv_plan]")!;
    expect(rowId).toMatch(/^pwv_/);
    expect(pwvPlan).toBe("pro");

    // 1) checkout.session.completed → payment.succeeded → activation.
    const completedSigned = signStripe(
      stripeEnvelope("checkout.session.completed", {
        id: "cs_test_1",
        object: "checkout.session",
        client_reference_id: rowId,
        metadata: { pwv_reference: rowId, pwv_customer: pwvCustomer, pwv_plan: pwvPlan },
        customer: "cus_test_1",
        subscription: "sub_loop_1",
        payment_status: "paid",
        status: "complete",
      }),
    );
    const completedEvent = client.webhooks.constructEvent({
      rawBody: completedSigned.body,
      headers: completedSigned.headers,
    });
    expect(completedEvent.unifiedType).toBe("payment.succeeded");

    const applied1 = await completedEvent.apply();
    expect(applied1.applied).toBe(true);
    expect(applied1.subscription).toMatchObject({
      id: rowId,
      status: "active",
      providerSubscriptionRef: "sub_loop_1",
    });

    // Replay safety — TWO angles (backlog PW-805 AC):
    // (a) calling `.apply()` twice on the SAME constructed event object.
    const replaySame = await completedEvent.apply();
    expect(replaySame).toEqual({ applied: false, skipped: "already-applied" });
    // (b) a freshly re-constructed event from an IDENTICAL redelivered payload
    //     (a real provider redelivery would build a brand-new `WebhookEvent`).
    const redelivered = client.webhooks.constructEvent({
      rawBody: completedSigned.body,
      headers: completedSigned.headers,
    });
    const replayFresh = await redelivered.apply();
    expect(replayFresh).toEqual({ applied: false, skipped: "already-applied" });

    // 2) A real `customer.subscription.updated` (Subscription-shaped payload,
    //    period on `items.data[]` per the pinned-version finding) sets the
    //    REAL period, correlated via the same pwv_customer/pwv_plan metadata.
    // `subscribe()`'s own `incomplete` row already carries a NOMINAL one-month
    // placeholder period anchored at "now" (`nominalPeriod`, `subscribe.ts`) —
    // 60 days safely clears that placeholder regardless of the calendar
    // month's length (28-31 days), so this update is never mistaken for stale.
    const now = Date.now();
    const periodStart = Math.floor(now / 1000);
    const periodEnd = periodStart + 60 * 24 * 60 * 60;
    const updatedSigned = signStripe(
      stripeEnvelope("customer.subscription.updated", {
        id: "sub_loop_1",
        object: "subscription",
        status: "active",
        cancel_at_period_end: false,
        metadata: { pwv_customer: pwvCustomer, pwv_plan: pwvPlan },
        items: {
          object: "list",
          data: [
            {
              id: "si_1",
              object: "subscription_item",
              current_period_start: periodStart,
              current_period_end: periodEnd,
            },
          ],
        },
      }),
    );
    const updatedEvent = client.webhooks.constructEvent({
      rawBody: updatedSigned.body,
      headers: updatedSigned.headers,
    });
    expect(updatedEvent.unifiedType).toBe("subscription.updated");
    const applied2 = await updatedEvent.apply();
    expect(applied2.applied).toBe(true);
    expect(applied2.subscription!.currentPeriodStart.getTime()).toBe(periodStart * 1000);
    expect(applied2.subscription!.currentPeriodEnd.getTime()).toBe(periodEnd * 1000);
    expect(applied2.subscription!.status).toBe("active");
  });
});

describe("apply() — out-of-order guard (backlog PW-805 AC)", () => {
  it("an older subscription.updated after a newer one does not regress the period", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { row } = await seedActivePro(db, "user_ooo_1");

    const newerStart = Math.floor(row.currentPeriodStart.getTime() / 1000);
    const newerEnd = Math.floor((row.currentPeriodStart.getTime() + 45 * 24 * 60 * 60 * 1000) / 1000);
    const olderEnd = Math.floor((row.currentPeriodStart.getTime() + 10 * 24 * 60 * 60 * 1000) / 1000);

    function subscriptionUpdatedEvent(periodStart: number, periodEnd: number, evtSuffix: string) {
      const signed = signStripe({
        id: `evt_ooo_${evtSuffix}`,
        object: "event",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: row.providerSubscriptionRef,
            object: "subscription",
            status: "active",
            metadata: { pwv_customer: row.customerId, pwv_plan: "pro" },
            items: {
              object: "list",
              data: [{ current_period_start: periodStart, current_period_end: periodEnd }],
            },
          },
        },
      });
      return client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    }

    // Newer event first (arrives in order).
    const newerApplied = await subscriptionUpdatedEvent(newerStart, newerEnd, "newer").apply();
    expect(newerApplied.applied).toBe(true);
    expect(newerApplied.subscription!.currentPeriodEnd.getTime()).toBe(newerEnd * 1000);

    // Older event arrives LATE (out of order) — must NOT regress the period.
    const olderApplied = await subscriptionUpdatedEvent(newerStart, olderEnd, "older").apply();
    expect(olderApplied).toEqual({ applied: false, skipped: "stale" });

    const finalRow = await db.subscriptions.getActive(row.customerId, "base");
    expect(finalRow!.currentPeriodEnd.getTime()).toBe(newerEnd * 1000);
  });

  it("a late subscription.updated after subscription.canceled does not resurrect the row", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { row } = await seedActivePro(db, "user_ooo_2");

    const canceledSigned = signStripe(
      stripeEnvelope("customer.subscription.deleted", {
        id: row.providerSubscriptionRef,
        object: "subscription",
        status: "canceled",
        metadata: { pwv_customer: row.customerId, pwv_plan: "pro" },
      }),
    );
    const canceledEvent = client.webhooks.constructEvent({
      rawBody: canceledSigned.body,
      headers: canceledSigned.headers,
    });
    const cancelResult = await canceledEvent.apply();
    expect(cancelResult.applied).toBe(true);
    expect(cancelResult.subscription!.status).toBe("canceled");

    // A late `subscription.updated` redelivered AFTER the cancellation —
    // `getActive` no longer surfaces the (now canceled) row, so this safely
    // no-ops rather than resurrecting it.
    const lateUpdateSigned = signStripe(
      stripeEnvelope("customer.subscription.updated", {
        id: row.providerSubscriptionRef,
        object: "subscription",
        status: "active",
        metadata: { pwv_customer: row.customerId, pwv_plan: "pro" },
      }),
    );
    const lateUpdateEvent = client.webhooks.constructEvent({
      rawBody: lateUpdateSigned.body,
      headers: lateUpdateSigned.headers,
    });
    const lateResult = await lateUpdateEvent.apply();
    expect(lateResult).toEqual({ applied: false, skipped: "unresolved" });

    const finalRow = await db.subscriptions.getActive(row.customerId, "base");
    expect(finalRow).toBeNull(); // still canceled/absent from the active set — NOT resurrected.
  });
});

describe("apply() — invoice.payment_failed → past_due (per spec)", () => {
  it("marks an active row past_due", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { row } = await seedActivePro(db, "user_pastdue_1");

    const signed = signStripe(
      stripeEnvelope("invoice.payment_failed", {
        id: "in_1",
        object: "invoice",
        subscription: row.providerSubscriptionRef,
        metadata: { pwv_customer: row.customerId, pwv_plan: "pro" },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.unifiedType).toBe("invoice.payment_failed");

    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription!.status).toBe("past_due");
  });

  it("also works for Paystack (invoice.payment_failed, no cancelAtPeriodEnd side effect)", async () => {
    const db = await makeDb();
    const client = makeClient(db, "paystack");
    const customer = await db.customers.upsert({ externalId: "user_pastdue_ps_1" });
    const now = Date.now();
    await db.subscriptions.create({
      customerId: customer.id,
      planId: "pro",
      planVersion: 1,
      group: "base",
      status: "active",
      provider: "paystack",
      providerSubscriptionRef: "SUB_pastdue_1",
      currentPeriodStart: new Date(now),
      currentPeriodEnd: new Date(now + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    const signed = signWebhook(
      "paystack",
      {
        event: "invoice.payment_failed",
        data: {
          subscription_code: "SUB_pastdue_1",
          metadata: { pwv_customer: customer.id, pwv_plan: "pro" },
        },
      },
      PAYSTACK_SECRET,
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.unifiedType).toBe("invoice.payment_failed");

    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription).toMatchObject({ status: "past_due", cancelAtPeriodEnd: false });
  });
});

describe("apply() — invoice.paid / payment.succeeded on an ALREADY-active row (renewal, not first activation)", () => {
  it("invoice.paid refreshes the period from invoice lines and keeps the row active", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { customer, row } = await seedActivePro(db, "user_renewal_1");

    const periodStart = Math.floor((row.currentPeriodEnd.getTime() + 1000) / 1000);
    const periodEnd = periodStart + 30 * 24 * 60 * 60;
    const signed = signStripe(
      stripeEnvelope("invoice.paid", {
        id: "in_renew_1",
        object: "invoice",
        subscription: row.providerSubscriptionRef,
        metadata: { pwv_customer: customer.id, pwv_plan: "pro" },
        lines: {
          object: "list",
          data: [{ id: "il_1", object: "line_item", period: { start: periodStart, end: periodEnd } }],
        },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.unifiedType).toBe("invoice.paid");

    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription!.status).toBe("active");
    expect(result.subscription!.currentPeriodStart.getTime()).toBe(periodStart * 1000);
    expect(result.subscription!.currentPeriodEnd.getTime()).toBe(periodEnd * 1000);
  });
});

describe("apply() — first activation carrying its own real period (not the nominal placeholder)", () => {
  it("invoice.paid resolves a fresh incomplete row via metadata.pwv_reference and sets the real period directly", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const customer = await db.customers.upsert({ externalId: "user_first_activation_1" });
    const incomplete = await db.subscriptions.create({
      customerId: customer.id,
      planId: "pro",
      planVersion: 1,
      group: "base",
      status: "incomplete",
      provider: "stripe",
      providerSubscriptionRef: null,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    const periodStart = Math.floor(Date.now() / 1000);
    const periodEnd = periodStart + 31 * 24 * 60 * 60;
    const signed = signStripe(
      stripeEnvelope("invoice.paid", {
        id: "in_first_1",
        object: "invoice",
        subscription: "sub_first_1",
        // Invoices carry their OWN `metadata` — this is the correlation path
        // available even though the Subscription/Checkout-Session metadata
        // gap (module doc comment) applies to Stripe's *subscription*-shaped
        // lifecycle events specifically, not to every Stripe object.
        metadata: { pwv_reference: incomplete.id, pwv_customer: customer.id, pwv_plan: "pro" },
        lines: {
          object: "list",
          data: [{ id: "il_1", object: "line_item", period: { start: periodStart, end: periodEnd } }],
        },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });

    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription).toMatchObject({ id: incomplete.id, status: "active", providerSubscriptionRef: "sub_first_1" });
    expect(result.subscription!.currentPeriodStart.getTime()).toBe(periodStart * 1000);
    expect(result.subscription!.currentPeriodEnd.getTime()).toBe(periodEnd * 1000);
  });
});

describe("apply() — correlation gaps are safe no-ops, never a guess at the wrong row", () => {
  it("a subscription.updated with NO pwv_customer/pwv_plan metadata is unresolved (the documented Stripe session-vs-subscription metadata gap)", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    await seedActivePro(db, "user_gap_1");

    const signed = signStripe(
      stripeEnvelope("customer.subscription.updated", {
        id: "sub_no_metadata",
        object: "subscription",
        status: "active",
        // No `metadata` at all — models today's real gap (subscribe.ts sets
        // Checkout-Session-level metadata only; a bare Subscription webhook
        // carries none of it, module doc comment).
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    const result = await evt.apply();
    expect(result).toEqual({ applied: false, skipped: "unresolved" });
  });

  it("a plan id in metadata that no longer exists in `products` is unresolved rather than guessed", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { customer } = await seedActivePro(db, "user_gap_2");

    const signed = signStripe(
      stripeEnvelope("customer.subscription.updated", {
        id: "sub_unknown_plan",
        object: "subscription",
        status: "active",
        metadata: { pwv_customer: customer.id, pwv_plan: "does-not-exist" },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    const result = await evt.apply();
    expect(result).toEqual({ applied: false, skipped: "unresolved" });
  });
});

describe("apply() — a partial items entry (no current_period_end) leaves the period untouched", () => {
  it("subscription.updated with only current_period_start on the item doesn't patch the period, but still applies the status", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { customer, row } = await seedActivePro(db, "user_partial_period_1", {
      providerSubscriptionRef: "sub_partial_1",
    });

    const signed = signStripe(
      stripeEnvelope("customer.subscription.updated", {
        id: "sub_partial_1",
        object: "subscription",
        status: "past_due",
        metadata: { pwv_customer: customer.id, pwv_plan: "pro" },
        items: {
          object: "list",
          data: [{ id: "si_1", object: "subscription_item", current_period_start: Math.floor(Date.now() / 1000) }],
        },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription!.status).toBe("past_due");
    expect(result.subscription!.currentPeriodEnd.getTime()).toBe(row.currentPeriodEnd.getTime());
  });
});

describe("apply() — unmapped/irrelevant events are a safe no-op", () => {
  it("never throws, and the claim is still consumed (replay of the SAME event is a no-op too)", async () => {
    const db = await makeDb();
    const client = makeClient(db);

    const signed = signStripe(
      stripeEnvelope("charge.dispute.created", { id: "dp_1", object: "dispute" }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.unifiedType).toBe("dispute.created");

    const result = await evt.apply();
    expect(result).toEqual({ applied: false, skipped: "unmapped" });

    const replay = await evt.apply();
    expect(replay).toEqual({ applied: false, skipped: "already-applied" });
  });

  it("a genuinely unknown native event type also no-ops safely", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const signed = signStripe(stripeEnvelope("some.future.event", { id: "x_1" }));
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.unifiedType).toBe("unknown");
    expect(await evt.apply()).toEqual({ applied: false, skipped: "unmapped" });
  });
});

describe("apply() — Paystack signature vector (activation + replay)", () => {
  it("charge.success activates an incomplete row created directly (no checkout in this test)", async () => {
    const db = await makeDb();
    const client = makeClient(db, "paystack");
    const customer = await db.customers.upsert({ externalId: "user_ps_1" });
    const incomplete = await db.subscriptions.create({
      customerId: customer.id,
      planId: "pro",
      planVersion: 1,
      group: "base",
      status: "incomplete",
      provider: "paystack",
      providerSubscriptionRef: null,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    // Paystack has no start/end period fields anywhere — only
    // `next_payment_date` (the current cycle's end,
    // src/paystack/schemas/plans.ts's `subscription` schema) — included here
    // to exercise `extractPeriod`'s Paystack path + `resolvePeriodStart`'s
    // "no period start on the payload, default to `now`" fallback.
    const nextPaymentDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
    const signed = signWebhook(
      "paystack",
      {
        event: "charge.success",
        data: {
          id: 55001,
          status: "success",
          reference: incomplete.id,
          next_payment_date: nextPaymentDate,
          metadata: { pwv_reference: incomplete.id, pwv_customer: customer.id, pwv_plan: "pro" },
        },
      },
      PAYSTACK_SECRET,
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.provider).toBe("paystack");
    expect(evt.unifiedType).toBe("payment.succeeded");

    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription).toMatchObject({ id: incomplete.id, status: "active" });
    expect(result.subscription!.currentPeriodEnd.toISOString()).toBe(nextPaymentDate);

    const replay = await evt.apply();
    expect(replay).toEqual({ applied: false, skipped: "already-applied" });
  });

  it("subscription.not_renew sets cancelAtPeriodEnd without a native status field forcing a change", async () => {
    const db = await makeDb();
    const client = makeClient(db, "paystack");
    const customer = await db.customers.upsert({ externalId: "user_ps_notrenew_1" });
    const now = Date.now();
    const row = await db.subscriptions.create({
      customerId: customer.id,
      planId: "pro",
      planVersion: 1,
      group: "base",
      status: "active",
      provider: "paystack",
      providerSubscriptionRef: "SUB_ps_1",
      currentPeriodStart: new Date(now),
      currentPeriodEnd: new Date(now + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    // `next_payment_date` well beyond the stored period end — exercises
    // `resolvePeriodStart`'s "contiguous with the stored row" fallback (no
    // period START on the Paystack payload).
    const nextPaymentDate = new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString();
    const signed = signWebhook(
      "paystack",
      {
        event: "subscription.not_renew",
        data: {
          subscription_code: "SUB_ps_1",
          status: "non-renewing",
          next_payment_date: nextPaymentDate,
          metadata: { pwv_customer: customer.id, pwv_plan: "pro" },
        },
      },
      PAYSTACK_SECRET,
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    expect(evt.unifiedType).toBe("subscription.updated");

    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(result.subscription!.currentPeriodStart.getTime()).toBe(row.currentPeriodEnd.getTime());
    expect(result.subscription!.currentPeriodEnd.toISOString()).toBe(nextPaymentDate);
  });
});

describe("apply() — plan-change resets metered balances (PW-903 seam)", () => {
  it("subscription.updated to a different plan patches planId/planVersion and resets balances.resetTo", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { customer, row } = await seedActivePro(db, "user_planchange_1");

    // Simulate prior usage on the OLD plan.
    const now = new Date();
    await db.balances.consume({
      customerId: customer.id,
      featureId: "messages",
      group: "base",
      amount: 500,
      conditional: false,
      init: { limit: 2_000, resetInterval: "month", anchor: row.currentPeriodStart, planId: "pro", planVersion: 1 },
      now,
    });
    const beforeChange = await db.balances.get(customer.id, "messages", "base");
    expect(beforeChange?.used).toBe(500);

    // 60 days safely clears `seedActivePro`'s 30-day placeholder period even
    // after `Math.floor`'s sub-second truncation (out-of-order guard compares
    // millisecond precision — see the full-loop test's identical note).
    const periodStart = Math.floor(now.getTime() / 1000);
    const periodEnd = periodStart + 60 * 24 * 60 * 60;
    const signed = signStripe(
      stripeEnvelope("customer.subscription.updated", {
        id: row.providerSubscriptionRef,
        object: "subscription",
        status: "active",
        metadata: { pwv_customer: customer.id, pwv_plan: "pro-plus" },
        items: {
          object: "list",
          data: [{ current_period_start: periodStart, current_period_end: periodEnd }],
        },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });
    const result = await evt.apply();
    expect(result.applied).toBe(true);
    expect(result.subscription!.planId).toBe("pro-plus");

    const finalRow = await db.subscriptions.getActive(customer.id, "base");
    expect(finalRow?.planId).toBe("pro-plus");

    const afterChange = await db.balances.get(customer.id, "messages", "base");
    expect(afterChange).toMatchObject({ used: 0, limit: 5_000, planId: "pro-plus" });
  });
});

describe("apply() — claimed-but-unapplied re-claim window (integration with webhookEvents.claim)", () => {
  it("does not re-apply before staleClaimAfterMs, and does re-apply after (crash-recovery story, database.md §3)", async () => {
    const db = await makeDb();
    const client = makeClient(db);
    const { row } = await seedActivePro(db, "user_stale_claim_1");

    const signed = signStripe(
      stripeEnvelope("invoice.payment_failed", {
        id: "in_stale_1",
        object: "invoice",
        subscription: row.providerSubscriptionRef,
        metadata: { pwv_customer: row.customerId, pwv_plan: "pro" },
      }),
    );
    const evt = client.webhooks.constructEvent({ rawBody: signed.body, headers: signed.headers });

    // Simulate a PRIOR apply that claimed the event then crashed before
    // `markApplied` — exactly the state `webhookEvents.claim` (database.md §3)
    // exists to recover from, driven here (not duplicating PW-702's own
    // conformance suite) purely to prove `apply()`'s INTEGRATION with it.
    const t0 = new Date("2026-01-01T00:00:00Z");
    const claimedFirst = await db.webhookEvents.claim(evt.dedupeKey, {
      provider: "stripe",
      type: evt.type,
      now: t0,
    });
    expect(claimedFirst).toBe(true);

    // Still within the default 60s window — NOT re-claimable yet.
    const tooSoon = new Date(t0.getTime() + 30_000);
    const tooSoonResult = await evt.apply({ now: tooSoon });
    expect(tooSoonResult).toEqual({ applied: false, skipped: "already-applied" });
    expect((await db.subscriptions.getActive(row.customerId, "base"))?.status).toBe("active");

    // Past the window — re-claimable, applies for real.
    const afterWindow = new Date(t0.getTime() + 61_000);
    const laterResult = await evt.apply({ now: afterWindow });
    expect(laterResult.applied).toBe(true);
    expect(laterResult.subscription!.status).toBe("past_due");
  });
});
