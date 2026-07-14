import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProvider, type ProviderAdapter } from "../../src/core/provider";
import { HttpClient, bearer } from "../../src/core/http";
import { PayweaveConfigError } from "../../src/core/errors";

const toyConfigSchema = z.object({ apiKey: z.string().min(1) });

const toyAdapter: ProviderAdapter = {
  id: "toy",
  // v2: the root config key + schema this adapter registers under —
  // see `test/core/adapter-v2.test.ts` for the full extension-point proof.
  configKey: "toy",
  configSchema: toyConfigSchema,
  environments: {
    test: { baseUrl: "https://test.toy" },
    live: { baseUrl: "https://live.toy" },
  },
  inferEnvironment: (key) => (key.startsWith("test_") ? "test" : "live"),
  createHttp: () =>
    new HttpClient({ baseUrl: "https://test.toy", auth: bearer("k"), provider: "paystack" }),
  webhooks: {
    signatureHeader: "x-toy-signature",
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
    expect(registered.configKey).toBe("toy");
    expect(registered.inferEnvironment("test_x")).toBe("test");
    expect(registered.webhooks.signatureHeader).toBe("x-toy-signature");
    expect(registered.webhooks.verify({ rawBody: "{}", headers: {}, secret: "s" })).toBe(true);
  });

  it("throws a config error describing a malformed adapter", () => {
    const broken = { id: "", environments: {}, webhooks: {} } as unknown as ProviderAdapter;
    expect(() => defineProvider(broken)).toThrow(PayweaveConfigError);
  });

  it("throws a config error when configKey/configSchema/signatureHeader are missing", () => {
    const missingV2Fields = {
      id: "toy",
      environments: toyAdapter.environments,
      inferEnvironment: toyAdapter.inferEnvironment,
      createHttp: toyAdapter.createHttp,
      webhooks: { verify: () => true, parse: toyAdapter.webhooks.parse, toUnified: toyAdapter.webhooks.toUnified },
    } as unknown as ProviderAdapter;
    expect(() => defineProvider(missingV2Fields)).toThrow(PayweaveConfigError);
    expect(() => defineProvider(missingV2Fields)).toThrow(/configKey|configSchema|signatureHeader/);
  });

  it("rejects a configSchema that isn't a zod schema", () => {
    const badSchema = {
      ...toyAdapter,
      configSchema: { parse: () => undefined } as unknown as ProviderAdapter["configSchema"],
    };
    expect(() => defineProvider(badSchema)).toThrow(PayweaveConfigError);
  });
});
