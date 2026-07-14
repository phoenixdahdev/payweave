/**
 * Flutterwave **v3** card-payload encryption.
 *
 * Card charges (`POST /charges?type=card`) require the JSON payload to be
 * encrypted with the account's **Encryption Key** using 3DES-EDE3 in ECB mode,
 * base64-encoded, and sent as `{ client: <ciphertext> }`. This module is the
 * SINGLE place that touches plaintext card data — isolate it, never log the
 * plaintext, and never widen its surface.
 *
 * Algorithm: `des-ede3` (Triple DES, EDE3, ECB — no IV), PKCS#7 padding (Node's
 * default), base64 output. The Encryption Key from the Flutterwave dashboard is
 * a 24-character string used directly as the 24-byte key.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/docs/integration-guides/encryption
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { PayweaveConfigError } from "../../core/errors";

/**
 * Encrypt a card-charge payload with the Flutterwave v3 Encryption Key.
 *
 * @param encryptionKey - The 24-char dashboard Encryption Key (NOT the secret
 *   API key). 3DES-EDE3 requires a 24-byte key.
 * @param payload - The plaintext charge object (card number, cvv, expiry, …).
 * @returns The base64 ciphertext to send as `{ client: <ciphertext> }`.
 *
 * ⚠️ Never log `payload` or its stringified form — it carries raw PAN/CVV.
 */
export function encryptCharge(encryptionKey: string, payload: unknown): string {
  const key = toKey(encryptionKey);
  const plaintext = JSON.stringify(payload);
  // ECB mode uses no IV — pass `null`. Node applies PKCS#7 padding by default.
  const cipher = createCipheriv("des-ede3", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return encrypted.toString("base64");
}

/**
 * Decrypt a Flutterwave v3 ciphertext back to its JSON payload. Provided so the
 * encrypt step can be round-trip unit-tested; not used on the request path.
 */
export function decryptCharge(encryptionKey: string, ciphertext: string): unknown {
  const key = toKey(encryptionKey);
  const decipher = createDecipheriv("des-ede3", key, null);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as unknown;
}

/**
 * Coerce the dashboard Encryption Key to the 24-byte buffer `des-ede3` needs.
 * A 24-char ASCII key maps 1:1 to 24 bytes. Reject an obviously-wrong length
 * with a config error rather than letting `node:crypto` throw an opaque one.
 */
function toKey(encryptionKey: string): Buffer {
  const key = Buffer.from(encryptionKey, "utf8");
  if (key.length !== 24) {
    throw new PayweaveConfigError(
      "Flutterwave v3 encryptionKey must be the 24-character dashboard Encryption Key (3DES needs a 24-byte key).",
      { provider: "flutterwave" },
    );
  }
  return key;
}
