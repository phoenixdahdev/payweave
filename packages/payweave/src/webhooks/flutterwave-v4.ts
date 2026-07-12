/**
 * Flutterwave v4 webhook verification (TDD §10). HMAC-SHA256 over the RAW body,
 * BASE64 digest, keyed with the dashboard secret hash. Timing-safe with a
 * length-guard; fails closed on a missing header. Active only when the client's
 * configured `version` is `"v4"` — never accept both v3 and v4 on one client.
 *
 * Docs: https://developer.flutterwave.com/docs/webhooks (v4 selector) ⚠️ verify
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @param rawBody - Exact received bytes (never a re-serialized object).
 * @param signatureHeader - Value of the `flutterwave-signature` header.
 * @param webhookSecret - Dashboard secret hash (HMAC-SHA256 key).
 * @returns `true` iff the signature matches; `false` otherwise (never throws).
 */
export function verifyFlutterwaveV4(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
): boolean {
  const digest = createHmac("sha256", webhookSecret).update(rawBody).digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const received = Buffer.from(signatureHeader ?? "", "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
