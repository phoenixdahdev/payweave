/**
 * PW-502 — `createPayweave` narrowing (unified-config.md §4, assertions 1–3
 * and 5; assertion 4 — products inference — is PW-802). Type-only: this file
 * is compiled by `vitest --typecheck`, never executed.
 */
import { describe, it, expectTypeOf } from "vitest";
import {
  createPayweave,
  type PayweaveClient,
  type PaystackClient,
  type StripeClient,
  type FlutterwaveV3Client,
  type FlutterwaveV4Client,
  type PaystackProviderConfig,
} from "../src/index";

describe("createPayweave narrowing (§4)", () => {
  it("assertion 1: an absent provider key is a compile-time absence", () => {
    const stripeOnly = createPayweave({ stripe: { secretKey: "sk_test_x" } });
    expectTypeOf(stripeOnly.stripe).toEqualTypeOf<StripeClient>();
    expectTypeOf(stripeOnly).not.toHaveProperty("paystack");
    expectTypeOf(stripeOnly).not.toHaveProperty("flutterwave");
    // @ts-expect-error — paystack is not a configured key on this client
    void stripeOnly.paystack;

    const paystackOnly = createPayweave({ paystack: { secretKey: "sk_test_x" } });
    expectTypeOf(paystackOnly.paystack).toEqualTypeOf<PaystackClient>();
    expectTypeOf(paystackOnly).not.toHaveProperty("stripe");
    // @ts-expect-error — stripe is not a configured key on this client
    void paystackOnly.stripe;
  });

  it("assertion 2: defaultProvider accepts only configured keys", () => {
    // @ts-expect-error — paystack is not configured, so it cannot be the default
    createPayweave({ stripe: { secretKey: "sk_test_x" }, defaultProvider: "paystack" });

    const multi = createPayweave({
      paystack: { secretKey: "sk_test_x" },
      flutterwave: { secretKey: "FLWSECK_TEST-x" },
      defaultProvider: "paystack",
    });
    expectTypeOf(multi.defaultProvider).toEqualTypeOf<"paystack" | "flutterwave">();
    expectTypeOf(multi.providers).toEqualTypeOf<readonly ("paystack" | "flutterwave")[]>();
  });

  it("assertion 2: per-call provider overrides accept only configured keys", () => {
    const multi = createPayweave({
      paystack: { secretKey: "sk_test_x" },
      flutterwave: { secretKey: "FLWSECK_TEST-x" },
      defaultProvider: "paystack",
    });
    expectTypeOf(multi.verify)
      .parameter(0)
      .toHaveProperty("provider")
      .toEqualTypeOf<"paystack" | "flutterwave" | undefined>();
    void multi.banks.list({ country: "NG", provider: "flutterwave" });
    // @ts-expect-error — stripe is not configured on this client
    void multi.banks.list({ country: "NG", provider: "stripe" });

    const stripeOnly = createPayweave({ stripe: { secretKey: "sk_test_x" } });
    expectTypeOf(stripeOnly.checkout.create)
      .parameter(0)
      .toHaveProperty("provider")
      .toEqualTypeOf<"stripe" | undefined>();
    void stripeOnly.verify({
      reference: "ref_1",
      // @ts-expect-error — paystack is not configured on this client
      provider: "paystack",
    });
  });

  it("assertion 3: flutterwave version narrows the mounted surface", () => {
    const v3 = createPayweave({ flutterwave: { secretKey: "FLWSECK_TEST-x" } });
    expectTypeOf(v3.flutterwave).toEqualTypeOf<FlutterwaveV3Client>();
    expectTypeOf(v3.flutterwave.version).toEqualTypeOf<"v3">();
    expectTypeOf(v3.flutterwave).toHaveProperty("payments");

    const v4 = createPayweave({
      flutterwave: { version: "v4", clientId: "id", clientSecret: "s" },
    });
    expectTypeOf(v4.flutterwave).toEqualTypeOf<FlutterwaveV4Client>();
    expectTypeOf(v4.flutterwave.version).toEqualTypeOf<"v4">();
    // v4 resources are a later wave — the v3-only fields are hidden (TDD §11).
    expectTypeOf(v4.flutterwave).not.toHaveProperty("payments");
    expectTypeOf(v4.flutterwave).not.toHaveProperty("charges");
  });

  it("assertion 5: inline literals narrow without `as const`", () => {
    // No `as const` anywhere in this file — the `const` generic preserves the
    // literals ("v4", provider keys) exactly as written inline.
    const client = createPayweave({
      stripe: { secretKey: "sk_test_x" },
      paystack: { secretKey: "sk_test_y" },
      defaultProvider: "stripe",
    });
    expectTypeOf(client.stripe).toEqualTypeOf<StripeClient>();
    expectTypeOf(client.paystack).toEqualTypeOf<PaystackClient>();
    expectTypeOf(client).not.toHaveProperty("flutterwave");
    expectTypeOf(client.environment).toEqualTypeOf<"test" | "live">();
  });

  it("PayweaveClient<C> is the exported name for the factory's return type", () => {
    type C = { paystack: PaystackProviderConfig };
    const client = createPayweave({ paystack: { secretKey: "sk_test_x" } });
    expectTypeOf<PayweaveClient<C>>().toHaveProperty("paystack");
    expectTypeOf<PayweaveClient<C>>().not.toHaveProperty("stripe");
    // The deprecated alias exposes the same op signatures as the root.
    expectTypeOf(client.unified.checkout).toEqualTypeOf(client.checkout);
    expectTypeOf(client.unified.banks).toEqualTypeOf(client.banks);
  });
});
