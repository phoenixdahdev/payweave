import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signWebhook } from "../../src/testing/sign-webhook";
import { loadFixture } from "../../src/testing/fixtures";
import { createMswServer } from "../../src/testing/msw";
import { verifyPaystack } from "../../src/webhooks/paystack";
import { verifyFlutterwaveV3 } from "../../src/webhooks/flutterwave";
import { verifyFlutterwaveV4 } from "../../src/webhooks/flutterwave-v4";
import { verifyStripe } from "../../src/webhooks/stripe";

const payload = { event: "charge.success", data: { id: 42 } };

describe("signWebhook round-trips against the verify primitives", () => {
  it("paystack", () => {
    const s = signWebhook("paystack", payload, "secret");
    expect(verifyPaystack(s.body, s.header, "secret")).toBe(true);
    expect(s.headerName).toBe("x-paystack-signature");
    expect(s.headers[s.headerName]).toBe(s.header);
  });

  it("flutterwave v3", () => {
    const s = signWebhook("flutterwave", payload, "hash");
    expect(verifyFlutterwaveV3(s.header, "hash")).toBe(true);
    expect(s.headerName).toBe("verif-hash");
  });

  it("flutterwave v4", () => {
    const s = signWebhook("flutterwave-v4", payload, "hash");
    expect(verifyFlutterwaveV4(s.body, s.header, "hash")).toBe(true);
    expect(s.headerName).toBe("flutterwave-signature");
  });

  it("signs a string payload verbatim", () => {
    const s = signWebhook("paystack", "raw-string-body", "secret");
    expect(s.body).toBe("raw-string-body");
    expect(verifyPaystack("raw-string-body", s.header, "secret")).toBe(true);
  });

  it("stripe", () => {
    const s = signWebhook("stripe", payload, "whsec_x");
    expect(verifyStripe(s.body, s.header, "whsec_x")).toBe(true);
    expect(s.headerName).toBe("stripe-signature");
    expect(s.headers[s.headerName]).toBe(s.header);
  });

  it("stripe honors a timestamp override for tolerance tests", () => {
    const ts = 1_752_300_000;
    const s = signWebhook("stripe", payload, "whsec_x", { timestamp: ts });
    expect(s.header.startsWith(`t=${ts},v1=`)).toBe(true);
    expect(verifyStripe(s.body, s.header, "whsec_x", { now: () => ts })).toBe(true);
    expect(verifyStripe(s.body, s.header, "whsec_x", { now: () => ts + 301 })).toBe(false);
  });
});

describe("loadFixture", () => {
  it("reads and parses a committed fixture", () => {
    const fx = loadFixture("paystack", "transactions", "initialize.success") as {
      status: boolean;
      data: { authorization_url: string };
    };
    expect(fx.status).toBe(true);
    expect(fx.data.authorization_url).toContain("checkout.paystack.com");
  });
});

describe("createMswServer", () => {
  const routes = [
    { method: "post" as const, url: "https://api.mock.test/transaction", json: { ok: true } },
  ];
  let server: Awaited<ReturnType<typeof createMswServer>>;

  beforeAll(async () => {
    server = await createMswServer(routes);
    server.listen();
  });
  afterAll(() => server.close());

  it("mocks at the network edge", async () => {
    const res = await fetch("https://api.mock.test/transaction", { method: "POST" });
    expect(await res.json()).toEqual({ ok: true });
  });
});
