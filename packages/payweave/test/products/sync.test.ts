/**
 * `BillingSync` (plans-and-features.md §12, §13). End-to-end against
 * a REAL in-memory sqlite `DatabaseAdapter` and a REAL `createPayweave`
 * client, with MSW mocking only the network edge (never HttpClient/fetch,
 * AGENTS.md §7). `onUnhandledRequest: "error"` doubles as the zero-write proof
 * throughout: an empty (or narrowly-scoped) route set means ANY unexpected
 * provider call fails the test outright.
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import type { SetupServer } from "msw/node";
import { createPayweave } from "../../src/index";
import { PayweaveConfigError, PayweaveProviderError } from "../../src/core/errors";
import { STRIPE_BASE_URL, PAYSTACK_BASE_URL, type ResolvedProduct } from "../../src/core/config";
import { createHandlers, type MockRoute } from "../../src/testing/msw";
import { feature } from "../../src/products/feature";
import { plan, type Plan } from "../../src/products/plan";
import { pushPlanToProvider } from "../../src/products/sync";
import type { BillingContext } from "../../src/products/subscribe";
import { sqliteAdapter } from "../../src/db/sqlite";
import type { DatabaseAdapter } from "../../src/db/index";

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
const proPlanRepriced = plan({
  id: "pro",
  name: "Pro",
  group: "base",
  price: { amount: 29, currency: "USD", interval: "month" },
  includes: [messages({ limit: 2_000, reset: "month" })],
});
const ultraPlan = plan({
  id: "ultra",
  name: "Ultra",
  group: "base",
  price: { amount: 49, currency: "USD", interval: "month" },
  includes: [messages({ limit: 10_000, reset: "month" })],
});

const products = [freePlan, proPlan];
const productsWithUltra = [freePlan, proPlan, ultraPlan];
const productsRepriced = [freePlan, proPlanRepriced, ultraPlan];

// ── DB ───────────────────────────────────────────────────────────────────────

async function makeDb(): Promise<DatabaseAdapter> {
  const db = sqliteAdapter({ url: ":memory:" });
  await db.migrations.apply();
  return db;
}

function makeClient(db: DatabaseAdapter, plans: readonly Plan[] = products) {
  return createPayweave({
    stripe: { secretKey: "sk_test_stripe" },
    paystack: { secretKey: "sk_test_paystack" },
    defaultProvider: "stripe",
    database: db,
    products: plans,
  });
}

// ── MSW edge ─────────────────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  host: string;
  path: string;
  search: string;
  rawBody: string;
}

interface Edge {
  server: SetupServer;
  requests: () => Promise<CapturedRequest[]>;
  close: () => void;
}

async function startEdge(routes: MockRoute[], extra: RequestHandler[] = []): Promise<Edge> {
  const handlers = await createHandlers(routes);
  const server = setupServer(...handlers, ...extra);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

  async function parse(req: Request): Promise<CapturedRequest> {
    const url = new URL(req.url);
    return {
      method: req.method,
      host: url.host,
      path: url.pathname,
      search: url.search,
      rawBody: await req.text(),
    };
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

let edge: Edge | undefined;
afterEach(() => {
  edge?.close();
  edge = undefined;
});

// ── Fixed provider ids used across the "single paid plan" tests ────────────

const PROD_ID = "prod_sync_pro";
const PRICE_ID_V1 = "price_sync_pro_v1";
const PLAN_CODE_V1 = "PLN_sync_pro_v1";

const STRIPE_PRODUCT_SEARCH_EMPTY: MockRoute = {
  method: "get",
  url: `${STRIPE_BASE_URL}/v1/products/search`,
  json: { object: "search_result", data: [], has_more: false },
};
const STRIPE_PRICE_SEARCH_EMPTY: MockRoute = {
  method: "get",
  url: `${STRIPE_BASE_URL}/v1/prices/search`,
  json: { object: "search_result", data: [], has_more: false },
};
const STRIPE_PRODUCT_CREATE_V1: MockRoute = {
  method: "post",
  url: `${STRIPE_BASE_URL}/v1/products`,
  json: { id: PROD_ID, object: "product" },
};
const STRIPE_PRICE_CREATE_V1: MockRoute = {
  method: "post",
  url: `${STRIPE_BASE_URL}/v1/prices`,
  json: { id: PRICE_ID_V1, object: "price" },
};
const PAYSTACK_LIST_EMPTY: MockRoute = {
  method: "get",
  url: `${PAYSTACK_BASE_URL}/plan`,
  json: { status: true, message: "ok", data: [] },
};
const PAYSTACK_CREATE_V1: MockRoute = {
  method: "post",
  url: `${PAYSTACK_BASE_URL}/plan`,
  json: { status: true, message: "plan created", data: { id: 1, plan_code: PLAN_CODE_V1 } },
};

const FIRST_PUSH_ROUTES = [
  STRIPE_PRODUCT_SEARCH_EMPTY,
  STRIPE_PRICE_SEARCH_EMPTY,
  STRIPE_PRODUCT_CREATE_V1,
  STRIPE_PRICE_CREATE_V1,
  PAYSTACK_LIST_EMPTY,
  PAYSTACK_CREATE_V1,
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sync() — first push (§12)", () => {
  it("creates Stripe Product+Price and a Paystack Plan; writes provider_refs back to pw_plans", async () => {
    const db = await makeDb();
    edge = await startEdge(FIRST_PUSH_ROUTES);
    const client = makeClient(db);

    const result = await client.sync();

    const pro = result.plans.find((p) => p.planId === "pro");
    expect(pro).toMatchObject({
      version: 1,
      versionChanged: true,
      providers: { stripe: "created", paystack: "created" },
    });

    const free = result.plans.find((p) => p.planId === "free");
    expect(free).toMatchObject({ version: 1, versionChanged: true, providers: {} });

    const requests = await edge.requests();
    expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/products")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/prices")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/plan")).toHaveLength(1);

    const priceCreateReq = requests.find((r) => r.method === "POST" && r.path === "/v1/prices")!;
    const priceForm = asForm(priceCreateReq.rawBody);
    expect(priceForm.get("unit_amount")).toBe("1900");
    expect(priceForm.get("currency")).toBe("usd");
    expect(priceForm.get("recurring[interval]")).toBe("month");
    expect(priceForm.get("product")).toBe(PROD_ID);
    expect(priceForm.get("metadata[pwv_plan]")).toBe("pro");
    expect(typeof priceForm.get("metadata[pwv_hash]")).toBe("string");

    const planCreateReq = requests.find((r) => r.method === "POST" && r.path === "/plan")!;
    const planBody = asJson(planCreateReq.rawBody);
    expect(planBody.amount).toBe(1900);
    expect(planBody.interval).toBe("monthly");
    expect(planBody.currency).toBe("USD");
    expect(typeof planBody.description).toBe("string");
    expect(JSON.parse(planBody.description as string)).toMatchObject({ pwv_plan: "pro" });

    const pushedPro = await db.plans.getActiveVersion("pro");
    expect(pushedPro?.providerRefs.stripe).toMatchObject({ productId: PROD_ID, priceId: PRICE_ID_V1 });
    expect(pushedPro?.providerRefs.paystack).toMatchObject({ planCode: PLAN_CODE_V1 });

    // Free/default plan: DB only, zero provider objects.
    const pushedFree = await db.plans.getActiveVersion("free");
    expect(pushedFree?.providerRefs).toEqual({});
  });
});

describe("sync() — double-push zero-write (§13 acceptance criterion)", () => {
  it("a second sync of unchanged content makes ZERO provider create/update calls", async () => {
    const db = await makeDb();
    edge = await startEdge(FIRST_PUSH_ROUTES);
    const client = makeClient(db);
    await client.sync();
    edge.close();

    // Zero routes registered — any HTTP call at all fails the test.
    edge = await startEdge([]);
    const second = await client.sync();

    const pro = second.plans.find((p) => p.planId === "pro");
    expect(pro).toMatchObject({
      versionChanged: false,
      providers: { stripe: "unchanged", paystack: "unchanged" },
    });
    expect(await edge.requests()).toEqual([]);
  });
});

describe("sync() — content change re-pushes only the changed plan (§12, §13)", () => {
  it("re-prices one plan among several: only that plan's Stripe Price rotates + Paystack plan is recreated", async () => {
    const db = await makeDb();

    // Dynamic handlers distinguish "pro" vs "ultra" by request content, since
    // both plans legitimately POST to the exact same endpoint.
    const productIds: Record<string, string> = { Pro: "prod_pro", Ultra: "prod_ultra" };
    const priceIds: Record<string, string> = { prod_pro: "price_pro_v1", prod_ultra: "price_ultra_v1" };
    const planCodes: Record<string, string> = { Pro: "PLN_pro_v1", Ultra: "PLN_ultra_v1" };

    const dynamicHandlers: RequestHandler[] = [
      http.post(`${STRIPE_BASE_URL}/v1/products`, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        const name = body.get("name") ?? "";
        return HttpResponse.json({ id: productIds[name], object: "product" });
      }),
      http.post(`${STRIPE_BASE_URL}/v1/prices`, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        const product = body.get("product") ?? "";
        return HttpResponse.json({ id: priceIds[product], object: "price" });
      }),
      http.post(`${PAYSTACK_BASE_URL}/plan`, async ({ request }) => {
        const body = JSON.parse(await request.text()) as { name?: string };
        const code = planCodes[body.name ?? ""];
        return HttpResponse.json({ status: true, message: "created", data: { id: 1, plan_code: code } });
      }),
    ];

    edge = await startEdge([STRIPE_PRODUCT_SEARCH_EMPTY, STRIPE_PRICE_SEARCH_EMPTY, PAYSTACK_LIST_EMPTY], dynamicHandlers);
    const first = makeClient(db, productsWithUltra);
    await first.sync();
    edge.close();

    // Second run: ONLY "pro"'s price changed (19 -> 29); "ultra" is the exact
    // same object/content as before. Routes registered ONLY for pro's price
    // rotation + paystack recreation — if ultra (or pro's product) is touched
    // at all, `onUnhandledRequest: "error"` fails the test.
    const STRIPE_PRICE_ARCHIVE_PRO: MockRoute = {
      method: "post",
      url: `${STRIPE_BASE_URL}/v1/prices/price_pro_v1`,
      json: { id: "price_pro_v1", object: "price", active: false },
    };
    const priceCreateV2: RequestHandler = http.post(`${STRIPE_BASE_URL}/v1/prices`, () =>
      HttpResponse.json({ id: "price_pro_v2", object: "price" }),
    );
    const planCreateV2: RequestHandler = http.post(`${PAYSTACK_BASE_URL}/plan`, () =>
      HttpResponse.json({ status: true, message: "created", data: { id: 2, plan_code: "PLN_pro_v2" } }),
    );

    edge = await startEdge([STRIPE_PRICE_SEARCH_EMPTY, STRIPE_PRICE_ARCHIVE_PRO, PAYSTACK_LIST_EMPTY], [
      priceCreateV2,
      planCreateV2,
    ]);
    const second = makeClient(db, productsRepriced);
    const result = await second.sync();

    const pro = result.plans.find((p) => p.planId === "pro");
    expect(pro?.versionChanged).toBe(true);
    expect(pro?.providers).toMatchObject({ stripe: "created", paystack: "created" });

    const ultra = result.plans.find((p) => p.planId === "ultra");
    expect(ultra?.versionChanged).toBe(false);
    expect(ultra?.providers).toMatchObject({ stripe: "unchanged", paystack: "unchanged" });

    const requests = await edge.requests();
    // No product create/update call at all — only the price rotated.
    expect(requests.filter((r) => r.path === "/v1/products")).toHaveLength(0);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/prices")).toHaveLength(1);
    expect(requests.filter((r) => r.path === "/v1/prices/price_pro_v1")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/plan")).toHaveLength(1);

    const pushedPro = await db.plans.getActiveVersion("pro");
    expect(pushedPro?.providerRefs.stripe).toMatchObject({ productId: "prod_pro", priceId: "price_pro_v2" });
    expect(pushedPro?.priceMinor).toBe(2900);
  });
});

describe("sync() — Stripe Product/Price are diffed independently (§12)", () => {
  it("a display-name-only change refreshes the Product in place — zero Price calls", async () => {
    const db = await makeDb();
    edge = await startEdge(FIRST_PUSH_ROUTES);
    await makeClient(db).sync();
    edge.close();

    const proRenamed = plan({
      id: "pro",
      name: "Pro Plan",
      group: "base",
      price: { amount: 19, currency: "USD", interval: "month" },
      includes: [messages({ limit: 2_000, reset: "month" })],
    });

    const STRIPE_PRODUCT_UPDATE: MockRoute = {
      method: "post",
      url: `${STRIPE_BASE_URL}/v1/products/${PROD_ID}`,
      json: { id: PROD_ID, object: "product", name: "Pro Plan" },
    };
    // Paystack has no Product/Price split (module doc comment) — its `name`
    // is baked into the ONE Plan object's hash, so this same rename DOES
    // require a new Paystack plan even though Stripe's Price needs no touch.
    // No Stripe PRICE search/create/update route is registered at all — if
    // the engine ever touched the price for a name-only change,
    // `onUnhandledRequest: "error"` would fail the test.
    edge = await startEdge([STRIPE_PRODUCT_UPDATE, PAYSTACK_LIST_EMPTY, PAYSTACK_CREATE_V1]);
    const client = makeClient(db, [freePlan, proRenamed]);
    const result = await client.sync();

    const pro = result.plans.find((p) => p.planId === "pro");
    expect(pro?.providers.stripe).toBe("unchanged"); // no NEW/adopted object — just a metadata refresh.
    expect(pro?.providers.paystack).toBe("created");

    const requests = await edge.requests();
    expect(requests.filter((r) => r.path === "/v1/prices" || r.path.startsWith("/v1/prices/"))).toHaveLength(0);
    const productUpdateReq = requests.find((r) => r.path === `/v1/products/${PROD_ID}`);
    expect(productUpdateReq).toBeDefined();
    expect(asForm(productUpdateReq!.rawBody).get("name")).toBe("Pro Plan");

    const pushedPro = await db.plans.getActiveVersion("pro");
    expect(pushedPro?.providerRefs.stripe).toMatchObject({ productId: PROD_ID, priceId: PRICE_ID_V1 });
    expect(pushedPro?.name).toBe("Pro Plan");
  });
});

describe("sync() — Paystack adoption scan + defensive errors (§12)", () => {
  it("skips non-tagged plans while scanning for an adoptable match", async () => {
    const db = await makeDb();
    edge = await startEdge([
      STRIPE_PRODUCT_SEARCH_EMPTY,
      STRIPE_PRICE_SEARCH_EMPTY,
      STRIPE_PRODUCT_CREATE_V1,
      STRIPE_PRICE_CREATE_V1,
      {
        method: "get",
        url: `${PAYSTACK_BASE_URL}/plan`,
        json: {
          status: true,
          message: "ok",
          // An ordinary, human-created plan with a non-JSON description sits
          // ahead of the genuinely adoptable (untagged-until-now) one — the
          // scan must skip it rather than mistake it for a match.
          data: [
            { id: 9, plan_code: "PLN_human", description: "Legacy plan, do not touch" },
            { id: 10, plan_code: "PLN_untagged", description: null },
          ],
        },
      },
      PAYSTACK_CREATE_V1,
    ]);
    const client = makeClient(db);
    const result = await client.sync();

    const pro = result.plans.find((p) => p.planId === "pro");
    expect(pro?.providers.paystack).toBe("created");
    const requests = await edge.requests();
    expect(requests.filter((r) => r.method === "POST" && r.path === "/plan")).toHaveLength(1);
  });

  it("throws PayweaveProviderError when Paystack creates a plan without a plan_code", async () => {
    const db = await makeDb();
    edge = await startEdge([
      STRIPE_PRODUCT_SEARCH_EMPTY,
      STRIPE_PRICE_SEARCH_EMPTY,
      STRIPE_PRODUCT_CREATE_V1,
      STRIPE_PRICE_CREATE_V1,
      PAYSTACK_LIST_EMPTY,
      { method: "post", url: `${PAYSTACK_BASE_URL}/plan`, json: { status: true, message: "created", data: {} } },
    ]);
    const client = makeClient(db);

    await expect(client.sync()).rejects.toBeInstanceOf(PayweaveProviderError);
  });
});

describe("sync() — crash-resume adoption (§12)", () => {
  it("adopts an existing pwv_-tagged Stripe Product/Price and Paystack Plan instead of duplicating", async () => {
    // Step 1: a real first push, purely to learn the exact content hashes the
    // engine computes for `proPlan` — Stripe's Price-only hash and Paystack's
    // combined name+price hash are DIFFERENT values by design (module doc
    // comment); this test asserts BEHAVIOR against those real values rather
    // than reimplementing the hash functions.
    const seedDb = await makeDb();
    edge = await startEdge(FIRST_PUSH_ROUTES);
    await makeClient(seedDb).sync();
    const seedRequests = await edge.requests();
    edge.close();
    const priceCreateReq = seedRequests.find((r) => r.method === "POST" && r.path === "/v1/prices")!;
    const stripeHash = asForm(priceCreateReq.rawBody).get("metadata[pwv_hash]")!;
    expect(stripeHash).toBeTruthy();
    const planCreateReq = seedRequests.find((r) => r.method === "POST" && r.path === "/plan")!;
    const paystackHash = (JSON.parse(asJson(planCreateReq.rawBody).description as string) as { pwv_hash: string })
      .pwv_hash;
    expect(paystackHash).toBeTruthy();

    // Step 2: a FRESH db with NO pw_plans row at all (the exact
    // crash-between-provider-create-and-pushVersion gap) — but the provider
    // already has objects tagged for this plan + hash from an earlier,
    // interrupted run.
    const db = await makeDb();
    edge = await startEdge([
      {
        method: "get",
        url: `${STRIPE_BASE_URL}/v1/products/search`,
        json: {
          object: "search_result",
          data: [{ id: "prod_adopted", object: "product", metadata: { pwv_plan: "pro" } }],
          has_more: false,
        },
      },
      {
        method: "get",
        url: `${STRIPE_BASE_URL}/v1/prices/search`,
        json: {
          object: "search_result",
          data: [{ id: "price_adopted", object: "price", metadata: { pwv_plan: "pro", pwv_hash: stripeHash } }],
          has_more: false,
        },
      },
      {
        method: "get",
        url: `${PAYSTACK_BASE_URL}/plan`,
        json: {
          status: true,
          message: "ok",
          data: [
            {
              id: 1,
              plan_code: "PLN_adopted",
              description: JSON.stringify({ pwv_plan: "pro", pwv_hash: paystackHash }),
            },
          ],
        },
      },
      // No create/update routes registered — a create call fails the test.
    ]);
    const client = makeClient(db);
    const result = await client.sync();

    const pro = result.plans.find((p) => p.planId === "pro");
    expect(pro?.providers).toMatchObject({ stripe: "adopted", paystack: "adopted" });

    const requests = await edge.requests();
    expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/products")).toHaveLength(0);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/prices")).toHaveLength(0);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/plan")).toHaveLength(0);

    const pushedPro = await db.plans.getActiveVersion("pro");
    expect(pushedPro?.providerRefs.stripe).toMatchObject({ productId: "prod_adopted", priceId: "price_adopted" });
    expect(pushedPro?.providerRefs.paystack).toMatchObject({ planCode: "PLN_adopted" });
  });
});

describe("sync() — runtime guards (unified-config.md §3 pattern)", () => {
  it("throws PayweaveConfigError when database is not configured", async () => {
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" } });
    await expect(client.sync()).rejects.toBeInstanceOf(PayweaveConfigError);
  });

  it("throws PayweaveConfigError when products is not configured (database alone isn't enough)", async () => {
    const db = await makeDb();
    const client = createPayweave({ stripe: { secretKey: "sk_test_stripe" }, database: db });
    await expect(client.sync()).rejects.toBeInstanceOf(PayweaveConfigError);
  });
});

describe("sync() — Flutterwave (plans-and-features.md §12 ⚠️ — verified, deferred)", () => {
  it("pushPlanToProvider throws a typed, documented PayweaveConfigError for flutterwave", async () => {
    const ctx: BillingContext = {
      database: undefined,
      products: undefined,
      providers: ["flutterwave"],
      defaultProvider: "flutterwave",
      stripe: undefined,
      paystack: undefined,
    };

    // `pushPlanToProvider` takes an already-RESOLVED product (minor units, §9)
    // — hand-built here since this test bypasses `createPayweave`'s config
    // resolution entirely to exercise the dispatch function in isolation.
    const resolvedPro: ResolvedProduct = {
      id: "pro",
      name: "Pro",
      group: "base",
      default: false,
      price: { amount: 1900, currency: "USD", interval: "month" },
      includes: [],
    };

    await expect(pushPlanToProvider(ctx, "flutterwave", resolvedPro, null)).rejects.toMatchObject({
      constructor: PayweaveConfigError,
      message: expect.stringContaining("flutterwave"),
    });
  });

  it("sync() skips a configured flutterwave key without erroring — reported via skippedProviders", async () => {
    const db = await makeDb();
    // No flutterwave routes registered at all — if the engine ever attempted
    // one, `onUnhandledRequest: "error"` would fail the test.
    edge = await startEdge(FIRST_PUSH_ROUTES);
    const client = createPayweave({
      stripe: { secretKey: "sk_test_stripe" },
      paystack: { secretKey: "sk_test_paystack" },
      flutterwave: { secretKey: "FLWSECK_TEST-flw_test_secret" },
      defaultProvider: "stripe",
      database: db,
      products,
    });

    const result = await client.sync();

    expect(result.skippedProviders).toEqual(["flutterwave"]);
    const pro = result.plans.find((p) => p.planId === "pro");
    expect(pro?.providers).toMatchObject({ stripe: "created", paystack: "created" });
    // `providers`' type is `Partial<Record<BillingCapableProvider, ...>>` — it
    // structurally cannot carry a "flutterwave" key at all (proven at compile
    // time); `skippedProviders` above is the runtime proof it was excluded.
  });
});
