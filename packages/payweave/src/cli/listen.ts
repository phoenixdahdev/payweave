/**
 * `payweave listen` — local webhook relay for development.
 *
 * ── The ⚠️ tunnel decision ──────────────────────────────────────────────────
 * The spec's two options were "prefer provider-native dev delivery" (Stripe
 * CLI-style long-polling) or "fall back to a Payweave-operated relay." Both
 * were researched and rejected in favor of a THIRD option — a local-relay /
 * receive-and-forward design — because:
 *
 *   - Provider-native dev delivery (`stripe listen`) is Stripe's own CLI
 *     feature: it authenticates as the developer's Stripe account and opens a
 *     private streaming connection that only Stripe's own CLI binary speaks —
 *     there is no published third-party API contract for another tool to
 *     register the same tunnel (docs.stripe.com/stripe-cli/use-cli,
 *     docs.stripe.com/cli/listen — both describe running `stripe listen`
 *     itself, never a third-party integration point). Paystack's and
 *     Flutterwave's own CLIs (`paystack-cli`, `flutterwave-cli`) are the same
 *     shape: a first-party tool tied to that provider's own account/session,
 *     not a documented API `payweave` could drive. Reimplementing three
 *     separate, undocumented, provider-owned protocols would also violate
 *     "never invent API fields — official provider docs only."
 *   - A "Payweave-operated relay" (the spec's fallback) is ITSELF a hosted
 *     dependency: it requires Payweave to run and operate backend
 *     infrastructure that every `npx payweave listen` invocation would
 *     depend on for correctness. That directly contradicts the packaging
 *     positioning this CLI ships under (zod-only runtime deps,
 *     every other dependency bundled and self-contained — "no separate
 *     install") and the golden rule that CLI deps must be bundleable,
 *     dependency-free where possible.
 *
 * **Chosen: local-relay (receive-and-forward), zero hosted dependency.**
 * `listen` starts a plain `node:http` server (no bundled dep at all — chosen
 * to keep it dependency-free) on `--port` that receives provider webhooks
 * DIRECTLY.
 * Making that server reachable from a provider's dashboard over the public
 * internet is the USER'S OWN responsibility — their own tunnel (ngrok,
 * Cloudflare Tunnel, a cloud dev-box's public hostname, etc.). Payweave never
 * operates, proxies through, or depends on any hosted relay of its own; the
 * server verifies every request through the SAME `payweave.webhooks.
 * constructEvent` dispatch the SDK's own webhook handlers use (raw bytes,
 * never re-parsed before verification succeeds — golden rule 6), then either
 * forwards the exact bytes (`--forward-to`) or applies the event directly
 * (`event.apply()`).
 *
 * One consequence of this design, called out in the stream output: because
 * there is no provider-side registration step, `--retry <window>` can only
 * mean "redeliver events THIS SESSION already received and verified, whose
 * last delivery attempt failed, for up to `<window>` after receipt" — never a
 * provider-side missed-webhook backfill (this build has no channel to ask a
 * provider's API for events sent before this process started listening).
 * Delivery is at-least-once: a `--forward-to` endpoint may see the same event
 * more than once (retries, or the provider's own retry policy hitting this
 * same endpoint again) — `event.apply()`'s idempotency is what makes
 * that safe when forwarding is not used; a forwarded endpoint must be
 * idempotent itself.
 *
 * Live-key refusal: `listen` is a dev-only tool. If the loaded
 * client's `environment` resolves to `"live"`, it refuses to start unless
 * `--live` is passed, in which case it proceeds with a loud, repeated
 * warning. `environment` is the SAME single, client-wide, key-inferred field
 * `status.ts` already reads — never re-derived from a key regex here.
 *
 * ── Exit codes ───────────────────────────────────────────────────────────
 * 0 clean shutdown (SIGINT, or the `-- <cmd>` child exited 0); the child's
 * own exit code when non-zero and `-- <cmd>` was used; 1 for a failure to do
 * the command's actual job (config load, live-key refusal, port bind); 2 for
 * a bad flag/argument caught before anything was started (mirrors `./run`'s
 * "2 usage error" convention for the top-level dispatcher).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn as nodeSpawn } from "node:child_process";

import mri from "mri";

import type { CliCommand, CliIo } from "./command";
import {
  loadConfig,
  type LoadConfigOptions,
  type LoadedConfig,
  type PayweaveClientLike,
} from "./config-loader";
import { PayweaveConfigError } from "../core/errors";
import type { HeaderLookup } from "../core/provider";
import { redact } from "../core/redact";

// ── The client surface this command reads ──────────────────────────────────

/** One verified + normalized webhook event, as returned by `constructEvent` (webhooks/index.ts). */
export interface ListenWebhookEventLike {
  readonly provider: string;
  readonly type: string;
  readonly unifiedType: string;
  readonly dedupeKey: string;
  readonly id?: string | undefined;
  readonly data?: unknown;
  /** always present; throws `PayweaveConfigError` without a configured database. */
  apply(): Promise<unknown>;
}

