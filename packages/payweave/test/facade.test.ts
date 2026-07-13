/**
 * Legacy facade behavior (TDD §7.1) — since PW-504 the three factories are
 * deprecation aliases that DELEGATE to `createPayweave` (unified-config.md §6).
 * This suite pins (a) the preserved legacy surface (instanceof, `provider` /
 * `environment` / `version` props, `paystack.*` / `flutterwave.*`, `unified.*`,
 * `webhooks.*`) and (b) §9 criterion 5: alias-built and `createPayweave`-built
 * clients produce IDENTICAL wire traffic (asserted via MSW at the network
 * edge) and identical webhook verdicts (via `signWebhook` vectors).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SetupServer } from "msw/node";
import {
  createPaystack,
  createFlutterwave,
  createPayweave,
  PaymentSDK,
  PaystackSDK,
  FlutterwaveV3SDK,
  FlutterwaveV4SDK,
} from "../src/index";
import {
  PayweaveError,
  PayweaveConfigError,
  PayweaveWebhookVerificationError,
} from "../src/core/errors";
import { FLW_V4_TOKEN_URL } from "../src/core/config";
import { createMswServer, type MockRoute } from "../src/testing/msw";
import { loadFixture } from "../src/testing/fixtures";
import { signWebhook } from "../src/testing/sign-webhook";

describe("createPaystack", () => {
  const sk = "sk_test_facade";
  const sdk = createPaystack({ secretKey: sk });

  it("exposes provider/environment and the paystack namespace", () => {
    expect(sdk).toBeInstanceOf(PaystackSDK);
    expect(sdk.provider).toBe("paystack");
    expect(sdk.environment).toBe("test");
    expect(sdk.paystack).toBeDefined();
  });

  it("exposes the delegated client root on the wrapper (PW-504 additions)", () => {
    // Delegation is additive: the wrapper carries the full PayweaveClient
    // surface on top of the legacy props.
    expect(sdk.providers).toEqual(["paystack"]);
    expect(sdk.defaultProvider).toBe("paystack");
    expect(typeof sdk.checkout.create).toBe("function");
    expect(typeof sdk.verify).toBe("function");
    expect(typeof sdk.banks.list).toBe("function");
  });

  it("verifies a Paystack webhook using the secret key", () => {
    const signed = signWebhook("paystack", { event: "charge.success" }, sk);
    expect(
      sdk.webhooks.verify({
        rawBody: signed.body,
        headers: { [signed.headerName]: signed.header },
      }),
    ).toBe(true);
    expect(
      sdk.webhooks.verify({ rawBody: signed.body + "x", headers: { [signed.headerName]: signed.header } }),
    ).toBe(false);
  });

  it("fails closed on an unverifiable constructEvent", () => {
    expect(() => sdk.webhooks.constructEvent({ rawBody: "{}", headers: {} })).toThrow(PayweaveError);
  });

  it("exposes the unified (Surface B) namespace as callable ops", () => {
    // PW-304: the unified stubs are now real. Shape check only here — routing +
    // normalization are covered by test/unified/*. (No network call is made.)
    expect(typeof sdk.unified.checkout.create).toBe("function");
    expect(typeof sdk.unified.verify).toBe("function");
    expect(typeof sdk.unified.refunds.create).toBe("function");
    expect(typeof sdk.unified.transfers.create).toBe("function");
    expect(typeof sdk.unified.banks.list).toBe("function");
    expect(typeof sdk.unified.banks.resolveAccount).toBe("function");
  });

  it("`sdk.unified` is the delegated client's alias for the SAME root functions", () => {
    // PW-502 §3: alias and root share function references — delegation keeps that.
    expect(sdk.unified.checkout).toBe(sdk.checkout);
    expect(sdk.unified.verify).toBe(sdk.verify);
    expect(sdk.unified.banks).toBe(sdk.banks);
  });
});

describe("createFlutterwave", () => {
  it("defaults to v3 and requires webhookSecret to verify", () => {
    const sdk = createFlutterwave({ secretKey: "FLWSECK_TEST-x" });
    expect(sdk).toBeInstanceOf(FlutterwaveV3SDK);
    expect(sdk.version).toBe("v3");
    expect(sdk.flutterwave.version).toBe("v3");
    // No webhookSecret configured → fail closed with a config error once the
    // v3 signature header arrives. (Since PW-504 the alias's webhooks are the
    // PW-503 dispatch, so header DETECTION runs first: the missing-secret
    // check needs the provider's own header present to be reached.)
    expect(() =>
      sdk.webhooks.verify({ rawBody: "{}", headers: { "verif-hash": "hash" } }),
    ).toThrow(PayweaveConfigError);
    // A request with NO known signature header is a structural rejection (§5).
    expect(() => sdk.webhooks.verify({ rawBody: "{}", headers: {} })).toThrow(
      PayweaveWebhookVerificationError,
    );
  });

  it("verifies a v3 webhook when webhookSecret is set", () => {
    const sdk = createFlutterwave({ secretKey: "FLWSECK_TEST-x", webhookSecret: "hash" });
    const signed = signWebhook("flutterwave", { event: "charge.completed" }, "hash");
    expect(
      sdk.webhooks.verify({ rawBody: signed.body, headers: { "verif-hash": signed.header } }),
    ).toBe(true);
  });

  it("narrows to the v4 surface with version: v4", () => {
    const sdk = createFlutterwave({ version: "v4", clientId: "a", clientSecret: "b" });
    expect(sdk).toBeInstanceOf(FlutterwaveV4SDK);
    expect(sdk.version).toBe("v4");
    expect(sdk.provider).toBe("flutterwave");
    // v4 environment is explicit with a "test" default (PRD §6.1).
    expect(sdk.environment).toBe("test");
    expect(sdk.flutterwave.version).toBe("v4");
  });
});

describe("PaymentSDK factory", () => {
  it("works called or new'd and returns the narrowed instance", () => {
    const called = PaymentSDK({ provider: "paystack", secretKey: "sk_test_x" });
    const constructed = new PaymentSDK({ provider: "paystack", secretKey: "sk_test_x" });
    expect(called).toBeInstanceOf(PaystackSDK);
    expect(constructed).toBeInstanceOf(PaystackSDK);
    expect(called.provider).toBe("paystack");
    expect(constructed.provider).toBe("paystack");
  });

  it("dispatches Flutterwave version", () => {
    expect(PaymentSDK({ provider: "flutterwave", secretKey: "FLWSECK-x" })).toBeInstanceOf(
      FlutterwaveV3SDK,
    );
    expect(
      PaymentSDK({ provider: "flutterwave", version: "v4", clientId: "a", clientSecret: "b" }),
    ).toBeInstanceOf(FlutterwaveV4SDK);
  });

  it("surfaces the same config errors as createPayweave (delegated resolution)", () => {
    expect(() => PaymentSDK({ provider: "paystack", secretKey: "sk_bogus" })).toThrow(
      PayweaveConfigError,
    );
    expect(() => createPaystack({ secretKey: "sk_bogus" })).toThrow(PayweaveConfigError);
    expect(() => createPayweave({ paystack: { secretKey: "sk_bogus" } })).toThrow(
      PayweaveConfigError,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Behavioral equivalence (PW-504, unified-config.md §9 criterion 5): the SAME
// operation issued through an alias-built SDK and a createPayweave-built client
// produces IDENTICAL wire traffic — method, host, path, query, body, and the
// meaningful headers — captured at the network edge with MSW.
// ═════════════════════════════════════════════════════════════════════════════

/** The headers that identify a request (auth + encoding + UA); volatile ones excluded. */
const COMPARED_HEADERS = ["authorization", "content-type", "user-agent"] as const;

