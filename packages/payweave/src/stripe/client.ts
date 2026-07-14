/**
 * StripeClient — Surface A for the `stripe` config key
 * (`payweave.stripe.*`, providers.md §3.2). Holds the provider's shared
 * {@link HttpClient} (constructed from PW-601's `stripeHttpOptions`:
 * form-encoded bodies, pinned `Stripe-Version`) and exposes each resource as
 * a `public readonly` field, exactly like the Paystack and Flutterwave
 * clients.
 *
 * Mounted: checkout.sessions + paymentIntents, customers/products/
 * prices, subscriptions + subscriptionItems, refunds +
 * webhookEndpoints — the complete P0 module table.
 */
import { HttpClient } from "../core/http";
import { defineProvider, readHeader, type ProviderAdapter } from "../core/provider";
import {
  STRIPE_BASE_URL,
  stripeProviderConfigSchema,
  inferEnvironment as inferEnvironmentFromKey,
  type ResolvedProviderConfig,
} from "../core/config";
import { verifyStripe } from "../webhooks/stripe";
import { toUnifiedEventType } from "../unified/mappings";
import { stripeHttpOptions } from "./http-options";
import { CheckoutSessions } from "./resources/checkout-sessions";
import { Customers } from "./resources/customers";
import { PaymentIntents } from "./resources/payment-intents";
import { Prices } from "./resources/prices";
import { Products } from "./resources/products";
import { Refunds } from "./resources/refunds";
import { SubscriptionItems } from "./resources/subscription-items";
import { Subscriptions } from "./resources/subscriptions";
import { WebhookEndpoints } from "./resources/webhook-endpoints";

/**
 * The `payweave.stripe.checkout.*` namespace — mirrors Stripe's own API
 * grouping (`/v1/checkout/sessions`, https://docs.stripe.com/api/checkout/sessions).
 */
export interface StripeCheckoutNamespace {
  /** Checkout Sessions: create, retrieve, list/iterate, expire, lineItems. */
  readonly sessions: CheckoutSessions;
}

export class StripeClient {
  /** Shared HTTP client every Stripe resource is constructed with. */
  readonly http: HttpClient;

  /** Checkout namespace (`payweave.stripe.checkout.sessions.create(...)`). */
  readonly checkout: StripeCheckoutNamespace;
  /** PaymentIntents: create, retrieve, confirm, capture, cancel, list/iterate. */
  readonly paymentIntents: PaymentIntents;
  /** Customers: create, retrieve, update, delete, list/iterate, search/iterateSearch. */
  readonly customers: Customers;
  /** Products: create, retrieve, update, delete, list/iterate, search/iterateSearch. */
  readonly products: Products;
  /** Prices: create, retrieve, update, list/iterate, search/iterateSearch (no delete — prices are archived). */
  readonly prices: Prices;
  /** Subscriptions: create, retrieve, update, cancel, resume, list/iterate. */
  readonly subscriptions: Subscriptions;
  /** SubscriptionItems: create, retrieve, update, delete, list/iterate. */
  readonly subscriptionItems: SubscriptionItems;
  /** Refunds: create (idempotencyKey), retrieve, update, cancel, list/iterate. */
  readonly refunds: Refunds;
  /** WebhookEndpoints: create (secret shown ONCE), retrieve, update, delete, list/iterate. */
  readonly webhookEndpoints: WebhookEndpoints;

  constructor(http: HttpClient) {
    this.http = http;
    this.checkout = { sessions: new CheckoutSessions(this.http) };
    this.paymentIntents = new PaymentIntents(this.http);
    this.customers = new Customers(this.http);
    this.products = new Products(this.http);
    this.prices = new Prices(this.http);
    this.subscriptions = new Subscriptions(this.http);
    this.subscriptionItems = new SubscriptionItems(this.http);
    this.refunds = new Refunds(this.http);
    this.webhookEndpoints = new WebhookEndpoints(this.http);
  }
}

// ── Provider adapter contract v2 (PW-608, providers.md §4) ──────────────────
// `stripeAdapter` is additive metadata alongside the direct wiring in
// `src/index.ts` (`createPayweave` still builds `StripeClient` via
// `stripeHttpOptions` directly, unchanged). `createHttp` below REUSES
// `stripeHttpOptions` so the form-encoded body transport and
// `Stripe-Version`/`Stripe-Account` headers are byte-identical to the real
// wiring, not a re-implementation. `unified`/`billing` are intentionally left
// unset: the real unified ops are HttpClient-bound (and, for stripe, not
// implemented yet — `stripeUnifiedNamespace` in `src/index.ts`); billing is an
// unimplemented PW-803/804 placeholder.

function stripeHttp(cfg: ResolvedProviderConfig): HttpClient {
  return new HttpClient(stripeHttpOptions(cfg));
}

export const stripeAdapter: ProviderAdapter = defineProvider({
  id: "stripe",
  configKey: "stripe",
  configSchema: stripeProviderConfigSchema,
  environments: {
    // One host for both — Stripe's environment is key-derived, not host-derived.
    test: { baseUrl: STRIPE_BASE_URL },
    live: { baseUrl: STRIPE_BASE_URL },
  },
  inferEnvironment: (secretKey) => {
    try {
      return inferEnvironmentFromKey("stripe", secretKey);
    } catch {
      return null;
    }
  },
  createHttp: stripeHttp,
  webhooks: {
    signatureHeader: "stripe-signature",
    verify: ({ rawBody, headers, secret }) =>
      verifyStripe(rawBody, readHeader(headers, "stripe-signature"), secret),
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
      provider: "stripe",
      type: e.type,
      unifiedType: toUnifiedEventType("stripe", undefined, e.type, e.data),
      data: e.data,
      raw: e.raw,
    }),
  },
});