/**
 * The multi-provider dispatch this command calls (webhooks/dispatch.ts's
 * `WebhookDispatchNamespace`). `verify`/`verifyOrThrow` are carried over
 * unnarrowed (unused by this command) purely so this interface stays a valid
 * override of {@link PayweaveClientLike}'s `webhooks` property below —
 * only `constructEvent` needs a real, callable signature here.
 */
export interface ListenWebhooksNamespaceLike {
  readonly verify: (...args: never[]) => unknown;
  readonly verifyOrThrow: (...args: never[]) => unknown;
  constructEvent(input: { rawBody: string | Uint8Array; headers: HeaderLookup }): ListenWebhookEventLike;
}

/**
 * The extended client shape `listen` reads from (superset of
 * {@link PayweaveClientLike}, same duck-typing pattern as `status.ts`/
 * `push.ts`). Only `webhooks` is narrowed — `constructEvent` on the base type
 * is deliberately `(...args: never[]) => unknown` (unusable to actually call
 * with real arguments), so this override supplies the real, callable shape.
 */
export interface ListenClientLike extends PayweaveClientLike {
  readonly webhooks: ListenWebhooksNamespaceLike;
}

// ── Small helpers (status.ts/push.ts precedent) ─────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errorName(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return undefined;
}

function redactLine(line: string): string {
  const scrubbed = redact(line);
  return typeof scrubbed === "string" ? scrubbed : line;
}

function describeFailure(err: unknown): string {
  const name = errorName(err);
  const message = redactLine(errorMessage(err));
  return name !== undefined ? `${name}: ${message}` : message;
}

// ── `--retry <window>` parsing ──────────────────────────────────────────────

const RETRY_WINDOW_PATTERN = /^(\d+)(ms|s|m|h)$/;
const RETRY_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse a `--retry` value (`5m`, `30s`, or `none`). Returns the
 * window in milliseconds, or `null` for the literal `"none"` (retry
 * explicitly disabled — same effective behavior as omitting the flag).
 * Also accepts `ms`/`h` units and a bare millisecond count for robustness.
 * Throws {@link PayweaveConfigError} on anything else.
 */
