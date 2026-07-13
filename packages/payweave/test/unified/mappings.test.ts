import { describe, expect, it, vi } from "vitest";
import {
  toUnifiedEventType,
  toUnifiedStatus,
  PAYSTACK_EVENT_MAP,
  FLUTTERWAVE_EVENT_MAP,
  STRIPE_EVENT_MAP,
  STRIPE_EVENT_STATUS_SPLIT_MAP,
  PAYSTACK_STATUS_MAP,
  FLUTTERWAVE_V3_STATUS_MAP,
  FLUTTERWAVE_V4_STATUS_MAP,
  STRIPE_STATUS_MAP,
  type UnifiedEventType,
  type UnifiedStatus,
} from "../../src/unified/mappings";

describe("toUnifiedEventType — Paystack (status-independent)", () => {
  const cases: Array<[string, UnifiedEventType]> = [
    ["charge.success", "payment.succeeded"],
    ["transfer.success", "transfer.succeeded"],
    ["transfer.failed", "transfer.failed"],
    ["transfer.reversed", "transfer.reversed"],
    ["refund.processed", "refund.processed"],
    ["subscription.create", "subscription.created"],
    ["subscription.disable", "subscription.canceled"],
    ["subscription.not_renew", "subscription.updated"],
    ["invoice.update", "invoice.paid"],
    ["invoice.payment_failed", "invoice.payment_failed"],
    ["charge.dispute.create", "dispute.created"],
    ["invoice.create", "unknown"],
    ["totally.made.up", "unknown"],
  ];
  it.each(cases)("%s → %s", (native, expected) => {
    expect(toUnifiedEventType("paystack", undefined, native)).toBe(expected);
  });

  it("covers every row of PAYSTACK_EVENT_MAP exhaustively", () => {
    for (const [native, expected] of Object.entries(PAYSTACK_EVENT_MAP)) {
      expect(toUnifiedEventType("paystack", undefined, native)).toBe(expected);
    }
  });
});

describe("toUnifiedEventType — Flutterwave status splits (v3 vs v4)", () => {
  it("v3 charge.completed splits on successful/failed", () => {
    expect(
      toUnifiedEventType("flutterwave", "v3", "charge.completed", { status: "successful" }),
    ).toBe("payment.succeeded");
    expect(
      toUnifiedEventType("flutterwave", "v3", "charge.completed", { status: "failed" }),
    ).toBe("payment.failed");
  });

  it("v4 charge.completed splits on succeeded/failed (v4 vocabulary)", () => {
    expect(
      toUnifiedEventType("flutterwave", "v4", "charge.completed", { status: "succeeded" }),
    ).toBe("payment.succeeded");
    // v3 'successful' is NOT a v4 success string → unknown outcome
    expect(
      toUnifiedEventType("flutterwave", "v4", "charge.completed", { status: "successful" }),
    ).toBe("unknown");
  });

  it("transfer.completed splits likewise", () => {
    expect(
      toUnifiedEventType("flutterwave", "v3", "transfer.completed", { status: "successful" }),
    ).toBe("transfer.succeeded");
    expect(
      toUnifiedEventType("flutterwave", "v3", "transfer.completed", { status: "failed" }),
    ).toBe("transfer.failed");
    expect(
      toUnifiedEventType("flutterwave", "v4", "transfer.completed", { status: "succeeded" }),
    ).toBe("transfer.succeeded");
  });

  it("split event with a pending/missing status → unknown (never a false success)", () => {
    expect(
      toUnifiedEventType("flutterwave", "v3", "charge.completed", { status: "pending" }),
    ).toBe("unknown");
    expect(toUnifiedEventType("flutterwave", "v3", "charge.completed", {})).toBe("unknown");
    expect(toUnifiedEventType("flutterwave", "v3", "charge.completed")).toBe("unknown");
  });

  it("unmapped FLW event → unknown (never dropped)", () => {
    expect(toUnifiedEventType("flutterwave", "v3", "some.new.event", { status: "successful" })).toBe(
      "unknown",
    );
  });
});