/** A captured outgoing request, reduced to its comparable identity. */
interface CapturedRequest {
  method: string;
  host: string;
  path: string;
  search: string;
  body: unknown;
  headers: Record<string, string | null>;
}

interface EdgeHarness {
  server: SetupServer;
  requests: () => Promise<CapturedRequest[]>;
  close: () => void;
}

/**
 * Start MSW BEFORE the client is constructed — HttpClient (and the v4 OAuth
 * strategy) capture the global fetch at construction time and MSW patches it
 * on `listen()` (same ordering rule as the unified/_harness).
 */
async function startEdge(routes: MockRoute[]): Promise<EdgeHarness> {
  const server = await createMswServer(routes);
  const raw: Request[] = [];
  server.events.on("request:start", ({ request }) => {
    raw.push(request.clone());
  });
  server.listen({ onUnhandledRequest: "error" });

  async function parse(req: Request): Promise<CapturedRequest> {
    const url = new URL(req.url);
    let body: unknown;
    const text = await req.text();
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const headers: Record<string, string | null> = {};
    for (const name of COMPARED_HEADERS) headers[name] = req.headers.get(name);
    return { method: req.method, host: url.host, path: url.pathname, search: url.search, body, headers };
  }

  return {
    server,
    requests: () => Promise.all(raw.map(parse)),
    close: () => server.close(),
  };
}

