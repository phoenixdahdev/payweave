/**
 * PW-804 — `subscribe()` (plans-and-features.md §11). End-to-end against a
 * REAL in-memory sqlite `DatabaseAdapter` (PW-706) and a REAL `createPayweave`
 * client, with MSW mocking only the network edge (never HttpClient/fetch,
 * AGENTS.md §7). `pw_plans` rows are seeded by hand via
 * `database.plans.pushVersion(...)` — PW-803's sync engine hasn't landed yet
 * (agent-playbook: "PW-804 can run parallel to PW-803 against fixture-seeded
 * `pw_plans` rows").
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SetupServer } from "msw/node";
import { createPayweave } from "../../src/index";
import { PayweaveConfigError, PayweaveProviderError, PayweaveValidationError } from "../../src/core/errors";
import { STRIPE_BASE_URL, PAYSTACK_BASE_URL } from "../../src/core/config";
import { createMswServer, type MockRoute } from "../../src/testing/msw";
import { feature } from "../../src/products/feature";
import { plan } from "../../src/products/plan";
import { sqliteAdapter } from "../../src/db/sqlite";
import type { DatabaseAdapter, PwPlanVersionInput } from "../../src/db/index";

// ── Products fixture ─────────────────────────────────────────────────────────

const messages = feature({ id: "messages", type: "metered" });
const proModels = feature({ id: "pro_models", type: "boolean" });

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
  includes: [messages({ limit: 2_000, reset: "month" }), proModels()],
});
const teamAddonPlan = plan({ id: "team-addon", name: "Team addon", group: "addons" });
const teamAddon2Plan = plan({ id: "team-addon-2", name: "Team addon 2", group: "addons" });
const unpushedPlan = plan({ id: "unpushed", name: "Never pushed" });

const products = [freePlan, proPlan, teamAddonPlan, teamAddon2Plan, unpushedPlan];

const STRIPE_PRICE_ID = "price_test_pro";
const STRIPE_PRODUCT_ID = "prod_test_pro";
const PAYSTACK_PLAN_CODE = "PLN_test_pro";

// ── DB seeding ───────────────────────────────────────────────────────────────

function planInput(overrides: Partial<PwPlanVersionInput> & Pick<PwPlanVersionInput, "planId" | "group" | "isDefault">): PwPlanVersionInput {
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

/** Fresh in-memory sqlite adapter with every fixture plan pushed (both provider refs by default). */
async function makeDb(
  opts: { proProviderRefs?: Record<string, Record<string, string>> } = {},
): Promise<DatabaseAdapter> {
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
      providerRefs: opts.proProviderRefs ?? {
        stripe: { productId: STRIPE_PRODUCT_ID, priceId: STRIPE_PRICE_ID },
        paystack: { planCode: PAYSTACK_PLAN_CODE },
      },
    }),
  );
  await db.plans.pushVersion(planInput({ planId: "team-addon", group: "addons", isDefault: false }));
  await db.plans.pushVersion(planInput({ planId: "team-addon-2", group: "addons", isDefault: false }));
  // "unpushed" is deliberately never pushed.
  return db;
}

// ── MSW edge ─────────────────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  host: string;
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
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

  async function parse(req: Request): Promise<CapturedRequest> {
    const url = new URL(req.url);
    return { method: req.method, host: url.host, path: url.pathname, rawBody: await req.text() };
  }

  return {
    server,
    requests: () => Promise.all(raw.map(parse)),
    close: () => server.close(),
  };
}

/** Bracket-notation Stripe form body decoded for assertions. */
function asForm(rawBody: string): URLSearchParams {
  return new URLSearchParams(rawBody);
}

