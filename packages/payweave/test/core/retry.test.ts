import { describe, expect, it } from "vitest";
import {
  isRetryableStatus,
  isRetryableRequest,
  backoffDelay,
  parseRetryAfter,
  DEFAULT_RETRY_POLICY,
  RETRY_AFTER_CAP_MS,
} from "../../src/core/retry";

describe("isRetryableStatus", () => {
  it("covers 429 + retryable 5xx only", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 404, 422, 501]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("isRetryableRequest", () => {
  it("GET is always eligible", () => {
    expect(isRetryableRequest("GET")).toBe(true);
    expect(isRetryableRequest("get")).toBe(true);
  });

  it("a bare POST is NEVER eligible, but a POST with an idempotency key is", () => {
    expect(isRetryableRequest("POST")).toBe(false);
    expect(isRetryableRequest("POST", "idem-123")).toBe(true);
    expect(isRetryableRequest("DELETE")).toBe(false);
  });
});

describe("backoffDelay (full jitter)", () => {
  it("returns 0 at rng=0 and approaches the ceiling at rng→1", () => {
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0)).toBe(0);
    // ceiling for attempt 0 = base*2^0 = 250
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0.999)).toBeLessThanOrEqual(250);
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0.999)).toBeGreaterThan(240);
  });

  it("caps the ceiling at capMs", () => {
    // attempt 10 would be 250*1024 without a cap; capped at 8000.
    expect(backoffDelay(10, DEFAULT_RETRY_POLICY, () => 1)).toBeLessThanOrEqual(8000);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds capped at 30s", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("999")).toBe(RETRY_AFTER_CAP_MS);
  });

  it("parses an HTTP-date relative to now, capped and floored at 0", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    // past date → 0
    expect(parseRetryAfter("Thu, 01 Jan 2020 00:00:00 GMT", now)).toBe(0);
  });

  it("returns null for missing/blank/garbage values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});
