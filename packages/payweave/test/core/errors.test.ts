import { describe, expect, it } from "vitest";
import {
  PayweaveError,
  PayweaveConfigError,
  PayweaveAuthError,
  PayweaveValidationError,
  PayweaveNotFoundError,
  PayweaveRateLimitError,
  PayweaveProviderError,
  PayweaveNetworkError,
  PayweaveWebhookVerificationError,
  mapHttpError,
} from "../../src/core/errors";

describe("error classes", () => {
  it("carry name, provider, and retryability defaults", () => {
    expect(new PayweaveConfigError("x").name).toBe("PayweaveConfigError");
    expect(new PayweaveConfigError("x").isRetryable).toBe(false);
    expect(new PayweaveAuthError("x").isRetryable).toBe(false);
    expect(new PayweaveValidationError("x").isRetryable).toBe(false);
    expect(new PayweaveNotFoundError("x").isRetryable).toBe(false);
    expect(new PayweaveProviderError("x").isRetryable).toBe(true);
    expect(new PayweaveWebhookVerificationError("x").isRetryable).toBe(false);
    expect(new PayweaveError("x").provider).toBe("unknown");
  });

  it("PayweaveNetworkError is always retryable", () => {
    expect(new PayweaveNetworkError("x", { isRetryable: false }).isRetryable).toBe(true);
  });

  it("all subclasses are instanceof PayweaveError", () => {
    expect(new PayweaveAuthError("x")).toBeInstanceOf(PayweaveError);
    expect(new PayweaveRateLimitError("x")).toBeInstanceOf(PayweaveError);
  });

  it("RateLimitError exposes retryAfterMs and serializes it", () => {
    const err = new PayweaveRateLimitError("slow down", {
      provider: "paystack",
      retryAfterMs: 5000,
    });
    expect(err.retryAfterMs).toBe(5000);
    expect(err.isRetryable).toBe(true);
    expect(err.toJSON().retryAfterMs).toBe(5000);
  });

  it("toJSON redacts raw and never leaks secrets", () => {
    const err = new PayweaveProviderError("boom", {
      provider: "paystack",
      raw: { Authorization: "Bearer sk_live_leak", note: "sk_test_leak2" },
    });
    const json = JSON.stringify(err.toJSON());
    expect(json).not.toContain("sk_live_leak");
    expect(json).not.toContain("sk_test_leak2");
    expect(err.toJSON().name).toBe("PayweaveProviderError");
  });

  it("chains cause for network errors", () => {
    const cause = new Error("ECONNRESET");
    const err = new PayweaveNetworkError("net", { provider: "flutterwave", cause });
    expect(err.cause).toBe(cause);
  });
});

describe("mapHttpError", () => {
  const body = { message: "nope", code: "E123", reference: "req_1" };

  it("maps statuses to the right class", () => {
    expect(mapHttpError("paystack", 401, body)).toBeInstanceOf(PayweaveAuthError);
    expect(mapHttpError("paystack", 403, body)).toBeInstanceOf(PayweaveAuthError);
    expect(mapHttpError("paystack", 400, body)).toBeInstanceOf(PayweaveValidationError);
    expect(mapHttpError("paystack", 422, body)).toBeInstanceOf(PayweaveValidationError);
    expect(mapHttpError("paystack", 404, body)).toBeInstanceOf(PayweaveNotFoundError);
    expect(mapHttpError("paystack", 429, body)).toBeInstanceOf(PayweaveRateLimitError);
    expect(mapHttpError("paystack", 500, body)).toBeInstanceOf(PayweaveProviderError);
    expect(mapHttpError("paystack", 503, body)).toBeInstanceOf(PayweaveProviderError);
  });

  it("extracts provider message/code/requestId from the body", () => {
    const err = mapHttpError("flutterwave", 400, body);
    expect(err.providerMessage).toBe("nope");
    expect(err.providerCode).toBe("E123");
    expect(err.requestId).toBe("req_1");
    expect(err.httpStatus).toBe(400);
    expect(err.provider).toBe("flutterwave");
  });

  it("5xx is retryable; unexpected 4xx is not", () => {
    expect(mapHttpError("paystack", 502, body).isRetryable).toBe(true);
    expect(mapHttpError("paystack", 418, body).isRetryable).toBe(false);
  });

  it("threads retryAfterMs and an explicit requestId via extra", () => {
    const err = mapHttpError("paystack", 429, body, {
      retryAfterMs: 2000,
      requestId: "override",
    }) as PayweaveRateLimitError;
    expect(err.retryAfterMs).toBe(2000);
    expect(err.requestId).toBe("override");
  });

  it("tolerates a non-object body", () => {
    const err = mapHttpError("paystack", 500, "Internal Server Error");
    expect(err.providerMessage).toBeUndefined();
    expect(err).toBeInstanceOf(PayweaveProviderError);
  });
});
