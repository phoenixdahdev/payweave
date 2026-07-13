/**
 * PW-609 — Stripe contract quickstart (docs/v1/providers.md §6): checkout →
 * verify → refund → webhook, driven against REAL `api.stripe.com` test mode.
 *
 * ## Guard: this entire suite is SKIPPED, not failed, without a secret
 * The whole `describe` below is wrapped in `describe.skipIf(!hasSecret)` —
 * `STRIPE_TEST_SECRET` is read once at module load. Locally (and in every PR
 * check) that env var is absent, so vitest reports these as SKIPPED and the
 * local/PR gate stays green with zero network access required.
 * `.github/workflows/contract.yml` is the only place this runs for real
 * (nightly cron + manual dispatch, `STRIPE_TEST_SECRET` from repo secrets —
 * never a per-PR gate, so a Stripe outage can never block a merge).
 *
 * ## Guard: refuse a live-shaped key before any request
 * If the secret IS present but doesn't look like a test-mode key
 * (`sk_test_`/`rk_test_` prefix), `beforeAll` throws — loudly, before any
 * network call — rather than silently running the quickstart (which creates
 * a real charge + refund) against what could be a live account
 * (AGENTS.md §2.5, epic-06 brief's "guard the key class" note).
 *
 * ## Why this drives Surface A, not unified `checkout.create`/`verify`/`refunds.create`
 * `src/unified/stripe.ts` (PW-608's job — docs/v1/implementation/status.md
 * marks PW-608 🔶, not yet merged) has not shipped: calling
 * `payweave.checkout.create({ provider: "stripe" })` today rejects with an
 * explicit "supported in principle but not implemented yet" error
 * (`src/index.ts`'s `stripeUnifiedNamespace`). This ticket's own scope rule —
 * "this ticket proves, it doesn't patch; real-world breakage becomes an issue
 * for the owning ticket's area" (`src/**` is forbidden here) — means this
 * quickstart drives the resource methods that DO exist today
 * (`payweave.stripe.checkout.sessions`, `.paymentIntents`, `.refunds`) and
 * normalizes their statuses through the SAME `unified/mappings.ts` functions
 * the unified ops will eventually call (`toUnifiedStatus`) — so the mapping
 * table itself is still exercised against real Stripe responses even though
 * the unified wiring above it is not ready. Once PW-608 lands, swap the
 * calls below for `payweave.checkout.create`/`verify`/`refunds.create` — the
 * assertions on normalized status should not need to change.
 *
 * The webhook leg normalizes through PW-607's `STRIPE_EVENT_MAP` tables:
 * since PW-608 rewired `constructEvent`, a mapped Stripe event carries its
 * real unified type (unmapped events still fall through to `"unknown"`).
 *
 * ## Simulating a completed payment without a browser
 * A Checkout Session's hosted page can't be driven headlessly from a test
 * runner. Stripe's own testing docs (https://docs.stripe.com/testing#cards)
 * document special PaymentMethod tokens — `pm_card_visa` here — that
 * confirm a PaymentIntent successfully via the API alone, in test mode only.
 * This quickstart uses that technique to reach a real `succeeded`
 * PaymentIntent (the session's own underlying PI, referenced by
 * `session.payment_intent`) that `refunds.create` can then round-trip,
 * without ever opening a browser.
 *
 * ## The webhook leg needs no public URL or provisioned endpoint
 * We never call `webhookEndpoints.create` (that would leave litter — a live
 * registered endpoint — in the test account on every scheduled run). Instead
 * the event payload is built from the REAL object `paymentIntents.retrieve`
 * returns above, signed locally with `signWebhook("stripe", ...)` using a
 * secret THIS TEST chooses (never Stripe-issued — verification only needs
 * both sides to agree on the same secret), and fed through the exact
 * `payweave.webhooks.constructEvent` dispatch a real endpoint would use.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { createPayweave } from "../src/index";
import { signWebhook } from "../src/testing/sign-webhook";
import { toUnifiedStatus } from "../src/unified/mappings";
import { generateReference } from "../src/unified/reference";

const STRIPE_TEST_SECRET = process.env.STRIPE_TEST_SECRET;
const hasSecret = typeof STRIPE_TEST_SECRET === "string" && STRIPE_TEST_SECRET.length > 0;

// Chosen by THIS test, never Stripe-issued — see the module doc's webhook
// section. Only used to sign+verify the fabricated event below.
const LOCAL_WEBHOOK_SECRET = "whsec_pw609_e2e_local_only_not_from_stripe";

describe.skipIf(!hasSecret)("Stripe contract quickstart (PW-609, providers.md §6)", () => {
  // NOTE: the client is built lazily inside `beforeAll`, never at the
  // `describe` body's top level — vitest still SYNCHRONOUSLY EXECUTES the
  // describe callback (to register its `it`s) even when `skipIf` marks every
  // test inside skipped; `beforeAll`/`afterAll` are what actually get skipped
  // along with the tests. Building `createPayweave({ stripe: { secretKey } })`
  // at the top level would crash on the (expected, local) `undefined` secret
  // before `skipIf` ever gets a chance to matter.
  let payweave: ReturnType<
    typeof createPayweave<{
      stripe: { secretKey: string; webhookSecret: string };
    }>
  >;

  beforeAll(() => {
    const secret = STRIPE_TEST_SECRET;
    // Defensive re-check even though `describe.skipIf` already gated on
    // presence — this is the "before ANY request" hard-fail AGENTS.md §2.5
    // asks for, kept independent of the skip guard above.
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("STRIPE_TEST_SECRET is required to run the Stripe contract quickstart.");
    }
    if (!secret.startsWith("sk_test_") && !secret.startsWith("rk_test_")) {
      throw new Error(
        "STRIPE_TEST_SECRET must be a TEST-mode key ('sk_test_' or 'rk_test_' prefix) — refusing to run " +
          "the contract quickstart (it creates a real charge + refund) against what looks like a live key.",
      );
    }
    payweave = createPayweave({
      stripe: { secretKey: secret, webhookSecret: LOCAL_WEBHOOK_SECRET },
    });
  });

  let sessionId: string;
  let paymentIntentId: string;

  it("checkout: creates a live Checkout Session with a real checkoutUrl (§6 bullet 1)", async () => {
    const reference = generateReference();
    const session = await payweave.stripe.checkout.sessions.create({
      mode: "payment",
      // Pinned to "card" so the session's underlying PaymentIntent only ever
      // accepts a card PaymentMethod — makes the next step's
      // `pm_card_visa` confirmation deterministic (no other method type to
      // negotiate).
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 1000,
            product_data: { name: "PW-609 contract quickstart" },
          },
        },
      ],
      client_reference_id: reference,
      metadata: { pwv_reference: reference },
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
    });

    expect(session.id).toMatch(/^cs_test_/);
    expect(session.url).toBeTruthy();
    expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(session.client_reference_id).toBe(reference);
    expect(typeof session.payment_intent).toBe("string");

    sessionId = session.id;
    paymentIntentId = session.payment_intent as string;
  });

  it("verify: retrieves the session and normalizes its (still-open) status (§6 bullet 1)", async () => {
    const session = await payweave.stripe.checkout.sessions.retrieve(sessionId);
    expect(session.status).toBe("open");
    expect(toUnifiedStatus("stripe", undefined, session.payment_status ?? "unpaid")).toBe(
      "pending",
    );
  });

  it("simulates a completed payment via the session's own PaymentIntent (see module doc)", async () => {
    const pi = await payweave.stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: "pm_card_visa",
    });

    expect(pi.status).toBe("succeeded");
    expect(toUnifiedStatus("stripe", undefined, pi.status ?? "")).toBe("success");
  });

  it("refund: rounds a refund against the payment intent (§6 bullet 1)", async () => {
    const refund = await payweave.stripe.refunds.create(
      { payment_intent: paymentIntentId, reason: "requested_by_customer" },
      { idempotencyKey: `pw609-e2e-refund-${paymentIntentId}` },
    );

    expect(refund.payment_intent).toBe(paymentIntentId);
    expect(["succeeded", "pending"]).toContain(refund.status);
  });

  it("webhook: signs a real payment_intent.succeeded event and dispatches it through payweave.webhooks (§6 bullet 3)", async () => {
    const pi = await payweave.stripe.paymentIntents.retrieve(paymentIntentId);
    const event = {
      id: `evt_${randomUUID().replace(/-/g, "")}`,
      object: "event",
      type: "payment_intent.succeeded",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: pi },
    };

    const { body, headers } = signWebhook("stripe", event, LOCAL_WEBHOOK_SECRET);
    const result = payweave.webhooks.constructEvent({
      rawBody: body,
      headers,
    });

    expect(result.provider).toBe("stripe");
    expect(result.type).toBe("payment_intent.succeeded");
    // Since PW-608, `constructEvent` normalizes stripe events through PW-607's
    // `STRIPE_EVENT_MAP`, so a mapped event carries its real unified type.
    expect(result.unifiedType).toBe("payment.succeeded");
    expect(result.dedupeKey).toBe(event.id);
  });

  it("rejects a Stripe-signed webhook against a client without stripe configured (§6 bullet 3)", () => {
    const unconfigured = createPayweave({
      paystack: { secretKey: "sk_test_pw609_unrelated" },
    });
    const event = {
      id: "evt_pw609_unused",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: {} },
    };
    const { body, headers } = signWebhook("stripe", event, LOCAL_WEBHOOK_SECRET);

    expect(() => unconfigured.webhooks.constructEvent({ rawBody: body, headers })).toThrow(
      /stripe is not configured/,
    );
  });

  it("capability gap: transfers.create throws the typed capability error on stripe (§6 bullet 4)", async () => {
    await expect(
      payweave.transfers.create({
        amount: 1000,
        currency: "usd",
        recipient: { accountNumber: "0000000000", bankCode: "000" },
      }),
    ).rejects.toThrow(/transfers are not supported on stripe/);
  });
});