describe("toUnifiedEventType — Flutterwave (status-independent)", () => {
  const cases: Array<[string, UnifiedEventType]> = [
    ["refund.completed", "refund.processed"],
    ["subscription.cancelled", "subscription.canceled"],
    ["chargeback.initiated", "dispute.created"],
    ["chargeback.declined", "unknown"],
    ["invoice.paid", "unknown"],
  ];
  it.each(cases)("%s → %s", (native, expected) => {
    expect(toUnifiedEventType("flutterwave", "v3", native)).toBe(expected);
  });

  it("is shared as-is across v3 and v4 (event NAMES don't differ by version)", () => {
    expect(toUnifiedEventType("flutterwave", "v4", "refund.completed")).toBe("refund.processed");
    expect(toUnifiedEventType("flutterwave", "v4", "subscription.cancelled")).toBe(
      "subscription.canceled",
    );
  });

  it("covers every row of FLUTTERWAVE_EVENT_MAP exhaustively", () => {
    for (const [native, expected] of Object.entries(FLUTTERWAVE_EVENT_MAP)) {
      expect(toUnifiedEventType("flutterwave", "v3", native)).toBe(expected);
    }
  });
});

describe("toUnifiedEventType — Stripe (status-independent rows)", () => {
  const cases: Array<[string, UnifiedEventType]> = [
    ["payment_intent.succeeded", "payment.succeeded"],
    ["checkout.session.async_payment_succeeded", "payment.succeeded"],
    ["payment_intent.payment_failed", "payment.failed"],
    ["checkout.session.async_payment_failed", "payment.failed"],
    ["charge.refunded", "refund.processed"],
    ["customer.subscription.created", "subscription.created"],
    ["customer.subscription.updated", "subscription.updated"],
    ["customer.subscription.deleted", "subscription.canceled"],
    ["invoice.paid", "invoice.paid"],
    ["invoice.payment_succeeded", "invoice.paid"],
    ["invoice.payment_failed", "invoice.payment_failed"],
    ["charge.dispute.created", "dispute.created"],
    ["checkout.session.expired", "unknown"],
    ["some.made.up.event", "unknown"],
  ];
  it.each(cases)("%s → %s", (native, expected) => {
    expect(toUnifiedEventType("stripe", undefined, native)).toBe(expected);
  });

  it("covers every row of STRIPE_EVENT_MAP exhaustively", () => {
    for (const [native, expected] of Object.entries(STRIPE_EVENT_MAP)) {
      expect(toUnifiedEventType("stripe", undefined, native)).toBe(expected);
    }
  });
});

describe("toUnifiedEventType — Stripe status splits (data.object, not flat data)", () => {
  it("checkout.session.completed: payment_status 'paid' → payment.succeeded", () => {
    expect(
      toUnifiedEventType("stripe", undefined, "checkout.session.completed", {
        object: { payment_status: "paid" },
      }),
    ).toBe("payment.succeeded");
  });

  it("checkout.session.completed: payment_status 'no_payment_required' → payment.succeeded ($0 checkout)", () => {
    expect(
      toUnifiedEventType("stripe", undefined, "checkout.session.completed", {
        object: { payment_status: "no_payment_required" },
      }),
    ).toBe("payment.succeeded");
  });

  it("checkout.session.completed: payment_status 'unpaid' (delayed payment method) → unknown, NOT succeeded", () => {
    expect(
      toUnifiedEventType("stripe", undefined, "checkout.session.completed", {
        object: { payment_status: "unpaid" },
      }),
    ).toBe("unknown");
  });

  it("refund.updated: status 'succeeded' → refund.processed", () => {
    expect(
      toUnifiedEventType("stripe", undefined, "refund.updated", {
        object: { status: "succeeded" },
      }),
    ).toBe("refund.processed");
  });

  it.each(["pending", "requires_action", "failed", "canceled"])(
    "refund.updated: status '%s' → unknown, NEVER a false refund.processed",
    (status) => {
      expect(
        toUnifiedEventType("stripe", undefined, "refund.updated", { object: { status } }),
      ).toBe("unknown");
    },
  );

  it("missing/malformed data.object → unknown (never throws)", () => {
    expect(toUnifiedEventType("stripe", undefined, "checkout.session.completed")).toBe("unknown");
    expect(toUnifiedEventType("stripe", undefined, "checkout.session.completed", {})).toBe(
      "unknown",
    );
    expect(
      toUnifiedEventType("stripe", undefined, "checkout.session.completed", { object: null }),
    ).toBe("unknown");
    expect(
      toUnifiedEventType("stripe", undefined, "checkout.session.completed", {
        object: { payment_status: 42 },
      }),
    ).toBe("unknown");
  });

  it("covers every row of STRIPE_EVENT_STATUS_SPLIT_MAP with its matching value(s)", () => {
    for (const [native, split] of Object.entries(STRIPE_EVENT_STATUS_SPLIT_MAP)) {
      for (const value of split.matches) {
        expect(
          toUnifiedEventType("stripe", undefined, native, { object: { [split.field]: value } }),
        ).toBe(split.unifiedType);
      }
    }
  });
});

