import { describe, it, expectTypeOf } from "vitest";
import {
  createPaystack,
  createFlutterwave,
  PaymentSDK,
  type PaystackSDK,
  type FlutterwaveV3SDK,
  type FlutterwaveV4SDK,
} from "../src/index";

describe("provider narrowing (§7.1)", () => {
  it("createPaystack has no version and no flutterwave", () => {
    const ps = createPaystack({ secretKey: "sk_test_x" });
    expectTypeOf(ps).toEqualTypeOf<PaystackSDK>();
    expectTypeOf(ps).not.toHaveProperty("version");
    expectTypeOf(ps).not.toHaveProperty("flutterwave");
  });

  it("createFlutterwave has no paystack; omitted version → v3", () => {
    const fw = createFlutterwave({ secretKey: "FLWSECK_TEST-x" });
    expectTypeOf(fw).toEqualTypeOf<FlutterwaveV3SDK>();
    expectTypeOf(fw).not.toHaveProperty("paystack");
  });

  it("createFlutterwave version v4 → v4 surface", () => {
    const fw4 = createFlutterwave({ version: "v4", clientId: "a", clientSecret: "b" });
    expectTypeOf(fw4).toEqualTypeOf<FlutterwaveV4SDK>();
  });

  it("PaymentSDK narrows by provider + version (called or new)", () => {
    expectTypeOf(
      PaymentSDK({ provider: "paystack", secretKey: "sk_test_x" }),
    ).toEqualTypeOf<PaystackSDK>();
    expectTypeOf(
      PaymentSDK({ provider: "flutterwave", secretKey: "FLWSECK_TEST-x" }),
    ).toEqualTypeOf<FlutterwaveV3SDK>();
    expectTypeOf(
      PaymentSDK({ provider: "flutterwave", version: "v4", clientId: "a", clientSecret: "b" }),
    ).toEqualTypeOf<FlutterwaveV4SDK>();
    expectTypeOf(
      new PaymentSDK({ provider: "paystack", secretKey: "sk_test_x" }),
    ).toEqualTypeOf<PaystackSDK>();
  });
});