/** Paystack JSON body decoded for assertions. */
function asJson(rawBody: string): Record<string, unknown> {
  return JSON.parse(rawBody) as Record<string, unknown>;
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
const PAYSTACK_CUSTOMER_ROUTE: MockRoute = {
  method: "post",
  url: `${PAYSTACK_BASE_URL}/customer`,
  json: { status: true, message: "Customer created", data: { customer_code: "CUS_test_1" } },
};
const PAYSTACK_INITIALIZE_ROUTE: MockRoute = {
  method: "post",
  url: `${PAYSTACK_BASE_URL}/transaction/initialize`,
  json: {
    status: true,
    message: "Authorization URL created",
    data: {
      authorization_url: "https://checkout.paystack.com/abc123",
      access_code: "abc123",
      reference: "pwv_paystack_ref_1",
    },
  },
};

let edge: Edge | undefined;
afterEach(() => {
  edge?.close();
  edge = undefined;
});

/** A full client with both stripe + paystack configured, plus `database`/`products`. */
function makeClient(db: DatabaseAdapter, defaultProvider: "stripe" | "paystack" = "stripe") {
  return createPayweave({
    stripe: { secretKey: "sk_test_stripe" },
    paystack: { secretKey: "sk_test_paystack" },
    defaultProvider,
    database: db,
    products,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("subscribe() — free non-default plan (§11.4)", () => {
  it("activates locally: subscription row created, active, zero provider calls", async () => {
    const db = await makeDb();
    edge = await startEdge([]); // onUnhandledRequest: "error" — any provider call fails the test.
    const client = makeClient(db);

    const result = await client.subscribe({ customerId: "user_free_1", planId: "team-addon" });

    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("unreachable");
    expect(result.planId).toBe("team-addon");
    expect(result.subscription).not.toBeNull();
    expect(result.subscription).toMatchObject({
      planId: "team-addon",
      group: "addons",
      status: "active",
      provider: null,
      providerSubscriptionRef: null,
      cancelAtPeriodEnd: false,
    });
    expect(result.subscription!.currentPeriodEnd.getTime()).toBeGreaterThan(
      result.subscription!.currentPeriodStart.getTime(),
    );

    const customer = await db.customers.getByExternalId("user_free_1");
    const active = await db.subscriptions.getActive(customer!.id, "addons");
    expect(active?.id).toBe(result.subscription!.id);

    expect(await edge.requests()).toEqual([]);
  });
});

describe("subscribe() — default plan (§11.5)", () => {
  it("no active sub in group: successful no-op, zero rows, zero provider calls", async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = makeClient(db);

    const result = await client.subscribe({ customerId: "user_default_1", planId: "free" });

    expect(result).toEqual({ status: "active", planId: "free", subscription: null });
    const customer = await db.customers.getByExternalId("user_default_1");
    expect(await db.subscriptions.getActive(customer!.id, "base")).toBeNull();
    expect(await edge.requests()).toEqual([]);
  });

  it("active paid sub already in group: throws the group-exclusivity error", async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = makeClient(db);

    const customer = await db.customers.upsert({ externalId: "user_default_2" });
    await db.subscriptions.create({
      customerId: customer.id,
      planId: "pro",
      planVersion: 1,
      group: "base",
      status: "active",
      provider: "stripe",
      providerSubscriptionRef: "sub_already_active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    await expect(client.subscribe({ customerId: "user_default_2", planId: "free" })).rejects.toMatchObject(
      {
        constructor: PayweaveValidationError,
        message: "customer already has an active plan in group 'base'",
      },
    );
    expect(await edge.requests()).toEqual([]);
  });
});

describe("subscribe() — group exclusivity (§11.6)", () => {
  it("any other plan in an already-occupied group throws the same error", async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = makeClient(db);

    const first = await client.subscribe({ customerId: "user_group_1", planId: "team-addon" });
    expect(first.status).toBe("active");

    await expect(
      client.subscribe({ customerId: "user_group_1", planId: "team-addon-2" }),
    ).rejects.toMatchObject({
      constructor: PayweaveValidationError,
      message: "customer already has an active plan in group 'addons'",
    });
  });
});

describe("subscribe() — customer upsert + provider-ref linking (§11.1)", () => {
  it("new customer: upserts locally and creates+links a fresh provider customer", async () => {
    const db = await makeDb();
    await db.customers.upsert({ externalId: "user_new_1", email: "new1@example.com" });
    edge = await startEdge([STRIPE_CUSTOMER_ROUTE, STRIPE_CHECKOUT_ROUTE]);
    const client = makeClient(db, "stripe");

    await client.subscribe({ customerId: "user_new_1", planId: "pro" });

    const customer = await db.customers.getByExternalId("user_new_1");
    expect(customer?.providerIds.stripe).toBe("cus_test_1");
    const requests = await edge.requests();
    const customerReqs = requests.filter((r) => r.path === "/v1/customers");
    expect(customerReqs).toHaveLength(1);
    expect(asForm(customerReqs[0]!.rawBody).get("email")).toBe("new1@example.com");
  });

  it("existing customer (already linked): two subscribes create the provider customer exactly once", async () => {
    const db = await makeDb();
    edge = await startEdge([STRIPE_CUSTOMER_ROUTE, STRIPE_CHECKOUT_ROUTE]);
    const client = makeClient(db, "stripe");

    await client.subscribe({ customerId: "user_twice_1", planId: "pro" });
    await client.subscribe({ customerId: "user_twice_1", planId: "pro" });

    const requests = await edge.requests();
    expect(requests.filter((r) => r.path === "/v1/customers")).toHaveLength(1);
    expect(requests.filter((r) => r.path === "/v1/checkout/sessions")).toHaveLength(2);
  });
});

describe("subscribe() — paid plan checkout, Stripe (§11.3)", () => {
  it("creates a checkout session against the pushed price and returns the redirect — no local activation", async () => {
    const db = await makeDb();
    edge = await startEdge([STRIPE_CUSTOMER_ROUTE, STRIPE_CHECKOUT_ROUTE]);
    const client = makeClient(db, "stripe");

    const result = await client.subscribe({
      customerId: "user_stripe_1",
      planId: "pro",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(result).toEqual({
      status: "checkout",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
      reference: "cs_test_1",
    });

    const requests = await edge.requests();
    const checkoutReq = requests.find((r) => r.path === "/v1/checkout/sessions");
    expect(checkoutReq).toBeDefined();
    const form = asForm(checkoutReq!.rawBody);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer")).toBe("cus_test_1");
    expect(form.get("line_items[0][price]")).toBe(STRIPE_PRICE_ID);
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("success_url")).toBe("https://example.com/success");
    expect(form.get("cancel_url")).toBe("https://example.com/cancel");
    expect(form.get("metadata[pwv_plan]")).toBe("pro");

    const customer = await db.customers.getByExternalId("user_stripe_1");
    expect(await db.subscriptions.getActive(customer!.id, "base")).toBeNull();
  });

  it("throws PayweaveProviderError when Stripe returns a session with no hosted URL", async () => {
    const db = await makeDb();
    edge = await startEdge([
      STRIPE_CUSTOMER_ROUTE,
      { method: "post", url: `${STRIPE_BASE_URL}/v1/checkout/sessions`, json: { id: "cs_test_2", url: null } },
    ]);
    const client = makeClient(db, "stripe");

    await expect(client.subscribe({ customerId: "user_stripe_2", planId: "pro" })).rejects.toBeInstanceOf(
      PayweaveProviderError,
    );
  });

  it("throws when the pushed stripe provider ref is missing a priceId", async () => {
    const db = await makeDb({
      proProviderRefs: { stripe: {}, paystack: { planCode: PAYSTACK_PLAN_CODE } },
    });
    edge = await startEdge([]);
    const client = makeClient(db, "stripe");

    await expect(client.subscribe({ customerId: "user_stripe_norefs", planId: "pro" })).rejects.toMatchObject(
      { constructor: PayweaveValidationError, message: expect.stringContaining("stripe price") },
    );
    expect(await edge.requests()).toEqual([]);
  });
});

describe("subscribe() — paid plan checkout, Paystack (§11.3)", () => {
  it("initializes a transaction against the pushed plan code and returns the redirect — no local activation", async () => {
    const db = await makeDb();
    await db.customers.upsert({ externalId: "user_paystack_1", email: "buyer@example.com" });
    edge = await startEdge([PAYSTACK_CUSTOMER_ROUTE, PAYSTACK_INITIALIZE_ROUTE]);
    const client = makeClient(db, "paystack");

    const result = await client.subscribe({ customerId: "user_paystack_1", planId: "pro" });

    expect(result).toEqual({
      status: "checkout",
      checkoutUrl: "https://checkout.paystack.com/abc123",
      reference: "pwv_paystack_ref_1",
    });

    const requests = await edge.requests();
    const initReq = requests.find((r) => r.path === "/transaction/initialize");
    expect(initReq).toBeDefined();
    const body = asJson(initReq!.rawBody);
    expect(body.email).toBe("buyer@example.com");
    expect(body.amount).toBe(1900);
    expect(body.plan).toBe(PAYSTACK_PLAN_CODE);
    expect(typeof body.reference).toBe("string");

    const customer = await db.customers.getByExternalId("user_paystack_1");
    expect(await db.subscriptions.getActive(customer!.id, "base")).toBeNull();
  });

  it("requires a customer email — throws a clear PayweaveValidationError when none is on file", async () => {
    const db = await makeDb();
    edge = await startEdge([PAYSTACK_CUSTOMER_ROUTE]);
    const client = makeClient(db, "paystack");

    await expect(client.subscribe({ customerId: "user_paystack_noemail", planId: "pro" })).rejects.toThrow(
      PayweaveValidationError,
    );
  });

  it("throws PayweaveProviderError when Paystack creates a customer without a customer_code", async () => {
    const db = await makeDb();
    await db.customers.upsert({ externalId: "user_paystack_2", email: "buyer2@example.com" });
    edge = await startEdge([
      { method: "post", url: `${PAYSTACK_BASE_URL}/customer`, json: { status: true, message: "ok", data: {} } },
    ]);
    const client = makeClient(db, "paystack");

    await expect(
      client.subscribe({ customerId: "user_paystack_2", planId: "pro" }),
    ).rejects.toBeInstanceOf(PayweaveProviderError);
  });

  it("throws when the pushed paystack provider ref is missing a planCode", async () => {
    const db = await makeDb({
      proProviderRefs: { stripe: { productId: STRIPE_PRODUCT_ID, priceId: STRIPE_PRICE_ID }, paystack: {} },
    });
    await db.customers.upsert({ externalId: "user_paystack_norefs", email: "norefs@example.com" });
    edge = await startEdge([]);
    const client = makeClient(db, "paystack");

    await expect(
      client.subscribe({ customerId: "user_paystack_norefs", planId: "pro" }),
    ).rejects.toMatchObject({ constructor: PayweaveValidationError, message: expect.stringContaining("plan code") });
    expect(await edge.requests()).toEqual([]);
  });

  it("still requires an email even when the paystack provider customer is already linked", async () => {
    const db = await makeDb();
    await db.customers.upsert({ externalId: "user_paystack_linked_noemail" });
    await db.customers.linkProviderRef("user_paystack_linked_noemail", "paystack", "CUS_prelinked");
    edge = await startEdge([]);
    const client = makeClient(db, "paystack");

    await expect(
      client.subscribe({ customerId: "user_paystack_linked_noemail", planId: "pro" }),
    ).rejects.toMatchObject({ constructor: PayweaveValidationError, message: expect.stringContaining("email") });
    expect(await edge.requests()).toEqual([]);
  });
});

describe("subscribe() — plan/version/provider guards", () => {
  it("unknown plan id throws PayweaveValidationError", async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = makeClient(db);
    await expect(
      client.subscribe({ customerId: "user_x", planId: "does-not-exist" as never }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });

  it('missing pushed version throws containing the "run payweave push" hint', async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = makeClient(db);
    await expect(client.subscribe({ customerId: "user_y", planId: "unpushed" })).rejects.toMatchObject({
      constructor: PayweaveValidationError,
      message: expect.stringContaining("payweave push"),
    });
  });

  it("missing provider refs for the requested provider throws naming that provider", async () => {
    const db = await makeDb({ proProviderRefs: { stripe: { productId: STRIPE_PRODUCT_ID, priceId: STRIPE_PRICE_ID } } });
    edge = await startEdge([]);
    const client = makeClient(db, "paystack");
    await db.customers.upsert({ externalId: "user_z", email: "z@example.com" });

    await expect(client.subscribe({ customerId: "user_z", planId: "pro" })).rejects.toMatchObject({
      constructor: PayweaveValidationError,
      message: expect.stringContaining("paystack"),
    });
  });

  it("provider not configured on this client throws PayweaveConfigError", async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" }, database: db, products });
    await expect(
      client.subscribe({ customerId: "user_w", planId: "pro", provider: "paystack" as never }),
    ).rejects.toBeInstanceOf(PayweaveConfigError);
  });

  it("a configured but non-billing-capable provider (flutterwave) throws PayweaveConfigError", async () => {
    const db = await makeDb();
    edge = await startEdge([]);
    const client = createPayweave({
      flutterwave: { secretKey: "FLWSECK_TEST-abc" },
      defaultProvider: "flutterwave",
      database: db,
      products,
    });
    await expect(client.subscribe({ customerId: "user_v", planId: "pro" })).rejects.toBeInstanceOf(
      PayweaveConfigError,
    );
  });
});

describe("subscribe() — missing database runtime guard (unified-config.md §3)", () => {
  it("throws PayweaveConfigError when no database is configured", async () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" } });
    await expect(
      client.subscribe({ customerId: "user_no_db", planId: "anything" as never }),
    ).rejects.toBeInstanceOf(PayweaveConfigError);
  });
});
