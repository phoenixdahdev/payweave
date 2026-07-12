/**
 * `signWebhook` (PW-008, TDD §10) — produce valid header+body pairs matching
 * each provider's verify scheme, for consumer tests and our own. Consumers must
 * verify against the SAME `body` string returned here (verification runs on
 * exact bytes — never re-serialize).
 */
import { createHmac } from "node:crypto";

/** Webhook schemes we can sign for. `flutterwave` = v3; `flutterwave-v4` = v4. */
export type SignWebhookProvider = "paystack" | "flutterwave" | "flutterwave-v4";

/** A signed webhook: the exact body bytes plus the header to send with them. */
export interface SignedWebhook {
  /** Canonical header name for the scheme. */
  headerName: string;
  /** Header value (signature or secret hash). */
  header: string;
  /** Exact request body — pass THIS string to the verify function. */
  body: string;
  /** Convenience map: `{ [headerName]: header }`. */
  headers: Record<string, string>;
}

const HEADER_NAMES: Record<SignWebhookProvider, string> = {
  paystack: "x-paystack-signature",
  flutterwave: "verif-hash",
  "flutterwave-v4": "flutterwave-signature",
};

function toBody(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/**
 * Sign `payload` for `provider`, returning the header + the exact body to send.
 *
 * - `paystack`: HMAC-SHA512 hex, keyed with the secret key.
 * - `flutterwave` (v3): the secret hash itself (plain equality, no HMAC).
 * - `flutterwave-v4`: HMAC-SHA256 base64, keyed with the dashboard secret hash.
 *
 * @example
 * const { header, body, headerName } = signWebhook("paystack", event, secret);
 * verifyPaystack(body, header, secret); // true
 */
export function signWebhook(
  provider: SignWebhookProvider,
  payload: unknown,
  secret: string,
): SignedWebhook {
  const body = toBody(payload);
  const headerName = HEADER_NAMES[provider];
  let header: string;
  switch (provider) {
    case "paystack":
      header = createHmac("sha512", secret).update(body).digest("hex");
      break;
    case "flutterwave":
      header = secret;
      break;
    case "flutterwave-v4":
      header = createHmac("sha256", secret).update(body).digest("base64");
      break;
  }
  return { headerName, header, body, headers: { [headerName]: header } };
}
