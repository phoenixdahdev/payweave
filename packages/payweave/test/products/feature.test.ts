import { describe, expect, it } from "vitest";
import { feature, PRODUCT_ID_REGEX } from "../../src/products/feature";
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

describe("feature() — id validation (§1, §9)", () => {
  it("accepts a lowercase alphanumeric id with dashes/underscores", () => {
    expect(() => feature({ id: "pro_models", type: "boolean" })).not.toThrow();
    expect(() => feature({ id: "pro-models-2", type: "boolean" })).not.toThrow();
    expect(() => feature({ id: "a", type: "boolean" })).not.toThrow();
  });

  it("accepts exactly 64 characters (the cap)", () => {
    const id = "a".repeat(64);
    expect(id).toHaveLength(64);
    expect(() => feature({ id, type: "boolean" })).not.toThrow();
  });

  it("rejects 65 characters (over the cap)", () => {
    const id = "a".repeat(65);
    const err = captureError(() => feature({ id, type: "boolean" }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      "invalid feature definition — id: must be lowercase alphanumeric with dashes or underscores, max 64 characters",
    );
  });

  it("rejects a leading dash", () => {
    const err = captureError(() => feature({ id: "-bad", type: "boolean" }));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toBe(
      "invalid feature definition — id: must be lowercase alphanumeric with dashes or underscores, max 64 characters",
    );
  });

  it("rejects a leading underscore", () => {
    expect(() => feature({ id: "_bad", type: "boolean" })).toThrow(PayweaveValidationError);
  });

  it("rejects uppercase characters", () => {
    expect(() => feature({ id: "Bad", type: "boolean" })).toThrow(PayweaveValidationError);
  });

  it("rejects an empty id", () => {
    expect(() => feature({ id: "", type: "boolean" })).toThrow(PayweaveValidationError);
  });

  it("the exported regex matches the spec's id rule verbatim", () => {
    expect(PRODUCT_ID_REGEX.source).toBe("^[a-z0-9][a-z0-9_-]{0,63}$");
  });

  it("rejects an invalid type", () => {
    const err = captureError(() =>
      // @ts-expect-error — deliberately invalid `type` to exercise the runtime guard.
      feature({ id: "x", type: "bogus" }),
    );
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toMatch(/^invalid feature definition — type: /);
  });

  it("rejects an unknown extra key at runtime (the `const` generic doesn't catch typos — the strict Zod schema is the real guard)", () => {
    // A non-fresh-literal value sidesteps TS's excess-property check (as does
    // `<const Def>` inference itself, which widens to whatever shape is
    // passed) — the strict schema is what actually rejects it.
    const badDef: { id: string; type: "boolean"; extra: number } = {
      id: "x",
      type: "boolean",
      extra: 1,
    };
    const err = captureError(() => feature(badDef));
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toMatch(/unrecognized/i);
  });
});

describe("feature() — callable identity (§9)", () => {
  it("returns a function, not a plain object", () => {
    const proModels = feature({ id: "pro_models", type: "boolean" });
    expect(typeof proModels).toBe("function");
  });

  it("two features with the same id/type are distinct callables", () => {
    const a = feature({ id: "x", type: "boolean" });
    const b = feature({ id: "x", type: "boolean" });
    expect(a).not.toBe(b);
  });

  it("the callable is frozen (no new own properties)", () => {
    const proModels = feature({ id: "pro_models", type: "boolean" });
    expect(Object.isFrozen(proModels)).toBe(true);
  });
});

describe("feature() — boolean calling convention (§2, §9)", () => {
  it("calling with no arguments produces a boolean FeatureInclusion", () => {
    const proModels = feature({ id: "pro_models", type: "boolean" });
    const inclusion = proModels();
    expect(inclusion).toEqual({ featureId: "pro_models", type: "boolean" });
  });

  it("the inclusion is frozen", () => {
    const proModels = feature({ id: "pro_models", type: "boolean" });
    expect(Object.isFrozen(proModels())).toBe(true);
  });

  it("calling with an argument does NOT throw at call time — it is recorded for plan() to reject", () => {
    const proModels = feature({ id: "pro_models", type: "boolean" });
    let inclusion: unknown;
    expect(() => {
      // @ts-expect-error — boolean features take no arguments; exercising the deferred-error path.
      inclusion = proModels({ limit: 1, reset: "month" });
    }).not.toThrow();
    expect(inclusion).toMatchObject({ featureId: "pro_models", type: "boolean" });
  });
});

describe("feature() — metered calling convention (§2, §9)", () => {
  it("calling with { limit, reset } produces a metered FeatureInclusion", () => {
    const messages = feature({ id: "messages", type: "metered" });
    const inclusion = messages({ limit: 100, reset: "month" });
    expect(inclusion).toEqual({ featureId: "messages", type: "metered", limit: 100, reset: "month" });
  });

  it("accepts every reset interval", () => {
    const messages = feature({ id: "messages", type: "metered" });
    for (const reset of ["day", "week", "month", "year"] as const) {
      expect(messages({ limit: 1, reset })).toEqual({
        featureId: "messages",
        type: "metered",
        limit: 1,
        reset,
      });
    }
  });

  it("throws immediately (call time) when called with no arguments", () => {
    const messages = feature({ id: "messages", type: "metered" });
    const err = captureError(() =>
      // @ts-expect-error — metered features require an argument.
      messages(),
    );
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toMatch(
      /^metered feature "messages" requires \{ limit: positive safe integer, reset: "day" \| "week" \| "month" \| "year" \}/,
    );
  });

  it("throws immediately when limit is not a positive safe integer", () => {
    const messages = feature({ id: "messages", type: "metered" });
    for (const limit of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => messages({ limit, reset: "month" })).toThrow(PayweaveValidationError);
      expect(() => messages({ limit, reset: "month" })).toThrow(/limit must be a positive safe integer/);
    }
  });

  it("throws immediately when reset is not a valid interval", () => {
    const messages = feature({ id: "messages", type: "metered" });
    const err = captureError(() =>
      // @ts-expect-error — deliberately invalid reset interval.
      messages({ limit: 1, reset: "century" }),
    );
    expect(err).toBeInstanceOf(PayweaveValidationError);
    expect((err as Error).message).toMatch(/reset must be one of/);
  });

  it("throws when called with an unrecognized extra key (strict argument schema)", () => {
    const messages = feature({ id: "messages", type: "metered" });
    expect(() =>
      // @ts-expect-error — deliberately extra key.
      messages({ limit: 1, reset: "month", extra: true }),
    ).toThrow(PayweaveValidationError);
  });
});