export function parseRetryWindow(raw: string): number | null {
  const value = raw.trim();
  if (value === "none") return null;
  const match = RETRY_WINDOW_PATTERN.exec(value);
  if (match === null) {
    throw new PayweaveConfigError(
      `--retry "${raw}" is not a valid window — expected a duration like "5m", "30s", "500ms", ` +
        '"1h", or the literal "none".',
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as string;
  return amount * RETRY_UNIT_MS[unit]!;
}

// ── Raw body reading (never re-parsed before verification — golden rule 6) ─

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

// ── `--forward-to` byte-fidelity forwarding ─────────────────────────────────

/**
 * Hop-by-hop / framing headers stripped before forwarding — every OTHER
 * header (signature headers included) passes through untouched so the dev's
 * own `constructEvent` re-verifies against the identical value (never
 * re-serialize, never touch casing/whitespace). These specific names
 * are excluded because they describe THIS request's own framing/connection,
 * not the provider's payload, and forwarding them verbatim would either be
 * wrong (a stale `content-length` if the transport re-encodes) or meaningless
 * at the new destination (`host`, `connection`).
 */
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

function buildForwardHeaders(headers: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

/** One delivery attempt's outcome — success, or a short describable failure. */
export interface DeliveryResult {
  readonly ok: boolean;
  readonly error?: string;
}

type DeliverFn = (
  event: ListenWebhookEventLike,
  rawBody: Buffer,
  headers: IncomingMessage["headers"],
) => Promise<DeliveryResult>;

/**
 * Build the delivery function for this run: forward the EXACT raw bytes +
 * pass-through headers to `forwardTo` (never re-serialize), or,
 * without `--forward-to`, apply the event directly via `event.apply()`
 * (idempotent; a database-less client's `apply()` throws
 * `PayweaveConfigError`, surfaced here as a normal delivery failure).
 */
function makeDeliver(forwardTo: string | undefined, fetchImpl: typeof fetch): DeliverFn {
  if (forwardTo !== undefined) {
    return async (_event, rawBody, headers) => {
      try {
        const response = await fetchImpl(forwardTo, {
          method: "POST",
          headers: buildForwardHeaders(headers),
          body: rawBody,
        });
        if (response.ok) return { ok: true };
        return { ok: false, error: `--forward-to responded ${response.status}` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    };
  }
  return async (event) => {
    try {
      await event.apply();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeFailure(err) };
    }
  };
}

// ── In-process retry buffer (the `--retry` design — see module doc comment) ─

interface BufferedDelivery {
  readonly event: ListenWebhookEventLike;
  readonly rawBody: Buffer;
  readonly headers: IncomingMessage["headers"];
  readonly receivedAt: number;
  delivered: boolean;
  lastError?: string | undefined;
}

/**
 * Retry every still-pending, not-yet-expired entry once. Exported for direct
 * unit testing. `retryWindowMs === null` means retry is disabled — a no-op.
 */
export async function sweepPendingDeliveries(
  buffer: readonly BufferedDelivery[],
  retryWindowMs: number | null,
  now: number,
  deliver: DeliverFn,
  io: CliIo,
): Promise<void> {
  if (retryWindowMs === null) return;
  for (const entry of buffer) {
    if (entry.delivered) continue;
    if (now - entry.receivedAt > retryWindowMs) continue; // expired — already logged once, leave it
    const result = await deliver(entry.event, entry.rawBody, entry.headers);
    if (result.ok) {
      entry.delivered = true;
      io.out(
        `[retry]  delivered ${entry.event.provider} ${entry.event.unifiedType} ` +
          `(dedupeKey ${entry.event.dedupeKey})`,
      );
    } else {
      entry.lastError = result.error;
    }
  }
}

/** Drop delivered entries and entries that have aged out of the retry window — nothing left to attempt. */
function pruneBuffer(buffer: BufferedDelivery[], now: number, retryWindowMs: number | null): void {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i]!;
    const expired = retryWindowMs === null || now - entry.receivedAt > retryWindowMs;
    if (entry.delivered || expired) buffer.splice(i, 1);
  }
}

// ── Output formatting ────────────────────────────────────────────────────────

/** Render one verified event as a terminal line. Exported so tests assert exact formatting. */
export function formatEventLine(event: ListenWebhookEventLike): string {
  const idPart = event.id !== undefined ? ` id=${event.id}` : "";
  return `[event]  ${event.provider} ${event.unifiedType} (native: ${event.type})${idPart} dedupeKey=${event.dedupeKey}`;
}

// ── Server wiring ────────────────────────────────────────────────────────────

interface RequestContext {
  readonly client: ListenClientLike;
  readonly io: CliIo;
  readonly providerFilter: string | undefined;
  readonly forwardTo: string | undefined;
  readonly retryWindowMs: number | null;
  readonly buffer: BufferedDelivery[];
  readonly deliver: DeliverFn;
  readonly now: () => number;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    ctx.io.err(`payweave listen: failed to read a request body — ${describeFailure(err)}`);
    res.statusCode = 400;
    res.end("payweave listen: failed to read request body\n");
    return;
  }

  let event: ListenWebhookEventLike;
  try {
    event = ctx.client.webhooks.constructEvent({ rawBody, headers: req.headers });
  } catch (err) {
    ctx.io.err(`payweave listen: rejected an incoming webhook — ${describeFailure(err)}`);
    res.statusCode = 400;
    res.end("payweave listen: webhook rejected — signature verification failed\n");
    return;
  }

  if (ctx.providerFilter !== undefined && event.provider !== ctx.providerFilter) {
    ctx.io.out(
      `[skip]   ${event.provider} ${event.unifiedType} — not matching --provider ${ctx.providerFilter}`,
    );
    // Still acknowledge receipt (2xx) — this endpoint IS configured for the
    // provider (constructEvent verified it), we are just scoped elsewhere for
    // this session; a non-2xx here would make the provider retry forever.
    res.statusCode = 200;
    res.end("ok (skipped — provider filter)\n");
    return;
  }

  ctx.io.out(formatEventLine(event));
  ctx.io.out(`         data: ${JSON.stringify(redact(event.data))}`);

  const entry: BufferedDelivery = {
    event,
    rawBody,
    headers: req.headers,
    receivedAt: ctx.now(),
    delivered: false,
  };

  const result = await ctx.deliver(event, rawBody, req.headers);
  if (result.ok) {
    entry.delivered = true;
    ctx.io.out(
      ctx.forwardTo !== undefined
        ? `         forwarded -> ${ctx.forwardTo}`
        : "         applied locally (event.apply())",
    );
  } else {
    entry.lastError = result.error;
    ctx.buffer.push(entry);
    ctx.io.out(
      `         delivery failed: ${result.error}` +
        (ctx.retryWindowMs !== null ? " — queued for retry" : " — not retried (--retry not set)"),
    );
  }

  // Every request is a chance to catch up on anything still pending.
  await sweepPendingDeliveries(ctx.buffer, ctx.retryWindowMs, ctx.now(), ctx.deliver, ctx.io);
  pruneBuffer(ctx.buffer, ctx.now(), ctx.retryWindowMs);

  // Acknowledge receipt regardless of the delivery outcome above: WE own
  // retrying a failed forward/apply from here (the in-process buffer), not
  // the provider's own retry policy — see the module doc comment on
  // at-least-once delivery. Only a verification/parse failure is non-2xx.
  res.statusCode = 200;
  res.end("ok\n");
}

// ── `-- <cmd>` child process mode ────────────────────────────────────────────

/** Minimal structural shape of a spawned child this command needs — injectable for tests. */
export interface SpawnedChildLike {
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: "inherit" },
) => SpawnedChildLike;

