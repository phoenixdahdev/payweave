/**
 * Internal, type-safe readers for provider response envelopes used by the
 * unified layer. The unified ops call `http.request` WITHOUT a response schema
 * (staying decoupled from Surface A schemas), so responses arrive as `unknown` —
 * these helpers narrow them without ever reaching for `any`.
 *
 * Both providers wrap payloads in `{ status, message, data }` (Paystack `status`
 * is a boolean; Flutterwave's is the string `"success"`); either way the useful
 * payload is under `data`. `raw` on every unified result is the WHOLE envelope.
 */

/** Narrow an unknown to a plain object, or `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Narrow an unknown to an array of records (drops non-object entries). */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (rec) out.push(rec);
  }
  return out;
}

/** Read a string field from a record, or `undefined`. */
export function readString(
  rec: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = rec?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a numeric field from a record, or `undefined`. */
export function readNumber(
  rec: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const v = rec?.[key];
  return typeof v === "number" ? v : undefined;
}

/** The `data` object out of a `{ status, message, data }` envelope. */
export function envelopeData(envelope: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(envelope)?.data);
}

/** The `data` array out of a `{ status, message, data: [...] }` envelope. */
export function envelopeDataArray(envelope: unknown): Record<string, unknown>[] {
  return asRecordArray(asRecord(envelope)?.data);
}
