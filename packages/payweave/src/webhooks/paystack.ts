/**
 * Paystack webhook verification. HMAC-SHA512 over the RAW request
 * body, hex digest, keyed with the API secret key. Timing-safe with a
 * length-guard; fails closed on a missing/short header.
 *
 * Docs: https://paystack.com/docs/payments/webhooks/#verify-event-origin
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @param rawBody - Exact received bytes (never a re-serialized object).
 * @param signatureHeader - Value of the `x-paystack-signature` header.
 * @param secret - Paystack API secret key (`sk_live_*` / `sk_test_*`).
 * @returns `true` iff the signature matches; `false` otherwise (never throws).
 */
export function verifyPaystack(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  const digest = createHmac("sha512", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(digest, "utf8");
  const received = Buffer.from(signatureHeader ?? "", "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