let edge: EdgeHarness | undefined;
afterEach(() => {
  edge?.close();
  edge = undefined;
});

/** Run `op` against a fresh MSW edge and return the captured request sequence. */
async function captureSequence(
  routes: MockRoute[],
  op: () => Promise<unknown>,
): Promise<CapturedRequest[]> {
  edge = await startEdge(routes);
  try {
    await op();
    return await edge.requests();
  } finally {
    edge.close();
    edge = undefined;
  }
}

describe("PW-504 behavioral equivalence — alias vs createPayweave (§9 criterion 5)", () => {
  it("paystack Surface A op: identical request through old and new construction", async () => {
    const routes: MockRoute[] = [
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ];
    const input = { email: "buyer@example.com", amount: 500000 };

    const viaAlias = await captureSequence(routes, async () => {
      const sdk = createPaystack({ secretKey: "sk_test_equiv", maxRetries: 0 });
      await sdk.paystack.transactions.initialize(input);
    });
    const viaKeyed = await captureSequence(routes, async () => {
      const client = createPayweave({ paystack: { secretKey: "sk_test_equiv", maxRetries: 0 } });
      await client.paystack.transactions.initialize(input);
    });

    expect(viaAlias).toEqual(viaKeyed);
    expect(viaAlias).toHaveLength(1);
    expect(viaAlias[0]?.method).toBe("POST");
    expect(viaAlias[0]?.path).toBe("/transaction/initialize");
    expect(viaAlias[0]?.headers.authorization).toBe("Bearer sk_test_equiv");
  });

  it("flutterwave v3 Surface A op: identical request through old and new construction", async () => {
    const routes: MockRoute[] = [
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/payments",
        json: loadFixture("flutterwave", "payments", "create.success"),
      },
    ];
    const input = {
      tx_ref: "pwv_equiv_001",
      amount: 5000,
      currency: "NGN",
      redirect_url: "https://example.com/cb",
      customer: { email: "buyer@example.com" },
    };

    const viaAlias = await captureSequence(routes, async () => {
      const sdk = createFlutterwave({ secretKey: "FLWSECK_TEST-equiv", maxRetries: 0 });
      await sdk.flutterwave.payments.create(input);
    });
    const viaKeyed = await captureSequence(routes, async () => {
      const client = createPayweave({
        flutterwave: { secretKey: "FLWSECK_TEST-equiv", maxRetries: 0 },
      });
      await client.flutterwave.payments.create(input);
    });

    expect(viaAlias).toEqual(viaKeyed);
    expect(viaAlias).toHaveLength(1);
    expect(viaAlias[0]?.host).toBe("api.flutterwave.com");
    expect(viaAlias[0]?.path).toBe("/v3/payments");
    expect(viaAlias[0]?.headers.authorization).toBe("Bearer FLWSECK_TEST-equiv");
  });

  it("flutterwave v4 op: identical OAuth token exchange + API request sequence", async () => {
    const routes: MockRoute[] = [
      {
        method: "post",
        url: FLW_V4_TOKEN_URL,
        json: { access_token: "tok_equiv", expires_in: 3600 },
      },
      {
        method: "get",
        url: "https://api.flutterwave.cloud/developersandbox/banks/NG",
        json: loadFixture("flutterwave", "banks", "list.success"),
      },
    ];
    const v4Config = { version: "v4", clientId: "cid_equiv", clientSecret: "cs_equiv", maxRetries: 0 } as const;

    const viaAlias = await captureSequence(routes, async () => {
      const sdk = createFlutterwave(v4Config);
      await sdk.unified.banks.list({ country: "NG" });
    });
    const viaKeyed = await captureSequence(routes, async () => {
      const client = createPayweave({ flutterwave: v4Config });
      await client.banks.list({ country: "NG" });
    });

    expect(viaAlias).toEqual(viaKeyed);
    expect(viaAlias).toHaveLength(2);
    // 1) client-credentials grant against the v4 IdP…
    expect(viaAlias[0]?.method).toBe("POST");
    expect(viaAlias[0]?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(viaAlias[0]?.body).toContain("grant_type=client_credentials");
    // 2) …then the API call on the sandbox host with the fetched bearer token.
    expect(viaAlias[1]?.host).toBe("api.flutterwave.cloud");
    expect(viaAlias[1]?.path).toBe("/developersandbox/banks/NG");
    expect(viaAlias[1]?.headers.authorization).toBe("Bearer tok_equiv");
  });

  it("unified op: sdk.unified.checkout.create matches client-root checkout.create", async () => {
    const routes: MockRoute[] = [
      {
        method: "post",
        url: "https://api.paystack.co/transaction/initialize",
        json: loadFixture("paystack", "transactions", "initialize.success"),
      },
    ];
    const input = {
      amount: { value: 500000, currency: "NGN" },
      customer: { email: "ada@example.com" },
      reference: "order_equiv_1",
    };

    const viaAlias = await captureSequence(routes, async () => {
      const sdk = createPaystack({ secretKey: "sk_test_equiv", maxRetries: 0 });
      await sdk.unified.checkout.create(input);
    });
    const viaKeyed = await captureSequence(routes, async () => {
      const client = createPayweave({ paystack: { secretKey: "sk_test_equiv", maxRetries: 0 } });
      await client.checkout.create(input);
    });

    expect(viaAlias).toEqual(viaKeyed);
    expect(viaAlias).toHaveLength(1);
    expect((viaAlias[0]?.body as Record<string, unknown>).amount).toBe(500000);
    expect((viaAlias[0]?.body as Record<string, unknown>).reference).toBe("order_equiv_1");
  });

  it("webhook verify: identical verdicts and events for the same signWebhook vector", () => {
    const secret = "sk_test_hook_equiv";
    const sdk = createPaystack({ secretKey: secret });
    const client = createPayweave({ paystack: { secretKey: secret } });
    const signed = signWebhook(
      "paystack",
      { event: "charge.success", data: { id: 41, status: "success" } },
      secret,
    );

    expect(sdk.webhooks.verify({ rawBody: signed.body, headers: signed.headers })).toBe(true);
    expect(client.webhooks.verify({ rawBody: signed.body, headers: signed.headers })).toBe(true);
    expect(sdk.webhooks.verify({ rawBody: signed.body + "x", headers: signed.headers })).toBe(false);
    expect(client.webhooks.verify({ rawBody: signed.body + "x", headers: signed.headers })).toBe(
      false,
    );
    // The normalized events are identical too (same verify→parse→normalize pipeline).
    // `apply` (PW-805) is excluded from the deep-equality check on purpose:
    // it's a fresh closure per `constructEvent` call, so two calls never
    // share a function reference even when everything else matches — both
    // are still asserted present/callable.
    const { apply: sdkApply, ...sdkEvent } = sdk.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    const { apply: clientApply, ...clientEvent } = client.webhooks.constructEvent({
      rawBody: signed.body,
      headers: signed.headers,
    });
    expect(sdkEvent).toEqual(clientEvent);
    expect(typeof sdkApply).toBe("function");
    expect(typeof clientApply).toBe("function");
  });
});
