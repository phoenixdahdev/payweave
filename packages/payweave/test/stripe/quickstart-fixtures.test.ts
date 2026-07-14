/**
 * Stripe quickstart fixture contract. These fixtures
 * (`test/fixtures/stripe/quickstart/*.json`) are a single coherent chain
 * (same checkout session / payment intent / charge / refund ids threaded
 * through every file) recorded to model the real shapes the CI-only
 * `e2e/stripe-quickstart.e2e.ts` exercises against live Stripe test mode
 * (checkout → verify → refund → webhook, providers.md §6). Unlike the e2e
 * suite, this test needs no secret and always runs as part of the normal
 * gate — it is the offline half of the contract: prove the mapping tables
 * and the webhook sign/verify/dispatch pipeline handle these exact shapes,
 * without a network call.
 */
import { describe, expect, it } from "vitest";

import { createPayweave } from "../../src/index";
import { signWebhook } from "../../src/testing/sign-webhook";
import { loadFixtureAs } from "../../src/testing/fixtures";
import { toUnifiedStatus, toUnifiedEventType } from "../../src/unified/mappings";

interface CheckoutSessionFixture {
  id: string;
  status: string | null;
  payment_status: string;
  payment_intent: string;
  url: string | null;
  metadata: Record<string, string>;
}

interface PaymentIntentFixture {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  latest_charge: string;
}

interface RefundFixture {
  id: string;
  status: string;
  payment_intent: string;
  amount: number;
}

interface WebhookEventFixture {
  id: string;
  type: string;
  data: { object: PaymentIntentFixture };
}

const load = <T>(name: string): T => loadFixtureAs<T>("stripe", "quickstart", name);

describe("Stripe quickstart fixtures (providers.md §6 shapes)", () => {
  it("checkout-session.create: open + unpaid normalizes to pending", () => {
    const session = load<CheckoutSessionFixture>("checkout-session.create");
    expect(session.status).toBe("open");
    expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(toUnifiedStatus("stripe", undefined, session.payment_status)).toBe("pending");
  });

  it("checkout-session.paid: complete + paid normalizes to success, url is null", () => {
    const session = load<CheckoutSessionFixture>("checkout-session.paid");
    expect(session.status).toBe("complete");
    expect(session.url).toBeNull();
    expect(toUnifiedStatus("stripe", undefined, session.payment_status)).toBe("success");
  });

  it("payment-intent.succeeded: same payment_intent id the session references, full amount received", () => {
    const session = load<CheckoutSessionFixture>("checkout-session.paid");
    const pi = load<PaymentIntentFixture>("payment-intent.succeeded");
    expect(pi.id).toBe(session.payment_intent);
    expect(pi.amount_received).toBe(pi.amount);
    expect(toUnifiedStatus("stripe", undefined, pi.status)).toBe("success");
  });

  it("refund.succeeded: targets the same payment intent, full-amount round trip", () => {
    const pi = load<PaymentIntentFixture>("payment-intent.succeeded");
    const refund = load<RefundFixture>("refund.succeeded");
    expect(refund.payment_intent).toBe(pi.id);
    expect(refund.amount).toBe(pi.amount);
    expect(refund.status).toBe("succeeded");
  });

  it("webhook-event: wraps the same payment intent one level down (data.object)", () => {
    const pi = load<PaymentIntentFixture>("payment-intent.succeeded");
    const event = load<WebhookEventFixture>("webhook-event.payment-intent-succeeded");
    expect(event.data.object.id).toBe(pi.id);
    expect(toUnifiedEventType("stripe", undefined, event.type)).toBe("payment.succeeded");
  });

  it("the webhook event fixture round-trips through sign → verify → constructEvent", () => {
    const event = load<WebhookEventFixture>("webhook-event.payment-intent-succeeded");
    const webhookSecret = "whsec_quickstart_fixture_local_only";
    const payweave = createPayweave({
      stripe: { secretKey: "sk_test_quickstart_fixture", webhookSecret },
    });

    const { body, headers } = signWebhook("stripe", event, webhookSecret);
    const result = payweave.webhooks.constructEvent({ rawBody: body, headers });

    expect(result.provider).toBe("stripe");
    expect(result.type).toBe("payment_intent.succeeded");
    // PW-608 rewired `constructEvent` to normalize stripe events through
    // PW-607's `STRIPE_EVENT_MAP` tables (`unified/mappings.ts`), so a mapped
    // event now carries its real unified type (unmapped stripe events still
    // fall through to `"unknown"`). Updated at integration when PW-608 landed.
    expect(result.unifiedType).toBe("payment.succeeded");
    // dedupeKey is unaffected by the gap above — stripe's dedupe key is always
    // the native `evt_*` id (src/webhooks/index.ts's computeDedupeKey), independent
    // of unifiedType normalization.
    expect(result.dedupeKey).toBe(event.id);
  });

  it("a tampered webhook body fails verification (fixture used as the valid baseline)", () => {
    const event = load<WebhookEventFixture>("webhook-event.payment-intent-succeeded");
    const webhookSecret = "whsec_quickstart_fixture_local_only";
    const payweave = createPayweave({
      stripe: { secretKey: "sk_test_quickstart_fixture", webhookSecret },
    });

    const { body, headers } = signWebhook("stripe", event, webhookSecret);
    expect(payweave.webhooks.verify({ rawBody: `${body}x`, headers })).toBe(false);
  });
});
