/**
 * `payweave/products` becomes a public subpath. Smoke-check the
 * entry module's surface (PW-901's period math; `plan()`/`feature()` join in
 * PW-801). Behavior itself is covered in test/products/period.test.ts.
 */
import { describe, expect, it } from "vitest";
import { advance, currentPeriod, DAY_MS, WEEK_MS } from "../../src/products/index";

describe("products subpath entry (PW-505)", () => {
  it("re-exports the period math surface", () => {
    expect(typeof advance).toBe("function");
    expect(typeof currentPeriod).toBe("function");
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
    expect(WEEK_MS).toBe(7 * DAY_MS);
  });
});
