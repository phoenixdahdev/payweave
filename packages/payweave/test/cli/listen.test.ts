/**
 * PW-1006 — `payweave listen` (docs/v1/cli.md §3, §8 "listen transport").
 *
 * Layers:
 *   1. `parseRetryWindow` — the `--retry` window parser, in isolation.
 *   2. `runListenCommand` end-to-end against a REAL `createPayweave` client
 *      (webhook verification must be real — no duck-typed stub could prove
 *      byte fidelity or signature rejection) with an injected `loadConfig`
 *      so no fixture project/file discovery is needed. Every signed vector
 *      comes from `signWebhook` (AGENTS.md §7's byte-fidelity oracle), never
 *      hand-rolled.
 *   3. `-- <cmd>` child-process lifecycle with an injected fake spawn.
 *
 * Every provider-shaped credential below is short and word-broken
 * (`sk_test_listen_*`, `whsec_listen_*`, `FLWSECK_TEST-listen`) — never a
 * 20+-contiguous-character run — per the repo's check-no-secrets gate
 * (scripts/check-no-secrets.mjs).
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/command";
import {
  formatEventLine,
  parseRetryWindow,
  runListenCommand,
  type ListenCommandOptions,
  type ListenServerHandle,
  type SpawnedChildLike,
} from "../../src/cli/listen";
import type { LoadConfigOptions, LoadedConfig, PayweaveClientLike } from "../../src/cli/config-loader";
import { createPayweave } from "../../src/index";
import { signWebhook, type SignWebhookProvider } from "../../src/testing/sign-webhook";

// ── Small test harness ───────────────────────────────────────────────────────

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

/** Wraps any client-shaped object as the `LoadedConfig` `loadConfig` hands back — bypasses file discovery entirely. */
function fakeLoader(client: unknown): (options: LoadConfigOptions) => Promise<LoadedConfig> {
  return async () => ({ path: "test/payweave.ts", client: client as PayweaveClientLike });
}

interface CapturedRequest {
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
}

