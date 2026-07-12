import { describe, expect, it, vi } from "vitest";
import {
  resolveConfig,
  inferEnvironment,
  PAYSTACK_BASE_URL,
  FLW_V3_BASE_URL,
  FLW_V4_SANDBOX_URL,
  FLW_V4_BASE_URL,
} from "../../src/core/config";
import { PayweaveConfigError } from "../../src/core/errors";

describe("inferEnvironment", () => {
  it("classifies Paystack + Flutterwave v3 keys by prefix", () => {
    expect(inferEnvironment("paystack", "sk_test_x")).toBe("test");
    expect(inferEnvironment("paystack", "sk_live_x")).toBe("live");
    expect(inferEnvironment("flutterwave", "FLWSECK_TEST-x")).toBe("test");
    expect(inferEnvironment("flutterwave", "FLWSECK-x")).toBe("live");
  });

  it("throws naming the expected prefixes for a bad key", () => {
    expect(() => inferEnvironment("paystack", "nope")).toThrow(/sk_test_.*sk_live_/s);
    expect(() => inferEnvironment("flutterwave", "nope")).toThrow(/FLWSECK_TEST-.*FLWSECK-/s);
  });
});

describe("resolveConfig — Paystack", () => {
  it("infers env and base URL", () => {
    const c = resolveConfig({ provider: "paystack", secretKey: "sk_test_abc" });
    expect(c.provider).toBe("paystack");
    expect(c.environment).toBe("test");
    expect(c.baseUrl).toBe(PAYSTACK_BASE_URL);
    expect(c.version).toBeUndefined();
    expect(c.timeoutMs).toBe(30_000);
    expect(c.maxRetries).toBe(2);
  });

  it("throws on env conflict with the key prefix", () => {
    expect(() =>
      resolveConfig({ provider: "paystack", secretKey: "sk_live_x", environment: "test" }),
    ).toThrow(PayweaveConfigError);
  });

  it("throws PayweaveConfigError synchronously for an unrecognized key", () => {
    expect(() => resolveConfig({ provider: "paystack", secretKey: "bad" })).toThrow(
      PayweaveConfigError,
    );
  });
});

describe("resolveConfig — Flutterwave v3 (default)", () => {
  it("defaults version to v3 and infers env from the key", () => {
    const c = resolveConfig({
      provider: "flutterwave",
      secretKey: "FLWSECK_TEST-abc",
      webhookSecret: "hash",
      encryptionKey: "enc",
    });
    expect(c.version).toBe("v3");
    expect(c.environment).toBe("test");
    expect(c.baseUrl).toBe(FLW_V3_BASE_URL);
    expect(c.webhookSecret).toBe("hash");
    expect(c.encryptionKey).toBe("enc");
  });

  it("classifies a live key", () => {
    expect(resolveConfig({ provider: "flutterwave", secretKey: "FLWSECK-x" }).environment).toBe(
      "live",
    );
  });
});

describe("resolveConfig — Flutterwave v4", () => {
  it("uses explicit env (default test) and the sandbox base URL", () => {
    const c = resolveConfig({
      provider: "flutterwave",
      version: "v4",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(c.version).toBe("v4");
    expect(c.environment).toBe("test");
    expect(c.baseUrl).toBe(FLW_V4_SANDBOX_URL);
    expect(c.tokenUrl).toBeTruthy();
  });

  it("uses the live base URL when environment is live", () => {
    const c = resolveConfig({
      provider: "flutterwave",
      version: "v4",
      clientId: "id",
      clientSecret: "secret",
      environment: "live",
    });
    expect(c.baseUrl).toBe(FLW_V4_BASE_URL);
  });

  it("throws when v4 credentials are missing", () => {
    expect(() => resolveConfig({ provider: "flutterwave", version: "v4" })).toThrow(
      PayweaveConfigError,
    );
  });
});

describe("resolveConfig — validation + guards", () => {
  it("rejects an invalid provider synchronously as a config error", () => {
    expect(() => resolveConfig({ provider: "stripe", secretKey: "x" })).toThrow(
      PayweaveConfigError,
    );
    expect(() => resolveConfig(null)).toThrow(PayweaveConfigError);
  });

  it("rejects a non-HTTPS baseUrl unless allowInsecureBaseUrl is set", () => {
    expect(() =>
      resolveConfig({ provider: "paystack", secretKey: "sk_test_x", baseUrl: "http://localhost" }),
    ).toThrow(/non-HTTPS/);
  });

  it("warns via logger when insecure baseUrl is explicitly allowed", () => {
    const logger = vi.fn();
    const c = resolveConfig({
      provider: "paystack",
      secretKey: "sk_test_x",
      baseUrl: "http://localhost:4000",
      allowInsecureBaseUrl: true,
      logger,
    });
    expect(c.baseUrl).toBe("http://localhost:4000");
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ type: "warn" }));
  });

  it("honors a custom https baseUrl override", () => {
    const c = resolveConfig({
      provider: "paystack",
      secretKey: "sk_test_x",
      baseUrl: "https://mock.local",
    });
    expect(c.baseUrl).toBe("https://mock.local");
  });
});
