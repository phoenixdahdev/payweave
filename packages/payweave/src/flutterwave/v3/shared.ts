/**
 * Shared Flutterwave **v3** schema primitives (envelope, pagination, metadata,
 * request-parse helper). Version-isolated per AGENTS.md: these are
 * NEVER shared with v4 — v4 uses a different envelope + pagination shape.
 *
 * Flutterwave v3 wraps every response in
 *   `{ status: "success" | "error", message: string, data: ... }`
 * where `status` is a STRING — do NOT reuse Paystack's
 * boolean-`status` envelope here. Response schemas are LOOSE
 * ({@link https://zod.dev | zod `looseObject`}) so unknown provider fields pass
 * straight through — drift is logged by the HttpClient, never thrown.
 */
import { z } from "zod";
import { PayweaveValidationError } from "../../core/errors";

/**
 * Parse request input with a Zod schema, converting a {@link z.ZodError} into a
 * {@link PayweaveValidationError} so public methods only ever throw a
 * `PayweaveError` subclass. Runs BEFORE any network call.
 */
export function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  try {
    return schema.parse(input) as z.infer<S>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new PayweaveValidationError(`flutterwave request validation failed — ${detail}`, {
        provider: "flutterwave",
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Wrap a `data` schema in Flutterwave v3's standard response envelope.
 * `status` is the STRING `"success"`/`"error"` — not a boolean.
 */
export const flwEnvelope = <T extends z.ZodTypeAny>(
  data: T,
): z.ZodType<{ status: string; message: string; data: z.infer<T> }> =>
  z.looseObject({
    status: z.string(),
    message: z.string(),
    data,
  }) as unknown as z.ZodType<{ status: string; message: string; data: z.infer<T> }>;

/**
 * Flutterwave v3 pagination block. List endpoints return
 * `meta: { page_info: { total, current_page, total_pages } }`
 * Loose + string|number tolerant by response policy.
 */
export const pageInfo = z.looseObject({
  total: z.union([z.number(), z.string()]).optional(),
  current_page: z.union([z.number(), z.string()]).optional(),
  total_pages: z.union([z.number(), z.string()]).optional(),
});
export type PageInfo = z.infer<typeof pageInfo>;

/** The `meta` block on a v3 list response. */
export const listMeta = z.looseObject({
  page_info: pageInfo.optional(),
});
export type ListMeta = z.infer<typeof listMeta>;

/** Envelope for v3 list endpoints: `data` is an array plus a `meta.page_info`. */
export const flwListEnvelope = <T extends z.ZodTypeAny>(
  item: T,
): z.ZodType<{
  status: string;
  message: string;
  data: z.infer<T>[];
  meta?: ListMeta;
}> =>
  z.looseObject({
    status: z.string(),
    message: z.string(),
    data: z.array(item),
    meta: listMeta.optional(),
  }) as unknown as z.ZodType<{
    status: string;
    message: string;
    data: z.infer<T>[];
    meta?: ListMeta;
  }>;

/**
 * Flutterwave `meta` on a request is free-form merchant metadata (an object of
 * custom key/values). The SDK always sends an object.
 */
export const metaSchema = z.record(z.string(), z.unknown());

/** Coerce a possibly-string pagination number to a number (or undefined). */
export function metaNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