/** A stub "dev app" upstream for `--forward-to` — records exact bytes + headers received. */
function createStubUpstream(): {
  server: Server;
  requests: CapturedRequest[];
  listen: () => Promise<string>;
  close: () => Promise<void>;
} {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ body: Buffer.concat(chunks), headers: req.headers });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  return {
    server,
    requests,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${address.port}/webhook`);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Start `runListenCommand`, resolving once the server is actually bound (via `onListening`). */
function startListen(
  argv: readonly string[],
  client: unknown,
  extra: Partial<ListenCommandOptions> = {},
): { runPromise: Promise<number>; ready: Promise<ListenServerHandle>; io: ReturnType<typeof capture> } {
  const io = capture();
  let resolveHandle!: (handle: ListenServerHandle) => void;
  const ready = new Promise<ListenServerHandle>((resolve) => {
    resolveHandle = resolve;
  });
  const runPromise = runListenCommand(argv, io.io, {
    loadConfig: fakeLoader(client),
    onListening: resolveHandle,
    ...extra,
  });
  return { runPromise, ready, io };
}

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

// ── Test clients (mirrors test/webhooks/dispatch.test.ts's construction) ────

const STRIPE_KEY = "sk_test_listen_stripe";
const STRIPE_WHSEC = "whsec_listen_stripe";
const PAYSTACK_KEY = "sk_test_listen_paystack";
const FLW_V3_KEY = "FLWSECK_TEST-listen";
const FLW_V3_HASH = "flw_v3_listen_hash";
const FLW_V4_HASH = "flw_v4_listen_hash";

/** stripe + paystack + flutterwave v3 — three of the four signing schemes on one client. */
function trioV3Client() {
  return createPayweave({
    stripe: { secretKey: STRIPE_KEY, webhookSecret: STRIPE_WHSEC },
    paystack: { secretKey: PAYSTACK_KEY },
    flutterwave: { secretKey: FLW_V3_KEY, webhookSecret: FLW_V3_HASH },
    defaultProvider: "stripe",
  });
}

/** flutterwave v4 alone — the fourth scheme (v3/v4 never share a client). */
function flwV4Client(environment?: "test" | "live") {
  return createPayweave({
    flutterwave: {
      version: "v4",
      clientId: "listen-test-client-id",
      clientSecret: "listen-test-client-secret",
      webhookSecret: FLW_V4_HASH,
      ...(environment !== undefined ? { environment } : {}),
    },
    defaultProvider: "flutterwave",
  });
}

// ── Signed vectors ───────────────────────────────────────────────────────────

const stripePayload = {
  id: "evt_listen1",
  object: "event",
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_listen1", status: "succeeded" } },
};
const paystackPayload = { event: "charge.success", data: { id: 555001, status: "success" } };
const flwV3Payload = { event: "charge.completed", data: { id: 555002, status: "successful" } };
const flwV4Payload = {
  id: "wbk_listen1",
  type: "charge.completed",
  data: { id: "chg_listen1", status: "succeeded" },
};

async function postRaw(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { method: "POST", headers, body });
  return { status: response.status, text: await response.text() };
}

// ── 1. `--retry` window parsing ─────────────────────────────────────────────

describe("parseRetryWindow (cli.md §3)", () => {
  it.each([
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h", 3_600_000],
    ["250ms", 250],
  ])("parses %s as %d ms", (input, expected) => {
    expect(parseRetryWindow(input)).toBe(expected);
  });

  it('parses "none" as null (retry disabled)', () => {
    expect(parseRetryWindow("none")).toBeNull();
  });

  it.each([["bogus"], [""], ["-5m"], ["5"], ["m5"]])("rejects invalid window %j", (input) => {
    expect(() => parseRetryWindow(input)).toThrow(/not a valid window/);
  });
});

// ── 2. Byte-fidelity forwarding + verification ──────────────────────────────

describe("runListenCommand — --forward-to byte fidelity (cli.md §8, §9)", () => {
  it.each<[SignWebhookProvider, string, unknown]>([
    ["stripe", STRIPE_WHSEC, stripePayload],
    ["paystack", PAYSTACK_KEY, paystackPayload],
    ["flutterwave", FLW_V3_HASH, flwV3Payload],
  ])("forwards a verified %s webhook byte-identically", async (provider, secret, payload) => {
    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    const upstreamUrl = await upstream.listen();

    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(["--forward-to", upstreamUrl, "--port", "0"], client);
    const handle = await ready;

    const signed = signWebhook(provider, payload, secret);
    const res = await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);
    expect(res.status).toBe(200);

    expect(upstream.requests).toHaveLength(1);
    const forwarded = upstream.requests[0]!;
    expect(forwarded.body.toString("utf8")).toBe(signed.body);
    expect(forwarded.headers[signed.headerName]).toBe(signed.header);

    expect(io.out()).toContain("[event]");

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });

  it("forwards a verified flutterwave v4 webhook byte-identically (separate client — v3/v4 never share one)", async () => {
    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    const upstreamUrl = await upstream.listen();

    const client = flwV4Client();
    const { runPromise, ready } = startListen(["--forward-to", upstreamUrl, "--port", "0"], client);
    const handle = await ready;

    const signed = signWebhook("flutterwave-v4", flwV4Payload, FLW_V4_HASH);
    const res = await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);
    expect(res.status).toBe(200);

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.body.toString("utf8")).toBe(signed.body);
    expect(upstream.requests[0]!.headers[signed.headerName]).toBe(signed.header);

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });

  it("without --forward-to, applies the event directly (event.apply()) and reports the outcome", async () => {
    const client = trioV3Client(); // no database configured — apply() throws PayweaveConfigError
    const { runPromise, ready, io } = startListen(["--port", "0"], client);
    const handle = await ready;

    const signed = signWebhook("stripe", stripePayload, STRIPE_WHSEC);
    const res = await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);
    // Still acknowledged (200) — WE own retrying a failed delivery, not the provider (module doc comment).
    expect(res.status).toBe(200);
    expect(io.out()).toContain("delivery failed");
    expect(io.out()).toContain("PayweaveConfigError");
    expect(io.out()).toContain("not retried (--retry not set)");

    handle.stop();
    expect(await runPromise).toBe(0);
  });
});

describe("runListenCommand — invalid signatures are rejected (cli.md §9)", () => {
  it("a mis-keyed webhook is rejected: non-2xx, never forwarded", async () => {
    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    const upstreamUrl = await upstream.listen();

    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(["--forward-to", upstreamUrl, "--port", "0"], client);
    const handle = await ready;

    // Signed with the WRONG secret for this client's configured stripe webhookSecret.
    const signed = signWebhook("stripe", stripePayload, "whsec_listen_wrong");
    const res = await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);

    expect(res.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
    expect(io.err()).toContain("rejected an incoming webhook");

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });

  it("no known signature header at all is rejected", async () => {
    const client = trioV3Client();
    const { runPromise, ready } = startListen(["--port", "0"], client);
    const handle = await ready;

    const res = await postRaw(`http://127.0.0.1:${handle.port}`, JSON.stringify(stripePayload), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(400);

    handle.stop();
    expect(await runPromise).toBe(0);
  });
});

