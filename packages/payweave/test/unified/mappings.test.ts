import { describe, expect, it, vi } from "vitest";
import {
  toUnifiedEventType,
  toUnifiedStatus,
  PAYSTACK_EVENT_MAP,
  PAYSTACK_STATUS_MAP,
  FLUTTERWAVE_V3_STATUS_MAP,
  FLUTTERWAVE_V4_STATUS_MAP,
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

  it("is case-insensitive and trims", () => {
    expect(toUnifiedStatus("paystack", undefined, "  SUCCESS ")).toBe("success");
    expect(toUnifiedStatus("flutterwave", "v3", "Successful")).toBe("success");
  });

  it("unknown/missing status → 'pending' and logs schema_drift (never throws)", () => {
    const logger = vi.fn();
    expect(toUnifiedStatus("paystack", undefined, "moon_phase", logger)).toBe("pending");
    expect(toUnifiedStatus("flutterwave", "v3", undefined, logger)).toBe("pending");
    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls[0]?.[0]).toMatchObject({ type: "schema_drift" });
  });

  it("does not log when a status IS recognized", () => {
    const logger = vi.fn();
    toUnifiedStatus("paystack", undefined, "success", logger);
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
  });
});
