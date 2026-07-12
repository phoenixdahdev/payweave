/**
 * Shared Paystack schema primitives (envelope, pagination meta, metadata, list
 * query). Paystack wraps every response in `{ status: boolean, message: string,
 * data: ... }` (provider-reference §1). Response schemas are LOOSE
 * ({@link https://zod.dev | zod v4 `looseObject`}) so unknown provider fields
 * pass straight through — drift is logged by the HttpClient, never thrown.
 */
import { z } from "zod";
import { PayweaveValidationError } from "../core/errors";

/**
 * Parse request input with a Zod schema, converting a {@link z.ZodError} into a
 * {@link PayweaveValidationError} so public methods only ever throw a
 * `PayweaveError` subclass (AGENTS.md §6). Runs BEFORE any network call.
 */
export function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  try {
    return schema.parse(input) as z.infer<S>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new PayweaveValidationError(`paystack request validation failed — ${detail}`, {
        provider: "paystack",
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Wrap a `data` schema in Paystack's standard response envelope.
 * `status` is a JSON boolean (NOT the string Flutterwave uses — quirk §5.5).
 */
export const paystackEnvelope = <T extends z.ZodTypeAny>(
  data: T,
): z.ZodType<{ status: boolean; message: string; data: z.infer<T> }> =>
  z.looseObject({
    status: z.boolean(),
    message: z.string(),
    data,
  }) as unknown as z.ZodType<{ status: boolean; message: string; data: z.infer<T> }>;

/**
 * Paystack pagination block (`GET` list endpoints). `perPage`/`page` come back
 * as numbers on most endpoints but the provider has been observed returning
 * strings — accept both (this is a response schema, loose by policy).
 */
export const paginationMeta = z.looseObject({
  total: z.union([z.number(), z.string()]).optional(),
  perPage: z.union([z.number(), z.string()]).optional(),
  page: z.union([z.number(), z.string()]).optional(),
  pageCount: z.union([z.number(), z.string()]).optional(),
  // Cursor pagination (e.g. `GET /bank`) uses next/previous instead of pageCount.
  next: z.string().nullable().optional(),
  previous: z.string().nullable().optional(),
});
export type PaginationMeta = z.infer<typeof paginationMeta>;

/** Envelope for list endpoints: `data` is an array plus a `meta` block. */
export const paystackListEnvelope = <T extends z.ZodTypeAny>(
  item: T,
): z.ZodType<{
  status: boolean;
  message: string;
  data: z.infer<T>[];
  meta?: PaginationMeta;
}> =>
  z.looseObject({
    status: z.boolean(),
    message: z.string(),
    data: z.array(item),
    meta: paginationMeta.optional(),
  }) as unknown as z.ZodType<{
    status: boolean;
    message: string;
    data: z.infer<T>[];
    meta?: PaginationMeta;
  }>;

/**
 * Paystack `metadata`. The API accepts an object OR a JSON string on some flows
 * (quirk §5.7); the SDK ALWAYS sends an object, so the request schema only
 * accepts an object. Arbitrary custom fields are allowed.
 */
export const metadataSchema = z.record(z.string(), z.unknown());

/** Fields shared by every paginated `GET` list request. */
export const listQueryFields = {
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
};

/** Coerce a possibly-string pagination number to a number (or undefined). */
export function metaNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
