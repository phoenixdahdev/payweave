import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index";

describe("payweave skeleton", () => {
  it("exposes the placeholder VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
