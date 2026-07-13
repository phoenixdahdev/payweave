/**
 * FlutterwaveClient — Surface A. Holds the shared {@link HttpClient} and the
 * active `version`, and mounts the version-isolated resource surface (TDD §11:
 * v3 and v4 schemas are NEVER shared). Wave 3 mounts the **v3** resources; v4 is
 * a later wave. The provider-narrowing facade wires `sdk.flutterwave` from these
 * public fields.
 */
import { HttpClient, bearer, oauthClientCredentials } from "../core/http";
import { defineProvider, readHeader, type ProviderAdapter } from "../core/provider";
import {
  FLW_V3_BASE_URL,
  FLW_V4_BASE_URL,
  FLW_V4_SANDBOX_URL,
  flutterwaveProviderConfigSchema,
  inferEnvironment as inferEnvironmentFromKey,
  type ResolvedProviderConfig,
} from "../core/config";
import { PayweaveConfigError } from "../core/errors";
import { verifyFlutterwaveV3 } from "../webhooks/flutterwave";
import { verifyFlutterwaveV4 } from "../webhooks/flutterwave-v4";
import { toUnifiedEventType } from "../unified/mappings";
import { Payments } from "./v3/resources/payments";
import { Transactions } from "./v3/resources/transactions";
import { Banks } from "./v3/resources/banks";
import { Refunds } from "./v3/resources/refunds";
import { Charges } from "./v3/resources/charges";
import { Transfers } from "./v3/resources/transfers";
import { Beneficiaries } from "./v3/resources/beneficiaries";

export class FlutterwaveClient {
  /**
   * Shared HTTP client. Resource classes receive THIS instance:
   * `new Payments(this.http)`.
   */
  readonly http: HttpClient;

  /** Configured API generation — decides which resource surface is mounted. */
  readonly version: "v3" | "v4";

  // ── v3 resources (mounted when version === "v3") ─────────────────────────────
  /** Standard Payments: hosted checkout link (`data.link`). */
  readonly payments!: Payments;
  /** Transactions: verify by id / by tx_ref, list/iterate, fees. */
  readonly transactions!: Transactions;
  /** Banks + account resolution: list banks by country, branches, resolve. */
  readonly banks!: Banks;
  /** Refunds: create, list/iterate, fetch. */
  readonly refunds!: Refunds;
  /** Direct charges: card (3DES), bank transfer, USSD, NG account, validate. */
  readonly charges!: Charges;
  /** Transfers: create, list/iterate, fetch, fees. */
  readonly transfers!: Transfers;
  /** Transfer beneficiaries: create, list/iterate, fetch. */
  readonly beneficiaries!: Beneficiaries;

  /**
   * @param http - Shared HTTP client every resource is built on.
   * @param version - `"v3"` mounts the v3 surface; `"v4"` is a later wave.
   * @param encryptionKey - The v3 dashboard Encryption Key (from resolved
   *   config), consumed by `charges.card`. Optional so the facade can construct
   *   the client without it; card charges then require a per-call override.
   */
  constructor(http: HttpClient, version: "v3" | "v4", encryptionKey?: string) {
    this.http = http;
    this.version = version;

    // ── resources wired here in Wave 3 ─────────────────────────────────────
    // Version-isolated (TDD §11): mount v3 resources when version === "v3";
    // v4 resources land in a later wave (branch intentionally left empty).
    if (version === "v3") {
      this.payments = new Payments(this.http);
      this.transactions = new Transactions(this.http);
      this.banks = new Banks(this.http);
      this.refunds = new Refunds(this.http);
      this.charges = new Charges(this.http, encryptionKey);
      this.transfers = new Transfers(this.http);
      this.beneficiaries = new Beneficiaries(this.http);
    }
  }
}

// ── Provider adapter contract v2 (PW-608, providers.md §4) ──────────────────
// One adapter DEFINITION parameterized by `version` (AGENTS.md §11: v3/v4 stay
// isolated inside one adapter, never sharing schemas/webhook schemes) — additive
// metadata alongside the direct wiring in `src/index.ts` (unchanged). `unified`/
// `billing` are intentionally left unset for the same reason as the Paystack
// adapter: the real unified ops (`unified/flutterwave.ts`'s
// `createFlutterwaveUnified`) are HttpClient-bound factories with nowhere to
// live on a static descriptor; billing is an unimplemented PW-803/804 placeholder.

