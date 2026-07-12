import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HttpClient,
  bearer,
  oauthClientCredentials,
  type AuthStrategy,
  type FetchLike,
} from "../../src/core/http";
import {
  PayweaveAuthError,
  PayweaveNetworkError,
  PayweaveNotFoundError,
  PayweaveProviderError,
} from "../../src/core/errors";
import type { SdkLogEvent } from "../../src/core/logger";
import { jsonResponse, queuedFetch } from "../helpers";

function makeClient(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): HttpClient {
  return new HttpClient({
    baseUrl: "https://api.test/v3",
    auth: bearer("sk_test_secret"),
    provider: "paystack",
    fetch: fetchImpl,
    timeoutMs: 1_000_000,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpClient — happy paths", () => {
  it("performs a GET and returns parsed JSON", async () => {
    const f = queuedFetch([jsonResponse(200, { ok: true })]);
    const res = await makeClient(f).request({ method: "GET", path: "/ping" });
    expect(res).toEqual({ ok: true });
    expect(f.calls[0]?.url).toBe("https://api.test/v3/ping");
  });

  it("builds the URL from query, dropping undefined/null", async () => {
    const f = queuedFetch([jsonResponse(200, {})]);
    await makeClient(f).request({
      method: "GET",
      path: "/bank",
      query: { country: "NG", page: 2, cursor: undefined, tag: null },
    });
    const url = new URL(f.calls[0]!.url);
    expect(url.searchParams.get("country")).toBe("NG");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("tag")).toBe(false);
  });

  it("sends auth, content-type, UA, and idempotency headers on a POST", async () => {
    const f = queuedFetch([jsonResponse(200, { ok: true })]);
    await makeClient(f).request({
      method: "POST",
      path: "/charge",
      body: { amount: 500 },
      idempotencyKey: "idem-1",
    });
    const init = f.calls[0]!.init as { headers: Headers; body: string };
    expect(init.headers.get("authorization")).toBe("Bearer sk_test_secret");
    expect(init.headers.get("content-type")).toBe("application/json");
    expect(init.headers.get("accept")).toBe("application/json");
    expect(init.headers.get("user-agent")).toMatch(/^payweave\/[\d.]+ \(paystack\)$/);
    expect(init.headers.get("idempotency-key")).toBe("idem-1");
    expect(init.body).toBe(JSON.stringify({ amount: 500 }));
  });

  it("validates a response schema and returns parsed data", async () => {
    const f = queuedFetch([jsonResponse(200, { ok: true, extra: 1 })]);
    const schema = z.object({ ok: z.boolean() });
    const res = await makeClient(f).request({ method: "GET", path: "/x", schema });
    expect(res.ok).toBe(true);
  });

  it("logs schema_drift and returns raw JSON on schema mismatch (never throws)", async () => {
    const events: SdkLogEvent[] = [];
    const f = queuedFetch([jsonResponse(200, { ok: "yes" })]);
    const schema = z.object({ ok: z.boolean() });
    const res = await makeClient(f, { logger: (e: SdkLogEvent) => events.push(e) }).request({
      method: "GET",
      path: "/x",
      schema,
    });
    expect(res).toEqual({ ok: "yes" });
    expect(events.some((e) => e.type === "schema_drift")).toBe(true);
  });
});

