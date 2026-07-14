/**
 * HttpClient + pluggable auth strategies. One class backs every
 * resource. Builds URLs, applies auth, enforces timeouts via `AbortSignal`,
 * runs the retry policy, maps non-2xx via {@link mapHttpError}, and
 * emits redacted logger events. Response schemas LOG drift and never throw.
 */
import type { ZodType } from "zod";
import {
  mapHttpError,
  PayweaveError,
  PayweaveAuthError,
  PayweaveNetworkError,
  type PayweaveProvider,
} from "./errors";
import type { Logger } from "./logger";
import { redact } from "./redact";
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  isRetryableRequest,
  isRetryableStatus,
  parseRetryAfter,
  type RetryPolicy,
} from "./retry";
import { SDK_VERSION } from "./version";

/**
 * Structural header bag — the subset of `Headers` we read/write. Defined
 * locally because the declaration-rollup step (api-extractor) cannot follow the
 * global `Headers`/`Request`/`Response`/`RequestInit` symbols. The real global
 * `Headers` is assignable to this.
 */
export interface HeadersLike {
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  forEach(callback: (value: string, key: string) => void): void;
}

/** Structural abort signal — the subset the client passes through. */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/** Minimal structural request init for {@link FetchLike} (no global DOM types). */
export interface FetchRequestInit {
  method?: string;
  headers?: HeadersLike | Record<string, string>;
  body?: string;
  signal?: AbortSignalLike;
}

/** Minimal structural response — the subset of `Response` the client uses. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: HeadersLike;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Structural `fetch` type — the global `fetch` is assignable to it (via a cast
 * at the injection point). We avoid `typeof fetch` and every global DOM type so
 * the declaration rollup succeeds; injectable for tests/custom runtimes.
 */
export type FetchLike = (
  input: string | URL,
  init?: FetchRequestInit,
) => Promise<FetchResponse>;

/**
 * Pluggable authentication. `bearer` for Paystack + Flutterwave v3; OAuth
 * client-credentials for Flutterwave v4. `applyAuth` mutates the outgoing
 * headers; `refresh` (optional) forces a token refresh for the one-shot 401
 * retry.
 */
export interface AuthStrategy {
  applyAuth(init: { headers: HeadersLike }): Promise<void>;
  /** Force a credential refresh (v4 OAuth). Absent for static bearer keys. */
  refresh?(): Promise<void>;
}

/**
 * An encoded request body: the exact bytes to send plus the `Content-Type`
 * that describes them.
 */
export interface EncodedBody {
  contentType: string;
  body: string;
}

/**
 * Per-provider request-body serializer hook. The default is JSON
 * ({@link jsonBodyEncoder}); Stripe injects a
 * deterministic `application/x-www-form-urlencoded` encoder from
 * `src/stripe/form-encoding`. The client invokes the encoder EXACTLY ONCE per
 * `request()` call — every retry re-sends the same encoded bytes, so a
 * non-deterministic encoder can never produce divergent attempts.
 */
export type BodyEncoder = (body: unknown) => EncodedBody;

/**
 * Default {@link BodyEncoder}: JSON. Byte-identical to the pre-hook behavior
 * (`Content-Type: application/json` + `JSON.stringify`).
 */
function jsonBodyEncoder(body: unknown): EncodedBody {
  return { contentType: "application/json", body: JSON.stringify(body) };
}

/** Static `Authorization: Bearer <secretKey>` (Paystack, Flutterwave v3). */
export function bearer(secretKey: string): AuthStrategy {
  return {
    async applyAuth(init) {
      init.headers.set("Authorization", `Bearer ${secretKey}`);
    },
  };
}

/** Response shape of the v4 OAuth token endpoint (fields we consume). */
interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

/**
 * OAuth 2.0 client-credentials strategy for Flutterwave v4. In-memory token
 * cache with refresh at 80% of TTL, single-flight refresh (concurrent callers
 * await one fetch), and a forced refresh usable for the one-shot 401 retry.
 *
 * ⚠️ VERIFY AT BUILD TIME against the v4 Authentication docs: the exact token
 * endpoint, `grant_type`, request encoding, and the TTL/`expires_in` field.
 */
