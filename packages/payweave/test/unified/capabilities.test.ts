/**
 * Unified-ops capability matrix. Pure data +
 * pure functions — no network, no HttpClient — so these are plain unit tests
 * over `unified/mappings.ts`'s exports, exhaustively covering every
 * provider/op cell.
 */
import { describe, expect, it } from "vitest";
import {
  UNIFIED_CAPABILITY_MATRIX,
  isUnifiedOpSupported,
  assertUnifiedCapability,
  type MappingProvider,
  type UnifiedOpName,
} from "../../src/unified/mappings";
import { PayweaveValidationError } from "../../src/core/errors";

const PROVIDERS: readonly MappingProvider[] = ["paystack", "flutterwave", "stripe"];
const OPS: readonly UnifiedOpName[] = [
  "checkout.create",
  "verify",
  "refunds.create",
  "transfers.create",
  "banks.list",
  "banks.resolveAccount",
];

describe("UNIFIED_CAPABILITY_MATRIX — shape", () => {
  it("has exactly the three providers, each with exactly the six ops", () => {
    expect(Object.keys(UNIFIED_CAPABILITY_MATRIX).sort()).toEqual(
      ["flutterwave", "paystack", "stripe"],
    );
    for (const provider of PROVIDERS) {
      expect(Object.keys(UNIFIED_CAPABILITY_MATRIX[provider]).sort()).toEqual(
        [...OPS].sort(),
      );
    }
  });

  it("paystack supports every unified op", () => {
    for (const op of OPS) {
      expect(UNIFIED_CAPABILITY_MATRIX.paystack[op]).toEqual({ supported: true });
    }
  });

  it("flutterwave supports every unified op", () => {
    for (const op of OPS) {
      expect(UNIFIED_CAPABILITY_MATRIX.flutterwave[op]).toEqual({ supported: true });
    }
  });

  it("stripe supports checkout.create/verify/refunds.create (providers.md §3.3)", () => {
    expect(UNIFIED_CAPABILITY_MATRIX.stripe["checkout.create"]).toEqual({ supported: true });
    expect(UNIFIED_CAPABILITY_MATRIX.stripe.verify).toEqual({ supported: true });
    expect(UNIFIED_CAPABILITY_MATRIX.stripe["refunds.create"]).toEqual({ supported: true });
  });

  it("stripe does NOT support transfers.create/banks.* — the exact §3.3 wording", () => {
    expect(UNIFIED_CAPABILITY_MATRIX.stripe["transfers.create"]).toEqual({
      supported: false,
      reason: "transfers are not supported on stripe",
    });
    expect(UNIFIED_CAPABILITY_MATRIX.stripe["banks.list"]).toEqual({
      supported: false,
      reason: "banks.list is not supported on stripe",
    });
    expect(UNIFIED_CAPABILITY_MATRIX.stripe["banks.resolveAccount"]).toEqual({
      supported: false,
      reason: "banks.resolveAccount is not supported on stripe",
    });
  });
});

describe("isUnifiedOpSupported — exhaustive over every provider × op cell", () => {
  for (const provider of PROVIDERS) {
    for (const op of OPS) {
      const expected = UNIFIED_CAPABILITY_MATRIX[provider][op].supported;
      it(`${provider}.${op} → ${expected}`, () => {
        expect(isUnifiedOpSupported(provider, op)).toBe(expected);
      });
    }
  }
});

describe("assertUnifiedCapability — exhaustive over every provider × op cell", () => {
  for (const provider of PROVIDERS) {
    for (const op of OPS) {
      const cell = UNIFIED_CAPABILITY_MATRIX[provider][op];
      if (cell.supported) {
        it(`${provider}.${op} is a no-op (supported)`, () => {
          expect(() => assertUnifiedCapability(provider, op)).not.toThrow();
        });
      } else {
        it(`${provider}.${op} throws PayweaveValidationError naming the provider + op`, () => {
          expect(() => assertUnifiedCapability(provider, op)).toThrow(PayweaveValidationError);
          try {
            assertUnifiedCapability(provider, op);
            throw new Error("expected assertUnifiedCapability to throw");
          } catch (err) {
            expect(err).toBeInstanceOf(PayweaveValidationError);
            const e = err as PayweaveValidationError;
            expect(e.message).toBe(cell.reason);
            expect(e.provider).toBe(provider);
            expect(e.isRetryable).toBe(false);
          }
        });
      }
    }
  }

  it("the AC's exact scenario: transfers.create on stripe throws the typed capability error", () => {
    expect(() => assertUnifiedCapability("stripe", "transfers.create")).toThrow(
      PayweaveValidationError,
    );
    expect(() => assertUnifiedCapability("stripe", "transfers.create")).toThrow(
      "transfers are not supported on stripe",
    );
  });

  it("never throws for a supported op regardless of provider", () => {
    expect(() => assertUnifiedCapability("paystack", "transfers.create")).not.toThrow();
    expect(() => assertUnifiedCapability("flutterwave", "banks.list")).not.toThrow();
    expect(() => assertUnifiedCapability("stripe", "checkout.create")).not.toThrow();
    expect(() => assertUnifiedCapability("stripe", "verify")).not.toThrow();
    expect(() => assertUnifiedCapability("stripe", "refunds.create")).not.toThrow();
  });
});