// ── 3. Live-key refusal ──────────────────────────────────────────────────────

describe("runListenCommand — live-key refusal (cli.md §8)", () => {
  it("refuses to start against a LIVE environment without --live", async () => {
    const client = flwV4Client("live");
    const { io, err } = capture();
    const exitCode = await runListenCommand(["--port", "0"], io, {
      loadConfig: fakeLoader(client),
      onListening: () => {
        throw new Error("must not start the server for a live environment without --live");
      },
    });
    expect(exitCode).toBe(1);
    expect(err()).toContain("LIVE environment");
  });

  it("proceeds with a loud warning when --live is passed", async () => {
    const client = flwV4Client("live");
    const { runPromise, ready, io } = startListen(["--port", "0", "--live"], client);
    const handle = await ready;
    expect(io.err()).toContain("WARNING");
    expect(io.err()).toContain("LIVE environment");

    handle.stop();
    expect(await runPromise).toBe(0);
  });

  it("a test-environment config starts cleanly with no warning", async () => {
    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(["--port", "0"], client);
    const handle = await ready;
    expect(io.err()).toBe("");

    handle.stop();
    expect(await runPromise).toBe(0);
  });
});

// ── 4. `--provider` scoping ──────────────────────────────────────────────────

describe("runListenCommand — --provider scoping (cli.md §3, §9)", () => {
  it("an unconfigured --provider id errors before the server starts", async () => {
    const client = trioV3Client();
    const { io, err } = capture();
    const exitCode = await runListenCommand(["--provider", "flutterwave-v9", "--port", "0"], io, {
      loadConfig: fakeLoader(client),
      onListening: () => {
        throw new Error("must not start the server for an unconfigured --provider");
      },
    });
    expect(exitCode).toBe(2);
    expect(err()).toContain("not configured on this client");
  });

  it("scopes processing to the requested provider — other providers are skipped, not forwarded", async () => {
    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    const upstreamUrl = await upstream.listen();

    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(
      ["--provider", "stripe", "--forward-to", upstreamUrl, "--port", "0"],
      client,
    );
    const handle = await ready;

    const paystackSigned = signWebhook("paystack", paystackPayload, PAYSTACK_KEY);
    const skipRes = await postRaw(
      `http://127.0.0.1:${handle.port}`,
      paystackSigned.body,
      paystackSigned.headers,
    );
    expect(skipRes.status).toBe(200); // acknowledged so the provider doesn't retry forever
    expect(upstream.requests).toHaveLength(0);
    expect(io.out()).toContain("[skip]");

    const stripeSigned = signWebhook("stripe", stripePayload, STRIPE_WHSEC);
    const forwardRes = await postRaw(
      `http://127.0.0.1:${handle.port}`,
      stripeSigned.body,
      stripeSigned.headers,
    );
    expect(forwardRes.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });
});

// ── 5. Graceful shutdown ─────────────────────────────────────────────────────

describe("runListenCommand — graceful shutdown", () => {
  it("stops via an injected AbortSignal, closes the server, and resolves 0", async () => {
    const controller = new AbortController();
    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(["--port", "0"], client, {
      signal: controller.signal,
    });
    const handle = await ready;

    controller.abort();
    expect(await runPromise).toBe(0);
    expect(io.out()).toContain("shutting down");

    await expect(fetch(`http://127.0.0.1:${handle.port}`, { method: "POST" })).rejects.toBeTruthy();
  });

  it("the exposed stop() has the same effect as the signal", async () => {
    const client = trioV3Client();
    const { runPromise, ready } = startListen(["--port", "0"], client);
    const handle = await ready;
    handle.stop();
    expect(await runPromise).toBe(0);
  });
});

// ── 6. `-- <cmd>` child-process lifecycle ───────────────────────────────────

class FakeChild extends EventEmitter implements SpawnedChildLike {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("runListenCommand — `-- <cmd>` mode", () => {
  it("spawns the trailing command with inherited stdio and propagates its exit code", async () => {
    const client = trioV3Client();
    const fakeChild = new FakeChild();
    const spawnCalls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const spawnImpl: ListenCommandOptions["spawnImpl"] = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return fakeChild;
    };

    const { runPromise, ready, io } = startListen(
      ["--port", "0", "--", "pnpm", "dev", "--flag"],
      client,
      { spawnImpl },
    );
    await ready;

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: "pnpm",
      args: ["dev", "--flag"],
      options: { stdio: "inherit" },
    });
    expect(io.out()).toContain("running `pnpm dev --flag`");

    fakeChild.emit("exit", 3, null);
    expect(await runPromise).toBe(3);
    expect(io.out()).toContain("exited (code 3)");
  });

  it("kills a still-running child when shutdown comes from the stop signal instead", async () => {
    const client = trioV3Client();
    const fakeChild = new FakeChild();
    const spawnImpl: ListenCommandOptions["spawnImpl"] = () => fakeChild;

    const { runPromise, ready } = startListen(["--port", "0", "--", "pnpm", "dev"], client, {
      spawnImpl,
    });
    const handle = await ready;

    handle.stop();
    expect(await runPromise).toBe(0);
    expect(fakeChild.killed).toBe(true);
  });
});