describe("toUnifiedStatus — exhaustive per-provider vocabularies", () => {
  const paystack: Array<[string, UnifiedStatus]> = [
    ["success", "success"],
    ["failed", "failed"],
    ["pending", "pending"],
    ["ongoing", "pending"],
    ["processing", "pending"],
    ["queued", "pending"],
    ["abandoned", "abandoned"],
    ["reversed", "reversed"],
  ];
  it.each(paystack)("paystack %s → %s", (native, expected) => {
    expect(toUnifiedStatus("paystack", undefined, native)).toBe(expected);
  });

  it("v3 uses 'successful', v4 uses 'succeeded'", () => {
    expect(toUnifiedStatus("flutterwave", "v3", "successful")).toBe("success");
    expect(toUnifiedStatus("flutterwave", "v4", "succeeded")).toBe("success");
    // cross-version strings must NOT normalize to success
    expect(toUnifiedStatus("flutterwave", "v4", "successful")).toBe("pending");
    expect(toUnifiedStatus("flutterwave", "v3", "succeeded")).toBe("pending");
  });

  const stripe: Array<[string, UnifiedStatus]> = [
    // Checkout Session `payment_status`
    ["paid", "success"],
    ["no_payment_required", "success"],
    ["unpaid", "pending"],
    // Checkout Session `status` (payment-outcome-relevant subset — see mappings.ts note)
    ["open", "pending"],
    ["expired", "abandoned"],
    // PaymentIntent `status`
    ["succeeded", "success"],
    ["processing", "pending"],
    ["requires_action", "pending"],
    ["requires_confirmation", "pending"],
    ["requires_payment_method", "pending"],
    ["requires_capture", "pending"],
    ["canceled", "abandoned"],
  ];
  it.each(stripe)("stripe %s → %s", (native, expected) => {
    expect(toUnifiedStatus("stripe", undefined, native)).toBe(expected);
  });

  it("stripe: session status 'complete' is deliberately NOT a table entry (falls to safe 'pending' default)", () => {
    const logger = vi.fn();
    expect(toUnifiedStatus("stripe", undefined, "complete", logger)).toBe("pending");
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ type: "schema_drift" }));
  });

  it("is case-insensitive and trims", () => {
    expect(toUnifiedStatus("paystack", undefined, "  SUCCESS ")).toBe("success");
    expect(toUnifiedStatus("flutterwave", "v3", "Successful")).toBe("success");
    expect(toUnifiedStatus("stripe", undefined, "  PAID ")).toBe("success");
  });

  it("unknown/missing status → 'pending' and logs schema_drift (never throws)", () => {
    const logger = vi.fn();
    expect(toUnifiedStatus("paystack", undefined, "moon_phase", logger)).toBe("pending");
    expect(toUnifiedStatus("flutterwave", "v3", undefined, logger)).toBe("pending");
    expect(toUnifiedStatus("stripe", undefined, "moon_phase", logger)).toBe("pending");
    expect(logger).toHaveBeenCalledTimes(3);
    expect(logger.mock.calls[0]?.[0]).toMatchObject({ type: "schema_drift" });
  });

  it("does not log when a status IS recognized", () => {
    const logger = vi.fn();
    toUnifiedStatus("paystack", undefined, "success", logger);
    toUnifiedStatus("stripe", undefined, "paid", logger);
    expect(logger).not.toHaveBeenCalled();
  });

  it("covers every row of each status table", () => {
    for (const [native, expected] of Object.entries(PAYSTACK_STATUS_MAP)) {
      expect(toUnifiedStatus("paystack", undefined, native)).toBe(expected);
    }
    for (const [native, expected] of Object.entries(FLUTTERWAVE_V3_STATUS_MAP)) {
      expect(toUnifiedStatus("flutterwave", "v3", native)).toBe(expected);
    }
    for (const [native, expected] of Object.entries(FLUTTERWAVE_V4_STATUS_MAP)) {
      expect(toUnifiedStatus("flutterwave", "v4", native)).toBe(expected);
    }
    for (const [native, expected] of Object.entries(STRIPE_STATUS_MAP)) {
      expect(toUnifiedStatus("stripe", undefined, native)).toBe(expected);
    }
  });
});
