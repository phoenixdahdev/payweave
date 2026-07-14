/**
 * PaystackClient — Surface A. Holds the shared {@link HttpClient} every Paystack
 * resource is built on and exposes each resource as a `public readonly` field.
 * The provider-narrowing facade wires `sdk.paystack` from these fields.
 */
import { HttpClient, bearer } from "../core/http";
import { defineProvider, readHeader, type ProviderAdapter } from "../core/provider";
import {
  PAYSTACK_BASE_URL,
  paystackProviderConfigSchema,
  inferEnvironment as inferEnvironmentFromKey,
  type ResolvedProviderConfig,
} from "../core/config";
import { PayweaveConfigError } from "../core/errors";
import { verifyPaystack } from "../webhooks/paystack";
import { toUnifiedEventType } from "../unified/mappings";
import { Transactions } from "./resources/transactions";
import { Refunds } from "./resources/refunds";
import { Customers } from "./resources/customers";
import { Misc } from "./resources/misc";
import { TransferRecipients } from "./resources/transfer-recipients";
import { Transfers } from "./resources/transfers";
import { Plans } from "./resources/plans";
import { Subscriptions } from "./resources/subscriptions";

export class PaystackClient {
  /** Shared HTTP client every resource is constructed with. */
  readonly http: HttpClient;

  /** Transactions: initialize, verify, list/iterate, fetch, charge auth, etc. */
  readonly transactions: Transactions;
  /** Refunds: create, list, fetch. */
  readonly refunds: Refunds;
  /** Customers: create, list, fetch, update, validate, risk action. */
  readonly customers: Customers;
  /** Verification / misc: banks, resolve account, countries, states, card BIN. */
  readonly misc: Misc;
  /** Transfer recipients: create, list, fetch. */
  readonly transferRecipients: TransferRecipients;
  /** Transfers: initiate, list, fetch, verify, balance. */
  readonly transfers: Transfers;
  /** Plans: create, list, fetch. */
  readonly plans: Plans;
  /** Subscriptions: create, list, fetch, enable, disable. */
  readonly subscriptions: Subscriptions;

  constructor(http: HttpClient) {
    this.http = http;
    this.transactions = new Transactions(this.http);
    this.refunds = new Refunds(this.http);
    this.customers = new Customers(this.http);
    this.misc = new Misc(this.http);
    this.transferRecipients = new TransferRecipients(this.http);
    this.transfers = new Transfers(this.http);
    this.plans = new Plans(this.http);
    this.subscriptions = new Subscriptions(this.http);
  }
}

// ── Provider adapter contract v2 ─────────────────────────────────────────────
// `paystackAdapter` is additive metadata: it does not (yet) replace the direct
// wiring in `src/index.ts` (`createPayweave` still builds `PaystackClient`
// straight from its resolved config, unchanged) — it PROVES the paystack
// surface satisfies the v2 `ProviderAdapter` contract via `configKey` +
// `configSchema`, so a config-key-registry style composition can be built on
// top later without any core edits.

function paystackHttp(cfg: ResolvedProviderConfig): HttpClient {
  if (!cfg.secretKey) {
    throw new PayweaveConfigError("Missing secret key for paystack.", { provider: "paystack" });
  }
  return new HttpClient({
    baseUrl: cfg.baseUrl,
    auth: bearer(cfg.secretKey),
    provider: "paystack",
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    fetch: cfg.fetch,
    logger: cfg.logger,
  });
}

/**
 * The Paystack v2 adapter descriptor. `unified`/`billing` are intentionally
 * left unset here: the real unified ops (`unified/paystack.ts`'s
 * `createPaystackUnified`) are HttpClient-BOUND factories wired directly by
 * `createPayweave`, and this static descriptor has no HttpClient instance to
 * bind them to; the billing slot is an unimplemented placeholder.
 */
export const paystackAdapter: ProviderAdapter = defineProvider({
  id: "paystack",
  configKey: "paystack",
  configSchema: paystackProviderConfigSchema,
  environments: {
    // One host for both — Paystack's environment is key-derived, not host-derived.
    test: { baseUrl: PAYSTACK_BASE_URL },
    live: { baseUrl: PAYSTACK_BASE_URL },
  },
  inferEnvironment: (secretKey) => {
    try {
      return inferEnvironmentFromKey("paystack", secretKey);
    } catch {
      return null;
    }
  },
  createHttp: paystackHttp,
  webhooks: {
    signatureHeader: "x-paystack-signature",
    verify: ({ rawBody, headers, secret }) =>
      verifyPaystack(rawBody, readHeader(headers, "x-paystack-signature"), secret),
    parse: (rawBody) => {
      const root = JSON.parse(rawBody) as Record<string, unknown>;
      return {
        type: typeof root.event === "string" ? root.event : "unknown",
        data: root.data,
        raw: root,
      };
    },
    toUnified: (e) => ({
      provider: "paystack",
      type: e.type,
      unifiedType: toUnifiedEventType("paystack", undefined, e.type, e.data),
      data: e.data,
      raw: e.raw,
    }),
  },
});
