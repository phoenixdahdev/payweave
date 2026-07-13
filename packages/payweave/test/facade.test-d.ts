import { describe, it, expectTypeOf } from "vitest";
import {
  createPaystack,
  createFlutterwave,
  PaymentSDK,
  type PaystackSDK,
  type FlutterwaveV3SDK,
  type FlutterwaveV4SDK,
  type FlutterwaveV3Client,
  type FlutterwaveV4Client,
  type PaystackClient,
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

describe("delegation-preserved narrowing (PW-504 — wrapper = PayweaveClient + legacy props)", () => {
  it("wrapper roots keep the legacy literal props", () => {
    const ps = createPaystack({ secretKey: "sk_test_x" });
    expectTypeOf(ps.provider).toEqualTypeOf<"paystack">();
    expectTypeOf(ps.environment).toEqualTypeOf<"test" | "live">();

    const fw3 = createFlutterwave({ secretKey: "FLWSECK_TEST-x" });
    expectTypeOf(fw3.provider).toEqualTypeOf<"flutterwave">();
    expectTypeOf(fw3.version).toEqualTypeOf<"v3">();

    const fw4 = createFlutterwave({ version: "v4", clientId: "a", clientSecret: "b" });
    expectTypeOf(fw4.version).toEqualTypeOf<"v4">();
  });

  it("Surface A namespaces narrow exactly like createPayweave's (§4 assertion 3)", () => {
    const ps = createPaystack({ secretKey: "sk_test_x" });
    expectTypeOf(ps.paystack).toEqualTypeOf<PaystackClient>();

    const fw3 = createFlutterwave({ secretKey: "FLWSECK_TEST-x" });
    expectTypeOf(fw3.flutterwave).toEqualTypeOf<FlutterwaveV3Client>();
    expectTypeOf(fw3.flutterwave).toHaveProperty("payments");

    const fw4 = createFlutterwave({ version: "v4", clientId: "a", clientSecret: "b" });
    expectTypeOf(fw4.flutterwave).toEqualTypeOf<FlutterwaveV4Client>();
    // v4 resources are a later wave — the v3-only fields stay hidden (TDD §11).
    expectTypeOf(fw4.flutterwave).not.toHaveProperty("payments");
  });

  it("wrappers expose the delegated client root (unified ops + client props)", () => {
    const ps = createPaystack({ secretKey: "sk_test_x" });
    expectTypeOf(ps.defaultProvider).toEqualTypeOf<"paystack">();
    expectTypeOf(ps.providers).toEqualTypeOf<readonly "paystack"[]>();
    expectTypeOf(ps.checkout.create).toBeFunction();
    // Per-call provider overrides stay typed to the configured key only.
    expectTypeOf(ps.verify)
      .parameter(0)
      .toHaveProperty("provider")
      .toEqualTypeOf<"paystack" | undefined>();
  });
});
