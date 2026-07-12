import { describe, expect, it } from "vitest";
import {
  CURRENCY_EXPONENTS,
  exponentFor,
  money,
  assertMoney,
  toMajor,
  toMinor,
} from "../../src/core/money";
import { PayweaveValidationError } from "../../src/core/errors";

describe("exponents", () => {
  it("knows 0/2/3-exponent currencies and defaults to 2", () => {
    expect(exponentFor("NGN")).toBe(2);
    expect(exponentFor("ngn")).toBe(2);
    expect(exponentFor("XOF")).toBe(0);
    expect(exponentFor("XAF")).toBe(0);
    expect(exponentFor("UGX")).toBe(0);
    expect(exponentFor("RWF")).toBe(0);
    expect(exponentFor("KWD")).toBe(3);
    expect(exponentFor("ZZZ")).toBe(2);
  });

  it("marks all documented zero-exponent currencies", () => {
    for (const code of ["XOF", "XAF", "UGX", "RWF", "JPY", "KRW", "VND"]) {
      expect(CURRENCY_EXPONENTS[code]).toBe(0);
    }
  });
});

describe("money()", () => {
  it("accepts integer minor units", () => {
    expect(money(500000, "ngn")).toEqual({ value: 500000, currency: "NGN" });
  });

  it("rejects a float with a fix-it message pointing at toMinor", () => {
    expect(() => money(50.5, "NGN")).toThrow(PayweaveValidationError);
    expect(() => money(50.5, "NGN")).toThrow(/did you mean toMinor\(50\.5, 'NGN'\)/);
  });

  it("assertMoney validates an existing Money", () => {
    expect(assertMoney({ value: 100, currency: "NGN" }).value).toBe(100);
    expect(() => assertMoney({ value: 1.5, currency: "NGN" })).toThrow(PayweaveValidationError);
  });
});

describe("toMajor()", () => {
  it("converts minor to major honoring the exponent", () => {
    expect(toMajor({ value: 500000, currency: "NGN" })).toBe(5000);
    expect(toMajor({ value: 1000, currency: "XOF" })).toBe(1000);
    expect(toMajor({ value: 100500, currency: "KWD" })).toBe(100.5);
  });

  it("rejects a non-integer source value", () => {
    expect(() => toMajor({ value: 1.5, currency: "NGN" })).toThrow(PayweaveValidationError);
  });
});

describe("toMinor()", () => {
  it("converts major to integer minor units", () => {
    expect(toMinor(5000, "NGN")).toEqual({ value: 500000, currency: "NGN" });
    expect(toMinor(50.5, "NGN")).toEqual({ value: 5050, currency: "NGN" });
    expect(toMinor(1000, "XOF")).toEqual({ value: 1000, currency: "XOF" });
    expect(toMinor(100.5, "KWD")).toEqual({ value: 100500, currency: "KWD" });
  });

  it("rejects amounts finer than the currency allows", () => {
    expect(() => toMinor(50.555, "NGN")).toThrow(/more precision/);
  });

  it("rejects non-finite amounts", () => {
    expect(() => toMinor(Number.NaN, "NGN")).toThrow(PayweaveValidationError);
    expect(() => toMinor(Number.POSITIVE_INFINITY, "NGN")).toThrow(PayweaveValidationError);
  });
});
