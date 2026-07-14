import { describe, expect, it } from "vitest";
import { feature, type FeatureInclusion } from "../../src/products/feature";
import {
  plan,
  resolvePlanPricing,
  type Plan,
  type PlanDefInput,
  type PlanPriceInput,
} from "../../src/products/plan";
import { PayweaveValidationError } from "../../src/core/errors";

/** Capture the thrown error so class AND message can be asserted together. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

const proModels = feature({ id: "pro_models", type: "boolean" });
const prioritySupport = feature({ id: "priority_support", type: "boolean" });
const messages = feature({ id: "messages", type: "metered" });

describe("plan() — §1–§6 examples parse verbatim", () => {
  it("the free/pro/ultra example from the spec", () => {
    const free = plan({
      id: "free",
      name: "Free",
      group: "base",
      default: true,
      includes: [messages({ limit: 100, reset: "month" })],
    });
    const pro = plan({
      id: "pro",
      name: "Pro",
      group: "base",
      price: { amount: 19, currency: "USD", interval: "month" },
      includes: [messages({ limit: 2_000, reset: "month" }), proModels()],
    });
    const ultra = plan({
      id: "ultra",
      name: "Ultra",
      group: "base",
      price: { amount: 49, currency: "USD", interval: "month" },
      includes: [messages({ limit: 10_000, reset: "month" }), proModels(), prioritySupport()],
    });

    expect(free).toMatchObject({ id: "free", name: "Free", group: "base", default: true });
    expect(free.includes).toEqual([{ featureId: "messages", type: "metered", limit: 100, reset: "month" }]);

    expect(pro).toMatchObject({
      id: "pro",
      name: "Pro",
      group: "base",
      default: false,
      price: { amount: 19, currency: "USD", interval: "month" },
    });
    expect(pro.includes).toEqual([
      { featureId: "messages", type: "metered", limit: 2_000, reset: "month" },
      { featureId: "pro_models", type: "boolean" },
    ]);

    expect(ultra.includes).toHaveLength(3);
  });

  it("§6: an omitted currency leans on defaultCurrency (plan() accepts it, doesn't resolve it)", () => {
    const p = plan({ id: "pro", group: "base", price: { amount: 5000, interval: "month" } });
    expect(p.price).toEqual({ amount: 5000, interval: "month" });
  });
});

describe("plan() — id validation (§3, same regex as features)", () => {
  it("accepts a valid id", () => {
    expect(() => plan({ id: "pro" })).not.toThrow();
  });

  it("accepts exactly 64 characters", () => {
    expect(() => plan({ id: "a".repeat(64) })).not.toThrow();
  });

  it("rejects 65 characters", () => {
    const err = captureError(() => plan({ id: "a".repeat(65) }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      "invalid plan definition — id: must be lowercase alphanumeric with dashes or underscores, max 64 characters",
    );
  });

  it("rejects a leading dash", () => {
    expect(() => plan({ id: "-pro" })).toThrow(PayweaveValidationError);
  });

  it("rejects a leading underscore", () => {
    expect(() => plan({ id: "_pro" })).toThrow(PayweaveValidationError);
  });

  it("rejects uppercase characters", () => {
    expect(() => plan({ id: "Pro" })).toThrow(PayweaveValidationError);
  });
});

describe("plan() — default: true requires group (§4, §9)", () => {
  it("throws when default is true and group is missing", () => {
    const err = captureError(() => plan({ id: "free", default: true }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe('plan "free": default: true requires a group');
  });

  it("does not throw when default is true and group is present", () => {
    expect(() => plan({ id: "free", default: true, group: "base" })).not.toThrow();
  });

  it("does not throw when default is omitted (defaults to false) with no group", () => {
    const p = plan({ id: "pro" });
    expect(p.default).toBe(false);
    expect(p.group).toBeUndefined();
  });

  it("does not throw when default is explicitly false with no group", () => {
    expect(() => plan({ id: "pro", default: false })).not.toThrow();
  });
});

describe("plan() — includes: raw uncalled feature (§9 'did you mean')", () => {
  it("gives the exact hint for a metered feature passed uncalled", () => {
    const badIncludes = [messages] as unknown as readonly FeatureInclusion[];
    const err = captureError(() => plan({ id: "pro", includes: badIncludes }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe('plan "pro": did you mean `messages({ limit, reset })`?');
  });

  it("gives the call-with-no-args hint for a boolean feature passed uncalled", () => {
    const badIncludes = [proModels] as unknown as readonly FeatureInclusion[];
    const err = captureError(() => plan({ id: "pro", includes: badIncludes }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe('plan "pro": did you mean `pro_models()`?');
  });
});

describe("plan() — includes: invalid entries (§9)", () => {
  it("rejects a plain object that is not a FeatureInclusion", () => {
    const badIncludes = [
      { featureId: "messages", type: "metered", limit: 1, reset: "month" },
    ] as unknown as readonly FeatureInclusion[];
    const err = captureError(() => plan({ id: "pro", includes: badIncludes }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro" includes an invalid entry — expected a called feature, e.g. messages({ limit, reset }) or proModels()',
    );
  });

  it("rejects a bare string", () => {
    const badIncludes = ["messages"] as unknown as readonly FeatureInclusion[];
    expect(() => plan({ id: "pro", includes: badIncludes })).toThrow(PayweaveValidationError);
  });
});

describe("plan() — includes: boolean feature called with an argument (§9, deferred from feature())", () => {
  it("plan() rejects it, naming the feature", () => {
    const invalidInclusion = (proModels as unknown as (arg: unknown) => unknown)({ limit: 1, reset: "month" });
    const badIncludes = [invalidInclusion] as unknown as readonly FeatureInclusion[];
    const err = captureError(() => plan({ id: "pro", includes: badIncludes }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe('plan "pro": boolean feature "pro_models" does not take arguments');
  });
});

describe("plan() — includes: duplicate feature ids within one plan (§9)", () => {
  it("throws naming the duplicated feature", () => {
    const err = captureError(() =>
      plan({ id: "pro", includes: [proModels(), proModels()] }),
    );
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe('plan "pro" includes feature "pro_models" more than once');
  });

  it("does not throw for distinct feature ids", () => {
    expect(() => plan({ id: "pro", includes: [proModels(), messages({ limit: 1, reset: "month" })] })).not.toThrow();
  });
});

describe("plan() — price shape validation (§6)", () => {
  it("accepts a valid price", () => {
    const p = plan({ id: "pro", price: { amount: 19.99, currency: "USD", interval: "month" } });
    expect(p.price).toEqual({ amount: 19.99, currency: "USD", interval: "month" });
  });

  it("normalizes currency to uppercase", () => {
    const p = plan({ id: "pro", price: { amount: 19, currency: "usd", interval: "month" } });
    expect(p.price?.currency).toBe("USD");
  });

  it("rejects a non-positive amount", () => {
    expect(() => plan({ id: "pro", price: { amount: 0, interval: "month" } })).toThrow(
      PayweaveValidationError,
    );
    expect(() => plan({ id: "pro", price: { amount: -5, interval: "month" } })).toThrow(
      PayweaveValidationError,
    );
  });

  it("rejects a non-finite amount", () => {
    expect(() =>
      plan({ id: "pro", price: { amount: Number.POSITIVE_INFINITY, interval: "month" } }),
    ).toThrow(PayweaveValidationError);
  });

  it("rejects an invalid interval", () => {
    const badPrice = { amount: 19, interval: "week" } as unknown as PlanPriceInput;
    expect(() => plan({ id: "pro", price: badPrice })).toThrow(PayweaveValidationError);
  });

  it("rejects a malformed currency code", () => {
    expect(() => plan({ id: "pro", price: { amount: 19, currency: "US", interval: "month" } })).toThrow(
      PayweaveValidationError,
    );
    expect(() => plan({ id: "pro", price: { amount: 19, currency: "1234", interval: "month" } })).toThrow(
      PayweaveValidationError,
    );
  });

  it("plan() does NOT enforce the §6 amount bound — that's resolvePlanPricing's job (currency-dependent)", () => {
    expect(() => plan({ id: "pro", price: { amount: 5_000_000, interval: "month" } })).not.toThrow();
  });
});

describe("plan() — unknown top-level key (strict schema)", () => {
  it("rejects a typo'd key", () => {
    const badDef = { id: "pro", prcie: { amount: 1, interval: "month" } } as unknown as PlanDefInput;
    const err = captureError(() => plan(badDef));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toMatch(/unrecognized/i);
  });
});

describe("plan() — output shape", () => {
  it("is frozen (both the plan and its includes array)", () => {
    const p = plan({ id: "pro", includes: [proModels()] });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.includes)).toBe(true);
  });

  it("free plan (no price) has price: undefined", () => {
    const p = plan({ id: "free" });
    expect(p.price).toBeUndefined();
  });

  it("plan with no includes has an empty includes array", () => {
    const p = plan({ id: "free" });
    expect(p.includes).toEqual([]);
  });
});

describe("resolvePlanPricing() — the money deviation (§9, AGENTS.md golden rule 7)", () => {
  it("converts 19.99 USD -> 1999 minor units", () => {
    const p = plan({ id: "pro", price: { amount: 19.99, currency: "USD", interval: "month" } });
    expect(resolvePlanPricing(p, "USD")).toEqual({ amount: 1999, currency: "USD", interval: "month" });
  });

  it("converts 1000 XOF -> 1000 minor units (0-exponent currency)", () => {
    const p = plan({ id: "pro", price: { amount: 1000, currency: "XOF", interval: "month" } });
    expect(resolvePlanPricing(p, "XOF")).toEqual({ amount: 1000, currency: "XOF", interval: "month" });
  });

  it("uses the passed currency when the plan omits its own (defaultCurrency path)", () => {
    const p = plan({ id: "pro", price: { amount: 50, interval: "year" } });
    expect(resolvePlanPricing(p, "NGN")).toEqual({ amount: 5000, currency: "NGN", interval: "year" });
  });

  it("returns undefined for a free plan", () => {
    const p = plan({ id: "free" });
    expect(resolvePlanPricing(p, "USD")).toBeUndefined();
  });

  it("19.999 USD throws, naming the plan id (more precision than the currency allows)", () => {
    const p = plan({ id: "pro", price: { amount: 19.999, currency: "USD", interval: "month" } });
    const err = captureError(() => resolvePlanPricing(p, "USD"));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro": amount 19.999 has more precision than USD allows (2 minor-unit digits)',
    );
  });

  it("5.5 UGX throws, naming the plan id (0-exponent currency has no fractional part)", () => {
    const p = plan({ id: "pro", price: { amount: 5.5, currency: "UGX", interval: "month" } });
    const err = captureError(() => resolvePlanPricing(p, "UGX"));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro": amount 5.5 has more precision than UGX allows (0 minor-unit digits)',
    );
  });

  it("an amount over the §6 bound throws, naming the plan id and the bound", () => {
    const p = plan({ id: "pro", price: { amount: 1_000_000, currency: "USD", interval: "month" } });
    const err = captureError(() => resolvePlanPricing(p, "USD"));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro": amount 1000000 USD exceeds the maximum of 999999.99 USD',
    );
  });

  it("exactly at the §6 bound does not throw", () => {
    const p = plan({ id: "pro", price: { amount: 999_999.99, currency: "USD", interval: "month" } });
    expect(resolvePlanPricing(p, "USD")).toEqual({
      amount: 99_999_999,
      currency: "USD",
      interval: "month",
    });
  });

  it("the 0-exponent bound is 999999 (no decimal places)", () => {
    const p = plan({ id: "pro", price: { amount: 1_000_000, currency: "XOF", interval: "month" } });
    const err = captureError(() => resolvePlanPricing(p, "XOF"));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      'plan "pro": amount 1000000 XOF exceeds the maximum of 999999 XOF',
    );
  });

  it("the plan's own currency wins over the passed fallback", () => {
    const p = plan({ id: "pro", price: { amount: 19.99, currency: "USD", interval: "month" } });
    expect(resolvePlanPricing(p, "NGN")).toEqual({ amount: 1999, currency: "USD", interval: "month" });
  });
});

describe("plan/feature id literal preservation (§10) — runtime smoke check", () => {
  it("Plan['id'] and includes[number]['featureId'] are the literal strings, readable without casts", () => {
    const p = plan({ id: "pro", includes: [proModels(), messages({ limit: 1, reset: "month" })] });
    const id: "pro" = p.id;
    const featureIds: ("pro_models" | "messages")[] = p.includes.map((i) => i.featureId);
    expect(id).toBe("pro");
    expect(featureIds.sort()).toEqual(["messages", "pro_models"]);
  });

  it("a Plan value structurally satisfies the generic Plan<> type with defaults", () => {
    const p: Plan = plan({ id: "pro", group: "base" });
    expect(p.id).toBe("pro");
  });
});