const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as SpawnedChildLike;

// ── Orchestration ────────────────────────────────────────────────────────────

/** Options accepted by {@link runListenCommand} beyond the CLI flags themselves. */
export interface ListenCommandOptions {
  /** Injectable for tests; defaults to the real loader. */
  loadConfig?: (options: LoadConfigOptions) => Promise<LoadedConfig>;
  /** Project root `loadConfig` searches from (passed through to it). */
  cwd?: string;
  /** Injectable stop signal — aborting it triggers graceful shutdown. Defaults to real `SIGINT`. */
  signal?: AbortSignal;
  /** Injectable `fetch` for `--forward-to`. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable spawn for `-- <cmd>` mode. Defaults to `node:child_process`'s `spawn`. */
  spawnImpl?: SpawnLike;
  /** Injectable clock (ms epoch). Defaults to `Date.now`. */
  now?: () => number;
  /** Retry-sweep timer interval in ms. Default 2000; tests use {@link ListenServerHandle.triggerRetrySweep} instead of waiting on it. */
  retrySweepIntervalMs?: number;
  /** Fired once the server is actually bound and listening. Tests use this instead of polling. */
  onListening?: (handle: ListenServerHandle) => void;
}

/** Handle exposed to {@link ListenCommandOptions.onListening} — mainly for tests. */
export interface ListenServerHandle {
  /** The actual bound port (useful when `--port 0` requested an OS-assigned ephemeral port). */
  readonly port: number;
  /** Trigger graceful shutdown, same as receiving the stop signal. */
  stop(): void;
  /** Force an immediate retry sweep instead of waiting for the timer. */
  triggerRetrySweep(): Promise<void>;
}

