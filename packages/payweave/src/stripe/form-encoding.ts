/**
 * Deterministic `application/x-www-form-urlencoded` serializer for Stripe
 * request bodies. Stripe "accepts form-encoded
 * request bodies" (https://docs.stripe.com/api — verified 2026-07-12); it does
 * NOT accept JSON. Structure is expressed with Rack-style bracket notation:
 *
 * - nested dictionaries:  `metadata[order_id]=6735`
 *   (https://docs.stripe.com/api/metadata — verified 2026-07-12)
 * - arrays of objects:    `line_items[0][price]=...&line_items[0][quantity]=2`
 *   (https://docs.stripe.com/api/checkout/sessions/create curl example —
 *   verified 2026-07-12)
 * - arrays of scalars:    `expand[0]=customer&expand[1]=payment_intent.customer`
 *   — the docs' curl examples show the empty-bracket form (`expand[]=customer`,
 *   https://docs.stripe.com/api/expanding_objects — verified 2026-07-12);
 *   Stripe's server parses both, and we always emit EXPLICIT indices (the
 *   convention of Stripe's official libraries) so output is deterministic and
 *   element order is unambiguous.
 *
 * Determinism rule: INSERTION ORDER. Object keys are emitted in their JS
 * insertion order (the order the Zod request schema / caller built them) and
 * array elements in ascending index order — encoding the same value always
 * yields the same bytes, and no re-sorting ever reorders a payload.
 *
 * Value semantics:
 * - strings pass through; numbers/booleans are stringified (`500`, `true`);
 * - `null`/`undefined` entries are OMITTED entirely — Stripe's convention for
 *   unsetting a field is an EMPTY STRING value (e.g. `description=`), which
 *   callers express explicitly with `""`; we never invent an unset;
 * - empty objects/arrays contribute no pairs;
 * - non-finite numbers and non-JSON values (Date, function, symbol, bigint)
 *   throw {@link PayweaveValidationError} naming the offending key path —
 *   request Zod schemas validate shapes BEFORE encoding, so hitting this is a
 *   programming error, not provider drift.
 *
 * Percent-encoding: `encodeURIComponent` (RFC 3986) on every key segment and
 * value — space → `%20`, `+` → `%2B`, `&` → `%26`, `=` → `%3D`, `%` → `%25`,
 * non-ASCII → UTF-8 escapes. Structural brackets are emitted literally,
 * matching the exact wire format of the docs' own curl examples.
 */
import { PayweaveValidationError } from "../core/errors";
import type { EncodedBody } from "../core/http";

/** The Content-Type every Stripe request body is sent with. */
export const STRIPE_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Plain-object check — accepts null-prototype objects, rejects class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (typeof value === "number") return `non-finite number ${String(value)}`;
  if (value instanceof Date) return "Date (pass a Unix timestamp in seconds instead)";
  return `unsupported value of type ${typeof value}`;
}

function unsupported(path: string, value: unknown): PayweaveValidationError {
  return new PayweaveValidationError(
    `Cannot form-encode "${path}" for Stripe: ${describe(value)}.`,
    { provider: "stripe" },
  );
}

/**
 * Append the `key=value` pairs for one value under an already-bracketed key.
 * Recurses depth-first so nested order mirrors the input's insertion order.
 */
function appendPairs(pairs: string[], key: string, value: unknown): void {
  // null/undefined are omitted at EVERY depth (see module JSDoc — unsetting is
  // an explicit empty string in Stripe's API, never an implicit null).
  if (value === undefined || value === null) return;
  switch (typeof value) {
    case "string":
      pairs.push(`${key}=${encodeURIComponent(value)}`);
      return;
    case "boolean":
      pairs.push(`${key}=${value ? "true" : "false"}`);
      return;
    case "number":
      if (!Number.isFinite(value)) throw unsupported(key, value);
      pairs.push(`${key}=${encodeURIComponent(String(value))}`);
      return;
    default:
      break;
  }
  if (Array.isArray(value)) {
    // Explicit ascending indices; an omitted (null/undefined) element keeps
    // later elements at their POSITIONAL index so pairs stay unambiguous.
    for (let i = 0; i < value.length; i += 1) {
      appendPairs(pairs, `${key}[${i}]`, value[i]);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      appendPairs(pairs, `${key}[${encodeURIComponent(childKey)}]`, childValue);
    }
    return;
  }
  throw unsupported(key, value);
}

/**
 * Encode a Stripe request body as deterministic bracket-notation form data.
 * This is the `BodyEncoder` the Stripe `HttpClient` is constructed with (see
 * `src/stripe/http-options`) — with it in place, no JSON body ever leaves the
 * Stripe client.
 *
 * @example
 * encodeStripeForm({ mode: "payment", line_items: [{ price: "price_1", quantity: 2 }] });
 * // → { contentType: "application/x-www-form-urlencoded",
 * //     body: "mode=payment&line_items[0][price]=price_1&line_items[0][quantity]=2" }
 */
export function encodeStripeForm(body: unknown): EncodedBody {
  if (!isPlainObject(body)) {
    throw new PayweaveValidationError(
      "Stripe request bodies must be plain objects (validated by the request schema before encoding).",
      { provider: "stripe" },
    );
  }
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    appendPairs(pairs, encodeURIComponent(key), value);
  }
  return { contentType: STRIPE_FORM_CONTENT_TYPE, body: pairs.join("&") };
}
