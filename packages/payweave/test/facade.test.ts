import { describe, expect, it } from "vitest";
import {
  createPaystack,
  createFlutterwave,
  PaymentSDK,
  PaystackSDK,
  FlutterwaveV3SDK,
  FlutterwaveV4SDK,
} from "../src/index";
import { PayweaveError, PayweaveConfigError } from "../src/core/errors";
import { signWebhook } from "../src/testing/sign-webhook";

describe("createPaystack", () => {
  const sk = "sk_test_facade";
  const sdk = createPaystack({ secretKey: sk });

  it("exposes provider/environment and the paystack namespace", () => {
    expect(sdk).toBeInstanceOf(PaystackSDK);
    expect(sdk.provider).toBe("paystack");
    expect(sdk.environment).toBe("test");
    expect(sdk.paystack).toBeDefined();
  });

  it("verifies a Paystack webhook using the secret key", () => {
    const signed = signWebhook("paystack", { event: "charge.success" }, sk);
    expect(
      sdk.webhooks.verify({
        rawBody: signed.body,
        headers: { [signed.headerName]: signed.header },
      }),
    ).toBe(true);
    expect(
      sdk.webhooks.verify({ rawBody: signed.body + "x", headers: { [signed.headerName]: signed.header } }),
    ).toBe(false);
  });

  it("fails closed on an unverifiable constructEvent", () => {
    expect(() => sdk.webhooks.constructEvent({ rawBody: "{}", headers: {} })).toThrow(PayweaveError);
  });

  it("exposes the unified (Surface B) namespace as callable ops", () => {
    // PW-304: the unified stubs are now real. Shape check only here — routing +
    // normalization are covered by test/unified/*. (No network call is made.)
    expect(typeof sdk.unified.checkout.create).toBe("function");
    expect(typeof sdk.unified.verify).toBe("function");
    expect(typeof sdk.unified.refunds.create).toBe("function");
    expect(typeof sdk.unified.transfers.create).toBe("function");
    expect(typeof sdk.unified.banks.list).toBe("function");
    expect(typeof sdk.unified.banks.resolveAccount).toBe("function");
  });
});

describe("createFlutterwave", () => {
  it("defaults to v3 and requires webhookSecret to verify", () => {
    const sdk = createFlutterwave({ secretKey: "FLWSECK_TEST-x" });
    expect(sdk).toBeInstanceOf(FlutterwaveV3SDK);
    expect(sdk.version).toBe("v3");
    expect(sdk.flutterwave.version).toBe("v3");
    // No webhookSecret configured → fail closed with a config error.
    expect(() => sdk.webhooks.verify({ rawBody: "{}", headers: {} })).toThrow(PayweaveConfigError);
  });

  it("verifies a v3 webhook when webhookSecret is set", () => {
    const sdk = createFlutterwave({ secretKey: "FLWSECK_TEST-x", webhookSecret: "hash" });
    const signed = signWebhook("flutterwave", { event: "charge.completed" }, "hash");
    expect(
      sdk.webhooks.verify({ rawBody: signed.body, headers: { "verif-hash": signed.header } }),
    ).toBe(true);
  });

  it("narrows to the v4 surface with version: v4", () => {
    const sdk = createFlutterwave({ version: "v4", clientId: "a", clientSecret: "b" });
    expect(sdk).toBeInstanceOf(FlutterwaveV4SDK);
    expect(sdk.version).toBe("v4");
  });
});

describe("PaymentSDK factory", () => {
  it("works called or new'd and returns the narrowed instance", () => {
    const called = PaymentSDK({ provider: "paystack", secretKey: "sk_test_x" });
    const constructed = new PaymentSDK({ provider: "paystack", secretKey: "sk_test_x" });
    expect(called).toBeInstanceOf(PaystackSDK);
    expect(constructed).toBeInstanceOf(PaystackSDK);
  });

  it("dispatches Flutterwave version", () => {
    expect(PaymentSDK({ provider: "flutterwave", secretKey: "FLWSECK-x" })).toBeInstanceOf(
      FlutterwaveV3SDK,
    );
    expect(
      PaymentSDK({ provider: "flutterwave", version: "v4", clientId: "a", clientSecret: "b" }),
    ).toBeInstanceOf(FlutterwaveV4SDK);
  });
});