const DEFAULT_PORT = 4242;
const DEFAULT_RETRY_SWEEP_INTERVAL_MS = 2000;

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * `payweave listen`'s `run` body. Parses its own flags:
 * `--config <path>`, `--provider <id>`, `--forward-to <url>`, `--retry
 * <window>`, `--port <n>` (default 4242; `0` picks an OS-assigned ephemeral
 * port — useful for tests), `--live` (proceed against a live-environment
 * config), and a trailing `-- <cmd> [args...]` to run the dev server
 * alongside (mri hands everything after a literal `--` back verbatim).
 *
 * Runs until the injected/`SIGINT` stop signal fires or the `-- <cmd>` child
 * exits, then closes the server and clears timers before resolving.
 */
export async function runListenCommand(
  argv: readonly string[],
  io: CliIo,
  options: ListenCommandOptions = {},
): Promise<number> {
  const args = mri([...argv], {
    string: ["config", "provider", "forward-to", "retry", "port"],
    boolean: ["live"],
  });

  // ── Phase 1: flag validation (exit 2 — usage error, nothing started yet). ──
  let forwardTo: string | undefined;
  let retryWindowMs: number | null = null;
  let port = DEFAULT_PORT;
  try {
    if (typeof args["forward-to"] === "string") {
      forwardTo = new URL(args["forward-to"]).toString();
    }
    if (typeof args["retry"] === "string") {
      retryWindowMs = parseRetryWindow(args["retry"]);
    }
    if (typeof args["port"] === "string") {
      const parsed = Number(args["port"]);
      if (!isValidPort(parsed)) {
        throw new PayweaveConfigError(
          `--port "${args["port"]}" is not a valid port number (expected an integer 0-65535).`,
        );
      }
      port = parsed;
    }
  } catch (err) {
    if (err instanceof TypeError) {
      // `new URL(...)` on a malformed --forward-to value.
      io.err(`payweave listen: --forward-to "${args["forward-to"] as string}" is not a valid URL.`);
    } else {
      io.err(`payweave listen: ${errorMessage(err)}`);
    }
    return 2;
  }

  // ── Phase 2: load config (exit 1 — the command's actual job failed). ──────
  const loader = options.loadConfig ?? loadConfig;
  let loaded: LoadedConfig;
  try {
    loaded = await loader({
      configPath: typeof args["config"] === "string" ? args["config"] : undefined,
      cwd: options.cwd,
    });
  } catch (err) {
    io.err(`payweave listen: failed to load config — ${describeFailure(err)}`);
    return 1;
  }
  const client = loaded.client as ListenClientLike;

  // ── Phase 3: live-key refusal (dev-only tool). ─────────────────────────────
  if (client.environment === "live") {
    if (args["live"] !== true) {
      io.err(
        "payweave listen: refusing to start — this config resolves to a LIVE environment and " +
          "`listen` is a dev-only tool. Pass --live to proceed anyway (loud warning).",
      );
      return 1;
    }
    io.err(
      "payweave listen: WARNING — running against a LIVE environment because --live was passed. " +
        "Verified LIVE webhooks will be forwarded/applied for real. Do not leave this running " +
        "unattended; this is unsupported for anything but a deliberate one-off check.",
    );
  }

  // ── Phase 4: --provider scoping (exit 2 — an unconfigured id is a usage error). ──
  let providerFilter: string | undefined;
  if (typeof args["provider"] === "string") {
    if (!client.providers.includes(args["provider"])) {
      io.err(
        `payweave listen: --provider "${args["provider"]}" is not configured on this client ` +
          `(configured: ${client.providers.join(", ") || "none"}).`,
      );
      return 2;
    }
    providerFilter = args["provider"];
  }

  // ── Phase 5: start the local relay server. ────────────────────────────────
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const deliver = makeDeliver(forwardTo, fetchImpl);
  const buffer: BufferedDelivery[] = [];

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      client,
      io,
      providerFilter,
      forwardTo,
      retryWindowMs,
      buffer,
      deliver,
      now,
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });
  } catch (err) {
    io.err(`payweave listen: failed to start the local server on port ${port} — ${describeFailure(err)}`);
    return 1;
  }

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  io.out(`payweave listen: listening on http://localhost:${boundPort}`);
  io.out(
    forwardTo !== undefined
      ? `  forwarding verified webhooks to ${forwardTo}`
      : "  applying verified webhooks directly via event.apply() — no --forward-to configured",
  );
  io.out(
    providerFilter !== undefined
      ? `  scoped to provider: ${providerFilter}`
      : `  listening for: ${client.providers.join(", ") || "no providers configured"}`,
  );
  io.out(
    retryWindowMs !== null
      ? `  retrying failed deliveries for up to ${args["retry"] as string} after receipt`
      : "  --retry not set — a failed delivery is logged once and not retried",
  );
  io.out(
    "  reaching this server from a provider's dashboard over the public internet is your own " +
      "responsibility (point your own tunnel, e.g. ngrok, at this port) — payweave does not operate " +
      "or depend on a hosted relay.",
  );
  if (forwardTo !== undefined) {
    io.out(
      "  delivery is at-least-once: --forward-to may receive the same event more than once — make " +
        "your endpoint idempotent.",
    );
  }

  let retryTimer: NodeJS.Timeout | undefined;
  if (retryWindowMs !== null) {
    const intervalMs = options.retrySweepIntervalMs ?? DEFAULT_RETRY_SWEEP_INTERVAL_MS;
    retryTimer = setInterval(() => {
      void sweepPendingDeliveries(buffer, retryWindowMs, now(), deliver, io).then(() =>
        pruneBuffer(buffer, now(), retryWindowMs),
      );
    }, intervalMs);
    retryTimer.unref?.();
  }

  const triggerRetrySweep = async (): Promise<void> => {
    await sweepPendingDeliveries(buffer, retryWindowMs, now(), deliver, io);
    pruneBuffer(buffer, now(), retryWindowMs);
  };

  // ── Phase 6: optional `-- <cmd>` dev-server passenger. ────────────────────
  const childArgv = args._.map(String);
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  let child: SpawnedChildLike | undefined;
  if (childArgv.length > 0) {
    const [command, ...commandArgs] = childArgv as [string, ...string[]];
    io.out(`payweave listen: running \`${childArgv.join(" ")}\``);
    child = spawnImpl(command, commandArgs, { stdio: "inherit" });
  }

  // ── Phase 7: run until stopped (signal or child exit), then tear down. ───
  const controller = new AbortController();
  const stop = (): void => controller.abort();

  let sigintHandler: (() => void) | undefined;
  if (options.signal === undefined) {
    sigintHandler = () => controller.abort();
    process.once("SIGINT", sigintHandler);
  } else {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  options.onListening?.({ port: boundPort, stop, triggerRetrySweep });

  const stopResult = await new Promise<{ reason: "signal" | "child"; childExitCode: number }>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ reason: "signal", childExitCode: 0 }), {
      once: true,
    });
    child?.once("exit", (code) => resolve({ reason: "child", childExitCode: code ?? 0 }));
  });

  if (retryTimer !== undefined) clearInterval(retryTimer);
  if (sigintHandler !== undefined) process.removeListener("SIGINT", sigintHandler);
  if (stopResult.reason === "signal" && child !== undefined) {
    child.kill("SIGINT");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (stopResult.reason === "child") {
    io.out(`payweave listen: \`${childArgv[0]}\` exited (code ${stopResult.childExitCode}) — shutting down.`);
    return stopResult.childExitCode;
  }
  io.out("payweave listen: shutting down.");
  return 0;
}

export const listenCommand: CliCommand = {
  name: "listen",
  summary: "Receive, verify, and forward/apply provider webhooks locally",
  run: (argv, io) => runListenCommand(argv, io),
};
