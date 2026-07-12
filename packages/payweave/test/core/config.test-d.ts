import { describe, it, expectTypeOf } from "vitest";
import type {
  PaystackConfig,
  FlutterwaveV3Config,
  FlutterwaveV4Config,
} from "../../src/core/config";

describe("config union shapes", () => {
  it("Paystack requires secretKey and has no OAuth fields", () => {
    expectTypeOf<PaystackConfig>().toHaveProperty("secretKey");
    expectTypeOf<PaystackConfig>().not.toHaveProperty("clientId");
    expectTypeOf<PaystackConfig["provider"]>().toEqualTypeOf<"paystack">();
  });

  it("Flutterwave v3 uses secretKey with optional version", () => {
    expectTypeOf<FlutterwaveV3Config>().toHaveProperty("secretKey");
    expectTypeOf<FlutterwaveV3Config["version"]>().toEqualTypeOf<"v3" | undefined>();
  });

  it("Flutterwave v4 requires clientId + clientSecret", () => {
    expectTypeOf<FlutterwaveV4Config>().toHaveProperty("clientId");
    expectTypeOf<FlutterwaveV4Config>().toHaveProperty("clientSecret");
    expectTypeOf<FlutterwaveV4Config["version"]>().toEqualTypeOf<"v4">();
  });
});