function flutterwaveHttp(cfg: ResolvedProviderConfig): HttpClient {
  if (cfg.version === "v4") {
    if (!cfg.clientId || !cfg.clientSecret || !cfg.tokenUrl) {
      throw new PayweaveConfigError(
        "Flutterwave v4 requires clientId, clientSecret, and a token URL.",
        { provider: "flutterwave" },
      );
    }
    return new HttpClient({
      baseUrl: cfg.baseUrl,
      auth: oauthClientCredentials({
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        tokenUrl: cfg.tokenUrl,
        ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
        ...(cfg.logger ? { logger: cfg.logger } : {}),
      }),
      provider: "flutterwave",
      version: "v4",
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
      fetch: cfg.fetch,
      logger: cfg.logger,
    });
  }
  if (!cfg.secretKey) {
    throw new PayweaveConfigError("Missing secret key for flutterwave.", { provider: "flutterwave" });
  }
  return new HttpClient({
    baseUrl: cfg.baseUrl,
    auth: bearer(cfg.secretKey),
    provider: "flutterwave",
    version: "v3",
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    fetch: cfg.fetch,
    logger: cfg.logger,
  });
}

type AdapterWebhooks = ProviderAdapter["webhooks"];

function flutterwaveWebhooks(version: "v3" | "v4"): AdapterWebhooks {
  if (version === "v4") {
    return {
      signatureHeader: "flutterwave-signature",
      verify: ({ rawBody, headers, secret }) =>
        verifyFlutterwaveV4(rawBody, readHeader(headers, "flutterwave-signature"), secret),
      parse: (rawBody) => {
        const root = JSON.parse(rawBody) as Record<string, unknown>;
        return {
          type: typeof root.type === "string" ? root.type : "unknown",
          data: root.data,
          raw: root,
          ...(typeof root.id === "string" ? { id: root.id } : {}),
        };
      },
      toUnified: (e) => ({
        provider: "flutterwave",
        type: e.type,
        unifiedType: toUnifiedEventType("flutterwave", "v4", e.type, e.data),
        data: e.data,
        raw: e.raw,
      }),
    };
  }
  return {
    signatureHeader: "verif-hash",
    verify: ({ headers, secret }) => verifyFlutterwaveV3(readHeader(headers, "verif-hash"), secret),
    parse: (rawBody) => {
      const root = JSON.parse(rawBody) as Record<string, unknown>;
      return {
        type: typeof root.event === "string" ? root.event : "unknown",
        data: root.data,
        raw: root,
      };
    },
    toUnified: (e) => ({
      provider: "flutterwave",
      type: e.type,
      unifiedType: toUnifiedEventType("flutterwave", "v3", e.type, e.data),
      data: e.data,
      raw: e.raw,
    }),
  };
}

/**
 * Build the Flutterwave v2 adapter descriptor for a given API generation.
 * `version` defaults to `"v3"` (the dashboard default, `core/config.ts` rule 6).
 */
export function createFlutterwaveAdapter(version: "v3" | "v4" = "v3"): ProviderAdapter {
  return defineProvider({
    id: "flutterwave",
    configKey: "flutterwave",
    configSchema: flutterwaveProviderConfigSchema,
    environments:
      version === "v4"
        ? { test: { baseUrl: FLW_V4_SANDBOX_URL }, live: { baseUrl: FLW_V4_BASE_URL } }
        : // v3: one host for both — environment is key-derived, not host-derived.
          { test: { baseUrl: FLW_V3_BASE_URL }, live: { baseUrl: FLW_V3_BASE_URL } },
    inferEnvironment: (secretKey) => {
      // v4's environment is explicit (never key-inferred) — "no opinion".
      if (version === "v4") return null;
      try {
        return inferEnvironmentFromKey("flutterwave", secretKey);
      } catch {
        return null;
      }
    },
    createHttp: flutterwaveHttp,
    webhooks: flutterwaveWebhooks(version),
  });
}

/** The dashboard-default (v3) Flutterwave adapter descriptor. */
export const flutterwaveAdapter: ProviderAdapter = createFlutterwaveAdapter("v3");
