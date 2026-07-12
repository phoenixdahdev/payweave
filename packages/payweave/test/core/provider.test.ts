import { describe, expect, it } from "vitest";
import { defineProvider, type ProviderAdapter } from "../../src/core/provider";
import { HttpClient, bearer } from "../../src/core/http";
import { PayweaveConfigError } from "../../src/core/errors";

const toyAdapter: ProviderAdapter = {
  id: "toy",
  environments: {
    test: { baseUrl: "https://test.toy" },
    live: { baseUrl: "https://live.toy" },
  },
  inferEnvironment: (key) => (key.startsWith("test_") ? "test" : "live"),
  createHttp: () =>
    new HttpClient({ baseUrl: "https://test.toy", auth: bearer("k"), provider: "paystack" }),
  webhooks: {
    verify: () => true,
    parse: (raw) => ({ type: "toy.event", data: JSON.parse(raw), raw }),
    toUnified: (e) => ({
      provider: "toy",
      type: e.type,
      unifiedType: "unknown",
      data: e.data,
      raw: e.raw,
    }),
  },
};

describe("defineProvider", () => {
  it("registers a valid adapter (identity)", () => {
    const registered = defineProvider(toyAdapter);
    expect(registered).toBe(toyAdapter);
    expect(registered.id).toBe("toy");
    expect(registered.inferEnvironment("test_x")).toBe("test");
    expect(registered.webhooks.verify({ rawBody: "{}", headers: {}, secret: "s" })).toBe(true);
  });

  it("throws a config error describing a malformed adapter", () => {
    const broken = { id: "", environments: {}, webhooks: {} } as unknown as ProviderAdapter;
    expect(() => defineProvider(broken)).toThrow(PayweaveConfigError);
  });
});
