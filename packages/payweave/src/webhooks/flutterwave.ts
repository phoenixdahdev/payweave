/**
 * Flutterwave v3 webhook verification (TDD §10). v3 uses NO HMAC: the
 * `verif-hash` header must equal the dashboard secret hash verbatim. Compared
 * timing-safely with a length-guard; fails closed on a missing header.
 *
 * Docs: https://developer.flutterwave.com/docs/webhooks (v3 selector)
 * Note: the FLW webhook secret is the dashboard "secret hash", NOT the API key.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * @param verifHashHeader - Value of the `verif-hash` header.
 * @param webhookSecret - Dashboard secret hash configured for webhooks.
 * @returns `true` iff the header equals the secret hash; `false` otherwise.
 */
export function verifyFlutterwaveV3(
  verifHashHeader: string | null | undefined,
  webhookSecret: string,
): boolean {
  const received = Buffer.from(verifHashHeader ?? "", "utf8");
  const expected = Buffer.from(webhookSecret, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