// ── 7. Retry sweep ───────────────────────────────────────────────────────────

describe("runListenCommand — --retry sweep (cli.md §3, §8)", () => {
  it("retries a failed forward once the upstream comes up, via a manual sweep trigger", async () => {
    // Reserve a port, then close it immediately so the FIRST forward attempt fails (connection refused).
    const probe = createStubUpstream();
    const deadUrl = await probe.listen();
    const deadPort = Number(new URL(deadUrl).port);
    await probe.close();

    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(
      ["--forward-to", deadUrl, "--retry", "5m", "--port", "0"],
      client,
      { retrySweepIntervalMs: 999_999 },
    );
    const handle = await ready;

    const signed = signWebhook("stripe", stripePayload, STRIPE_WHSEC);
    const res = await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);
    expect(res.status).toBe(200); // acked despite the downstream forward failing
    expect(io.out()).toContain("delivery failed");
    expect(io.out()).toContain("queued for retry");

    // Bring the upstream back up on the SAME port and retry.
    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    await new Promise<void>((resolve) => upstream.server.listen(deadPort, "127.0.0.1", resolve));

    await handle.triggerRetrySweep();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.body.toString("utf8")).toBe(signed.body);
    expect(io.out()).toContain("[retry]  delivered");

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });

  it("never retries once the entry has aged out of the window", async () => {
    const probe = createStubUpstream();
    const deadUrl = await probe.listen();
    const deadPort = Number(new URL(deadUrl).port);
    await probe.close();

    let clock = 1_000_000;
    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(
      ["--forward-to", deadUrl, "--retry", "30s", "--port", "0"],
      client,
      { now: () => clock, retrySweepIntervalMs: 999_999 },
    );
    const handle = await ready;

    const signed = signWebhook("stripe", stripePayload, STRIPE_WHSEC);
    await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);

    // Advance well past the 30s window before the upstream ever comes back.
    clock += 60_000;
    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    await new Promise<void>((resolve) => upstream.server.listen(deadPort, "127.0.0.1", resolve));

    await handle.triggerRetrySweep();
    expect(upstream.requests).toHaveLength(0);
    expect(io.out()).not.toContain("[retry]  delivered");

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });

  it("without --retry, a failed delivery is logged once and never retried", async () => {
    const probe = createStubUpstream();
    const deadUrl = await probe.listen();
    await probe.close();

    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(["--forward-to", deadUrl, "--port", "0"], client);
    const handle = await ready;

    const signed = signWebhook("stripe", stripePayload, STRIPE_WHSEC);
    await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);
    expect(io.out()).toContain("not retried (--retry not set)");

    await handle.triggerRetrySweep(); // a no-op — retry disabled
    handle.stop();
    expect(await runPromise).toBe(0);
  });

  it("also retries automatically on the background timer, without a manual trigger", async () => {
    const probe = createStubUpstream();
    const deadUrl = await probe.listen();
    const deadPort = Number(new URL(deadUrl).port);
    await probe.close();

    const client = trioV3Client();
    const { runPromise, ready, io } = startListen(
      ["--forward-to", deadUrl, "--retry", "5m", "--port", "0"],
      client,
      { retrySweepIntervalMs: 20 },
    );
    const handle = await ready;

    const signed = signWebhook("stripe", stripePayload, STRIPE_WHSEC);
    await postRaw(`http://127.0.0.1:${handle.port}`, signed.body, signed.headers);

    const upstream = createStubUpstream();
    openServers.push(upstream.server);
    await new Promise<void>((resolve) => upstream.server.listen(deadPort, "127.0.0.1", resolve));

    // No manual trigger here — wait for the real background interval to fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(upstream.requests).toHaveLength(1);
    expect(io.out()).toContain("[retry]  delivered");

    handle.stop();
    expect(await runPromise).toBe(0);
    await upstream.close();
  });
});

