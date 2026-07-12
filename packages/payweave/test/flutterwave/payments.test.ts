import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveValidationError } from "../../src/core/errors";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

describe("payments.create (Standard)", () => {
  it("POSTs to /payments with amount in MAJOR units unchanged and returns data.link", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/payments",
        json: loadFixture("flutterwave", "payments", "create.success"),
      },
    ]);

    const res = await h.client.payments.create({
      tx_ref: "pwv_tx_001",
      amount: 5000, // ₦5,000 in major units — Surface A passes it through untouched
      currency: "NGN",
      redirect_url: "https://example.com/callback",
      customer: { email: "buyer@example.com" },
    });

    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/payments");
    expect(req.headers.get("authorization")).toBe("Bearer FLWSECK_TEST-harness");
    expect(req.headers.get("content-type")).toContain("application/json");
    expect(req.headers.get("accept")).toContain("application/json");
    // Acceptance: amount reaches Flutterwave in major units, unchanged.
    expect(req.body).toMatchObject({ tx_ref: "pwv_tx_001", amount: 5000, currency: "NGN" });

    // Acceptance: the checkout link is surfaced at data.link, and status is the STRING "success".
    expect(res.status).toBe("success");
    expect(res.data.link).toContain("checkout.flutterwave.com");
  });

  it("throws PayweaveValidationError before sending when customer.email is missing", async () => {
    h = await makeFlutterwave([]);
    await expect(
      // @ts-expect-error — intentionally invalid input (no customer)
      h.client.payments.create({ tx_ref: "x", amount: 5000 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});