describe("HttpClient — error mapping", () => {
  it("maps a 404 to PayweaveNotFoundError", async () => {
    const f = queuedFetch([jsonResponse(404, { message: "not found" })]);
    const err = await makeClient(f)
      .request({ method: "GET", path: "/missing" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNotFoundError);
  });

  it("redacts secrets in emitted logger events", async () => {
    const events: SdkLogEvent[] = [];
    const f = queuedFetch([jsonResponse(200, {})]);
    await makeClient(f, {
      auth: bearer("sk_live_TOPSECRET"),
      logger: (e: SdkLogEvent) => events.push(e),
    }).request({ method: "GET", path: "/x" });
    const req = events.find((e) => e.type === "request");
    expect(JSON.stringify(req)).not.toContain("sk_live_TOPSECRET");
  });
});

describe("HttpClient — retry policy", () => {
  it("retries a GET on 429 then succeeds, honoring Retry-After", async () => {
    vi.useFakeTimers();
    const events: SdkLogEvent[] = [];
    const f = queuedFetch([
      jsonResponse(429, { message: "slow" }, { "retry-after": "2" }),
      jsonResponse(200, { ok: true }),
    ]);
    const p = makeClient(f, { logger: (e: SdkLogEvent) => events.push(e) }).request({
      method: "GET",
      path: "/x",
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(f.calls.length).toBe(2);
    const retry = events.find((e) => e.type === "retry");
    expect(retry?.delay).toBe(2000);
  });

  it("retries a GET on 500 then succeeds", async () => {
    vi.useFakeTimers();
    const f = queuedFetch([jsonResponse(500, { message: "boom" }), jsonResponse(200, { ok: 1 })]);
    const p = makeClient(f).request({ method: "GET", path: "/x" });
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(f.calls.length).toBe(2);
  });

  it("NEVER retries a bare POST (no idempotency key)", async () => {
    const f = queuedFetch([jsonResponse(500, { message: "boom" })]);
    const err = await makeClient(f)
      .request({ method: "POST", path: "/charge", body: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveProviderError);
    expect(f.calls.length).toBe(1);
  });

  it("retries a POST that carries an idempotency key", async () => {
    vi.useFakeTimers();
    const f = queuedFetch([jsonResponse(503, { message: "x" }), jsonResponse(200, { ok: true })]);
    const p = makeClient(f).request({
      method: "POST",
      path: "/charge",
      body: {},
      idempotencyKey: "idem-9",
    });
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(f.calls.length).toBe(2);
  });

  it("retries network errors for a GET and throws after maxRetries", async () => {
    vi.useFakeTimers();
    const f = queuedFetch([new Error("ECONNRESET")]);
    const p = makeClient(f)
      .request({ method: "GET", path: "/x" })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    const err = await p;
    expect(err).toBeInstanceOf(PayweaveNetworkError);
    expect(f.calls.length).toBe(3); // 1 initial + 2 retries
  });

  it("maps an aborted request (timeout) to PayweaveNetworkError", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = queuedFetch([abort]);
    const err = await makeClient(f, { maxRetries: 0 })
      .request({ method: "GET", path: "/x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayweaveNetworkError);
    expect((err as Error).message).toMatch(/timed out/);
  });
});

describe("oauthClientCredentials", () => {
  function makeOauthPair() {
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("token")) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: `tok_${tokenCalls}`, expires_in: 100 });
      }
      apiCalls += 1;
      return jsonResponse(200, { ok: true });
    }) as FetchLike;
    return {
      get tokenCalls() {
        return tokenCalls;
      },
      get apiCalls() {
        return apiCalls;
      },
      fetchImpl,
    };
  }

  function v4Client(fetchImpl: FetchLike) {
    const auth = oauthClientCredentials({
      clientId: "id",
      clientSecret: "secret",
      tokenUrl: "https://idp.test/token",
      fetch: fetchImpl,
    });
    return new HttpClient({
      baseUrl: "https://api.v4",
      auth,
      provider: "flutterwave",
      version: "v4",
      fetch: fetchImpl,
      timeoutMs: 1_000_000,
    });
  }

  it("caches the token across requests", async () => {
    const pair = makeOauthPair();
    const client = v4Client(pair.fetchImpl);
    await client.request({ method: "GET", path: "/a" });
    await client.request({ method: "GET", path: "/b" });
    expect(pair.tokenCalls).toBe(1);
    expect(pair.apiCalls).toBe(2);
  });

  it("single-flights concurrent token fetches", async () => {
    const pair = makeOauthPair();
    const client = v4Client(pair.fetchImpl);
    await Promise.all([
      client.request({ method: "GET", path: "/a" }),
      client.request({ method: "GET", path: "/b" }),
    ]);
    expect(pair.tokenCalls).toBe(1);
  });

  it("refreshes at 80% of TTL", async () => {
    vi.useFakeTimers();
    const pair = makeOauthPair();
    const client = v4Client(pair.fetchImpl);
    await client.request({ method: "GET", path: "/a" });
    expect(pair.tokenCalls).toBe(1);
    // TTL 100s → refresh after 80s.
    await vi.advanceTimersByTimeAsync(81_000);
    await client.request({ method: "GET", path: "/b" });
    expect(pair.tokenCalls).toBe(2);
  });

  it("forces one refresh + retry on a 401", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("token")) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: `tok_${tokenCalls}`, expires_in: 3600 });
      }
      apiCalls += 1;
      return apiCalls === 1
        ? jsonResponse(401, { message: "expired token" })
        : jsonResponse(200, { ok: true });
    }) as FetchLike;
    const client = v4Client(fetchImpl);
    const res = await client.request({ method: "GET", path: "/a" });
    expect(res).toEqual({ ok: true });
    expect(tokenCalls).toBe(2);
    expect(apiCalls).toBe(2);
  });
});

describe("HttpClient — auth failures participate in retry + error mapping", () => {
  it("retries a GET when applyAuth fails transiently, then succeeds", async () => {
    vi.useFakeTimers();
    let authCalls = 0;
    const auth: AuthStrategy = {
      async applyAuth(init) {
        authCalls += 1;
        if (authCalls < 3) {
          throw new PayweaveNetworkError("token endpoint unreachable", { provider: "paystack" });
        }
        init.headers.set("Authorization", "Bearer ok");
      },
    };
    const f = queuedFetch([jsonResponse(200, { ok: true })]);
    const p = makeClient(f, { auth }).request({ method: "GET", path: "/ping" });
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(authCalls).toBe(3); // failed twice (retried), succeeded on the third
    expect(f.calls.length).toBe(1); // fetch only fired once auth succeeded
  });

  it("does not wrap a PayweaveAuthError from applyAuth, and does not retry it", async () => {
    let authCalls = 0;
    let fetchCalls = 0;
    const auth: AuthStrategy = {
      async applyAuth() {
        authCalls += 1;
        throw new PayweaveAuthError("bad credentials", { provider: "paystack", httpStatus: 401 });
      },
    };
    const f: FetchLike = async () => {
      fetchCalls += 1;
      return jsonResponse(200, {});
    };
    await expect(
      makeClient(f, { auth }).request({ method: "GET", path: "/ping" }),
    ).rejects.toBeInstanceOf(PayweaveAuthError); // not re-wrapped as PayweaveNetworkError
    expect(authCalls).toBe(1); // isRetryable=false → not retried
    expect(fetchCalls).toBe(0); // never reached the network
  });
});