export function oauthClientCredentials(opts: {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  fetch?: FetchLike;
  logger?: Logger;
}): AuthStrategy {
  const doFetch: FetchLike = opts.fetch ?? (fetch as unknown as FetchLike);
  let token: string | null = null;
  let refreshAtMs = 0;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    // ⚠️ VERIFY: grant_type/encoding per v4 Authentication docs.
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    let res: FetchResponse;
    try {
      res = await doFetch(opts.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new PayweaveNetworkError("Failed to reach the Flutterwave v4 token endpoint.", {
        provider: "flutterwave",
        cause: err,
      });
    }
    if (!res.ok) {
      throw new PayweaveAuthError(
        `Flutterwave v4 token request failed (${res.status}).`,
        { provider: "flutterwave", httpStatus: res.status },
      );
    }
    const json = (await res.json()) as TokenResponse;
    if (typeof json.access_token !== "string") {
      throw new PayweaveAuthError("Flutterwave v4 token response had no access_token.", {
        provider: "flutterwave",
      });
    }
    const ttlSeconds = typeof json.expires_in === "number" ? json.expires_in : 600;
    // Refresh at 80% of TTL to avoid using a token that expires mid-flight.
    refreshAtMs = Date.now() + ttlSeconds * 1000 * 0.8;
    token = json.access_token;
    return token;
  }

  async function getToken(force: boolean): Promise<string> {
    if (!force && token !== null && Date.now() < refreshAtMs) return token;
    // Single-flight: concurrent callers share one in-flight token fetch.
    if (inflight) return inflight;
    inflight = fetchToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async applyAuth(init) {
      const t = await getToken(false);
      init.headers.set("Authorization", `Bearer ${t}`);
    },
    async refresh() {
      await getToken(true);
    },
  };
}

/**
 * Constructor options for {@link HttpClient}. Optional fields include
 * `undefined` so they can be wired straight from a {@link ResolvedConfig} under
 * `exactOptionalPropertyTypes`.
 */
export interface HttpClientOptions {
  baseUrl: string;
  auth: AuthStrategy;
  provider: PayweaveProvider;
  version?: "v3" | "v4" | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: FetchLike | undefined;
  logger?: Logger | undefined;
  userAgent?: string | undefined;
  /**
   * Request-body serializer. Omitted → JSON, byte-identical to the
   * historical behavior. Stripe passes its form encoder here so no JSON body
   * ever leaves the Stripe client.
   */
  bodyEncoder?: BodyEncoder | undefined;
}

/** Query values — `undefined`/`null` entries are dropped from the URL. */
export type QueryValue = string | number | boolean | undefined | null;

