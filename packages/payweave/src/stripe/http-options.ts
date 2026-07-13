/**
 * Stripe HttpClient construction pieces (PW-601): auth strategy + fully-wired
 * `HttpClientOptions`. PW-602's `StripeClient` consumes {@link stripeHttpOptions}
 * so every Stripe request carries the right headers and the form-encoded body
 * transport — no JSON body ever leaves the Stripe client (providers.md §3.1).
 */
import { STRIPE_API_VERSION, type ResolvedProviderConfig } from "../core/config";
import { PayweaveConfigError } from "../core/errors";
import type { AuthStrategy, HttpClientOptions } from "../core/http";
import { encodeStripeForm } from "./form-encoding";

/** Options for {@link stripeAuth}. */
export interface StripeAuthOptions {
  /** Standard (`sk_test_`/`sk_live_`) or restricted (`rk_test_`/`rk_live_`) secret key. */
  secretKey: string;
  /** Overrides the SDK-pinned {@link STRIPE_API_VERSION} for the `Stripe-Version` header. */
  apiVersion?: string | undefined;
  /** Connect platforms — connected account id (`acct_*`) for the `Stripe-Account` header. */
  accountId?: string | undefined;
}

/**
 * Stripe auth strategy: sets Stripe's per-request identity + versioning
 * headers together on every attempt.
 *
 * - `Authorization: Bearer sk_...` — bearer auth per
 *   https://docs.stripe.com/api/authentication (verified 2026-07-12; Stripe
 *   documents basic auth with the key as username and bearer auth as
 *   equivalent — we use bearer, matching the other Payweave providers).
 * - `Stripe-Version: <pinned>` — pins the API version on EVERY request so
 *   provider-side version drift cannot change payload shapes under us
 *   (https://docs.stripe.com/api/versioning — verified 2026-07-12). Defaults
 *   to {@link STRIPE_API_VERSION}; overridable via `stripe.apiVersion`.
 * - `Stripe-Account: acct_...` — only when `accountId` is configured; makes
 *   calls act on that connected account
 *   (https://docs.stripe.com/connect/authentication — verified 2026-07-12).
 */
export function stripeAuth(opts: StripeAuthOptions): AuthStrategy {
  const version = opts.apiVersion ?? STRIPE_API_VERSION;
  return {
    async applyAuth(init) {
      init.headers.set("Authorization", `Bearer ${opts.secretKey}`);
      init.headers.set("Stripe-Version", version);
      if (opts.accountId !== undefined) {
        init.headers.set("Stripe-Account", opts.accountId);
      }
    },
  };
}

/**
 * Build the `HttpClientOptions` for a Stripe `HttpClient` from a resolved
 * provider config: base URL + transport options pass through, auth is
 * {@link stripeAuth}, and the body encoder is {@link encodeStripeForm}
 * (`application/x-www-form-urlencoded` — Stripe rejects JSON bodies).
 *
 * @example
 * const resolved = resolvePayweaveConfig({ stripe: { secretKey: "sk_test_..." } });
 * const http = new HttpClient(stripeHttpOptions(resolved.providerConfigs.stripe!));
 */
export function stripeHttpOptions(resolved: ResolvedProviderConfig): HttpClientOptions {
  if (resolved.provider !== "stripe") {
    throw new PayweaveConfigError(
      `stripeHttpOptions received a "${resolved.provider}" config — expected provider "stripe".`,
      { provider: "stripe" },
    );
  }
  if (resolved.secretKey === undefined) {
    // Unreachable via resolvePayweaveConfig (the stripe schema requires
    // secretKey); guards hand-built ResolvedProviderConfig objects.
    throw new PayweaveConfigError("Stripe config resolved without a secretKey.", {
      provider: "stripe",
    });
  }
  return {
    baseUrl: resolved.baseUrl,
    provider: "stripe",
    auth: stripeAuth({
      secretKey: resolved.secretKey,
      apiVersion: resolved.apiVersion,
      accountId: resolved.accountId,
    }),
    bodyEncoder: encodeStripeForm,
    timeoutMs: resolved.timeoutMs,
    maxRetries: resolved.maxRetries,
    fetch: resolved.fetch,
    logger: resolved.logger,
  };
}