// ── 8. Flag validation ───────────────────────────────────────────────────────

describe("runListenCommand — flag validation (usage errors, exit 2)", () => {
  it("rejects an invalid --forward-to URL", async () => {
    const client = trioV3Client();
    const { io, err } = capture();
    const exitCode = await runListenCommand(["--forward-to", "not a url", "--port", "0"], io, {
      loadConfig: fakeLoader(client),
    });
    expect(exitCode).toBe(2);
    expect(err()).toContain("not a valid URL");
  });

  it("rejects an invalid --retry window", async () => {
    const client = trioV3Client();
    const { io, err } = capture();
    const exitCode = await runListenCommand(["--retry", "whenever", "--port", "0"], io, {
      loadConfig: fakeLoader(client),
    });
    expect(exitCode).toBe(2);
    expect(err()).toContain("not a valid window");
  });

  it("rejects an invalid --port", async () => {
    const client = trioV3Client();
    const { io, err } = capture();
    const exitCode = await runListenCommand(["--port", "notaport"], io, {
      loadConfig: fakeLoader(client),
    });
    expect(exitCode).toBe(2);
    expect(err()).toContain("not a valid port number");
  });

  it("a config-load failure exits 1", async () => {
    const { io, err } = capture();
    const exitCode = await runListenCommand(["--port", "0"], io, {
      loadConfig: async () => {
        throw new Error("boom");
      },
    });
    expect(exitCode).toBe(1);
    expect(err()).toContain("failed to load config");
  });

  it("a port bind failure (already in use) exits 1", async () => {
    const client = trioV3Client();
    const { runPromise: firstRun, ready: firstReady } = startListen(["--port", "0"], client);
    const first = await firstReady;

    const { io, err } = capture();
    const exitCode = await runListenCommand(["--port", String(first.port)], io, {
      loadConfig: fakeLoader(client),
    });
    expect(exitCode).toBe(1);
    expect(err()).toContain("failed to start the local server");

    first.stop();
    expect(await firstRun).toBe(0);
  });
});

// ── 9. Output formatting ─────────────────────────────────────────────────────

describe("formatEventLine", () => {
  it("renders provider, unified type, native type, id, and dedupeKey", () => {
    const line = formatEventLine({
      provider: "stripe",
      type: "payment_intent.succeeded",
      unifiedType: "payment.succeeded",
      dedupeKey: "evt_1",
      id: "evt_1",
      data: {},
      apply: async () => undefined,
    });
    expect(line).toContain("stripe");
    expect(line).toContain("payment.succeeded");
    expect(line).toContain("payment_intent.succeeded");
    expect(line).toContain("id=evt_1");
    expect(line).toContain("dedupeKey=evt_1");
  });

  it("omits the id segment when absent", () => {
    const line = formatEventLine({
      provider: "paystack",
      type: "charge.success",
      unifiedType: "payment.succeeded",
      dedupeKey: "abc",
      data: {},
      apply: async () => undefined,
    });
    expect(line).not.toContain("id=");
  });
});