/** Options for a single {@link HttpClient.request}. */
export interface RequestOptions<TRes> {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Presence makes a non-GET request retry-eligible. */
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Response schema — drift is logged, never thrown. */
  schema?: ZodType<TRes>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * The single HTTP client used by every resource. Stateless per request; safe to
 * share across a provider client.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly auth: AuthStrategy;
  private readonly provider: PayweaveProvider;
  private readonly timeoutMs: number;
  private readonly policy: RetryPolicy;
  private readonly doFetch: FetchLike;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;
  private readonly encodeBody: BodyEncoder;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.provider = options.provider;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.policy = {
      ...DEFAULT_RETRY_POLICY,
      maxRetries: options.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
    };
    this.doFetch = options.fetch ?? (fetch as unknown as FetchLike);
    this.logger = options.logger;
    this.userAgent = options.userAgent ?? `payweave/${SDK_VERSION} (${options.provider})`;
    this.encodeBody = options.bodyEncoder ?? jsonBodyEncoder;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const rel = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseUrl + rel);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private log(event: Parameters<Logger>[0]): void {
    this.logger?.(event);
  }

  /**
   * Execute a request with auth, timeout, retry, and error mapping. On 2xx,
   * JSON-parses and (if `schema` given) `safeParse`s — drift is logged and the
   * raw JSON returned, never thrown.
   */
  async request<TRes = unknown>(opts: RequestOptions<TRes>): Promise<TRes> {
    const method = opts.method.toUpperCase();
    const url = this.buildUrl(opts.path, opts.query);
    const eligible = isRetryableRequest(method, opts.idempotencyKey);
    // Encode the body ONCE, outside the retry loop: every attempt re-sends the
    // exact same bytes, and a bodyEncoder is never re-invoked per attempt —
    // retries must be byte-identical even for a non-pure encoder.
    const encoded = opts.body !== undefined ? this.encodeBody(opts.body) : undefined;
    let attempt = 0;
    let did401Refresh = false;

    for (;;) {
      const headers = new Headers();
      headers.set("Accept", "application/json");
      headers.set("User-Agent", this.userAgent);
      if (encoded !== undefined) headers.set("Content-Type", encoded.contentType);
      if (opts.idempotencyKey) headers.set("Idempotency-Key", opts.idempotencyKey);

      const signal = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);

      let res: FetchResponse;
      try {
        // Auth is applied INSIDE the try so a failing token fetch (v4 OAuth
        // client-credentials) is subject to the retry policy and error mapping
        // instead of escaping raw and bypassing retry entirely.
        await this.auth.applyAuth({ headers });
        this.log({
          type: "request",
          provider: this.provider,
          method,
          url,
          attempt,
          headers: redact(headers),
          body: redact(opts.body),
        });
        res = await this.doFetch(url, {
          method,
          headers,
          ...(encoded !== undefined ? { body: encoded.body } : {}),
          signal,
        });
      } catch (err) {
        // A PayweaveError from applyAuth (a PayweaveAuthError, or a
        // PayweaveNetworkError from the token endpoint) is preserved as-is —
        // never re-wrapped, so a real auth failure isn't masked as a network
        // error. Only raw fetch/transport errors become PayweaveNetworkError.
        const known = err instanceof PayweaveError;
        const finalErr = known
          ? err
          : new PayweaveNetworkError(
              isAbortError(err)
                ? `Request to ${this.provider} timed out after ${opts.timeoutMs ?? this.timeoutMs}ms.`
                : `Network error contacting ${this.provider}.`,
              { provider: this.provider, cause: err },
            );
        if (eligible && finalErr.isRetryable && attempt < this.policy.maxRetries) {
          const delay = backoffDelay(attempt, this.policy);
          this.log({
            type: "retry",
            provider: this.provider,
            attempt,
            reason: known ? "auth" : "network",
            delay,
          });
          await sleep(delay);
          attempt += 1;
          continue;
        }
        this.log({ type: "error", provider: this.provider, error: finalErr.toJSON() });
        throw finalErr;
      }

      if (res.ok) {
        const json = await this.readJson(res);
        this.log({
          type: "response",
          provider: this.provider,
          status: res.status,
          body: redact(json),
        });
        if (opts.schema) {
          const parsed = opts.schema.safeParse(json);
          if (!parsed.success) {
            // Provider drift MUST NOT break consumers — log and pass raw through.
            this.log({
              type: "schema_drift",
              provider: this.provider,
              path: opts.path,
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            });
            return json as TRes;
          }
          return parsed.data;
        }
        return json as TRes;
      }

      // Non-2xx.
      const errorBody = await this.readJson(res);
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      // `request-id` is Stripe's spelling (https://docs.stripe.com/api/errors).
      const requestId =
        res.headers.get("x-request-id") ??
        res.headers.get("x-requestid") ??
        res.headers.get("request-id") ??
        undefined;

      // One forced-refresh retry on 401 for OAuth strategies (does not consume
      // a retry attempt — the token was simply stale).
      if (res.status === 401 && this.auth.refresh && !did401Refresh) {
        did401Refresh = true;
        this.log({ type: "retry", provider: this.provider, attempt, reason: "401-refresh" });
        await this.auth.refresh();
        continue;
      }

      if (isRetryableStatus(res.status) && eligible && attempt < this.policy.maxRetries) {
        const delay = retryAfterMs ?? backoffDelay(attempt, this.policy);
        this.log({
          type: "retry",
          provider: this.provider,
          attempt,
          reason: `status-${res.status}`,
          delay,
        });
        await sleep(delay);
        attempt += 1;
        continue;
      }

      const err = mapHttpError(this.provider, res.status, errorBody, {
        ...(retryAfterMs !== null ? { retryAfterMs } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
      this.log({ type: "error", provider: this.provider, error: err.toJSON() });
      throw err;
    }
  }

  private async readJson(res: FetchResponse): Promise<unknown> {
    const text = await res.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON body (HTML error page, etc.) — surface as a string.
      return text;
    }
  }
}
