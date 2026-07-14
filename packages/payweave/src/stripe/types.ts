/**
 * Shared Stripe schema primitives: request-parse helper, the
 * `{ object: "list", data, has_more }` list schema, the cursor iterator every
 * Stripe list endpoint reuses, and the query flattener for nested filters.
 *
 * Stripe has NO response envelope — resources come back bare, so unlike
 * `paystack/types.ts` there are no `{status, message, data}`
 * unwrapping helpers here. Response schemas are LOOSE (`z.looseObject`) so
 * unknown provider fields pass straight through — drift is logged by the
 * HttpClient, never thrown.
 *
 * Pagination (verified 2026-07-12 against https://docs.stripe.com/api/pagination):
 * list endpoints take `limit` (1–100, default 10), `starting_after` and
 * `ending_before` cursors, and respond with
 * `{ object: "list", data: [...], has_more, url }`. The iterator walks
 * `has_more` pages forward by passing the LAST item's `id` as `starting_after`.
 */
import { z } from "zod";
import { PayweaveValidationError } from "../core/errors";
import type { QueryValue } from "../core/http";

/**
 * Parse request input with a Zod schema, converting a {@link z.ZodError} into a
 * {@link PayweaveValidationError} so public methods only ever throw a
 * `PayweaveError` subclass. Runs BEFORE any network call — and
 * therefore before the form encoder ever sees the body.
 */
export function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  try {
    return schema.parse(input) as z.infer<S>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new PayweaveValidationError(`stripe request validation failed — ${detail}`, {
        provider: "stripe",
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Stripe `metadata` request map. Values reach Stripe as strings (the form
 * encoder stringifies numbers/booleans); ≤50 keys, keys ≤40 chars, values ≤500
 * chars, square brackets forbidden in keys — enforced provider-side
 * (https://docs.stripe.com/api/metadata — verified 2026-07-12).
 */
export const metadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

/**
 * `created` range filter used by Stripe list endpoints — a dictionary of Unix
 * timestamps (https://docs.stripe.com/api/payment_intents/list — verified
 * 2026-07-12). Flattened to `created[gte]=...` query params by
 * {@link flattenQuery}.
 */
export const createdRange = z.object({
  gt: z.number().int().optional(),
  gte: z.number().int().optional(),
  lt: z.number().int().optional(),
  lte: z.number().int().optional(),
});

/** Cursor-pagination fields shared by every Stripe list request. */
export const listCursorFields = {
  /** Page size, 1–100 (Stripe default 10). */
  limit: z.number().int().min(1).max(100).optional(),
  /** Cursor: object id — return items AFTER this id (next page). */
  starting_after: z.string().optional(),
  /** Cursor: object id — return items BEFORE this id (previous page). */
  ending_before: z.string().optional(),
};

/** The shape every Stripe list response parses to. */
export interface StripeList<TItem> {
  object: string;
  data: TItem[];
  has_more: boolean;
  url?: string;
}

/**
 * Loose schema for Stripe's `{ object: "list", data, has_more, url }` list
 * response. `object` stays `z.string()` — response schemas tolerate drift,
 * never throw.
 */
export const stripeList = <T extends z.ZodTypeAny>(
  item: T,
): z.ZodType<StripeList<z.infer<T>>> =>
  z.looseObject({
    object: z.string(),
    data: z.array(item),
    has_more: z.boolean(),
    url: z.string().optional(),
  }) as unknown as z.ZodType<StripeList<z.infer<T>>>;

/**
 * Walk a Stripe cursor-paginated list to exhaustion: yield every item of every
 * page, requesting the next page with `starting_after = <last item's id>` while
 * `has_more` is true (https://docs.stripe.com/api/pagination — verified
 * 2026-07-12). `fetchPage` receives the cursor for the page to load
 * (`undefined` for the first page).
 */
export async function* iterateStripeList<T extends { id: string }>(
  fetchPage: (startingAfter: string | undefined) => Promise<StripeList<T>>,
): AsyncGenerator<T, void, undefined> {
  let startingAfter: string | undefined;
  for (;;) {
    const page = await fetchPage(startingAfter);
    for (const item of page.data) yield item;
    const last = page.data[page.data.length - 1];
    if (!page.has_more || last === undefined) return;
    startingAfter = last.id;
  }
}

/**
 * Flatten an already-validated query object for the URL: scalars pass through,
 * ONE level of nested dictionary (e.g. `created: { gte }`,
 * `customer_details: { email }`) becomes bracket keys (`created[gte]`) —
 * Stripe's GET-parameter convention, mirroring the body encoder's bracket
 * notation. `undefined`/`null` entries are dropped (matching HttpClient's own
 * query handling).
 */
export function flattenQuery(query: Record<string, unknown>): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childValue === undefined || childValue === null) continue;
        out[`${key}[${childKey}]`] = childValue as QueryValue;
      }
      continue;
    }
    out[key] = value as QueryValue;
  }
  return out;
}

/** Options accepted by Stripe POST methods that support idempotent replay. */
export interface StripeRequestOptions {
  /**
   * `Idempotency-Key` header value (https://docs.stripe.com/api/idempotent_requests
   * — verified 2026-07-12: POST-only, ≤255 chars, keys stored 24h, replay
   * returns the original response). Providing one ALSO makes the POST
   * retry-eligible under Payweave's retry policy — bare
   * POSTs are never auto-retried.
   */
  idempotencyKey?: string;
}

/** Validate a non-empty Stripe object id, throwing PayweaveValidationError. */
export function requireId(value: string, what: string): string {
  return parseRequest(z.string().min(1, `${what} id must be a non-empty string`), value);
}

/**
 * The shape every Stripe SEARCH response parses to
 * (https://docs.stripe.com/api/pagination/search — verified 2026-07-12).
 * `total_count` appears only when explicitly expanded (accurate up to 10,000).
 */
export interface StripeSearchPage<TItem> {
  object: string;
  data: TItem[];
  has_more: boolean;
  /** Token for the next page — pass as `page`. Absent/null on the last page. */
  next_page?: string | null;
  url?: string;
  /** Only present when expanded; accurate up to 10,000. */
  total_count?: number;
}

/**
 * Loose schema for Stripe's `{ object: "search_result", data, has_more,
 * next_page }` search response (see {@link StripeSearchPage}). `object` stays
 * `z.string()` — response schemas tolerate drift, never throw.
 */
export const stripeSearchResult = <T extends z.ZodTypeAny>(
  item: T,
): z.ZodType<StripeSearchPage<z.infer<T>>> =>
  z.looseObject({
    object: z.string(),
    data: z.array(item),
    has_more: z.boolean(),
    next_page: z.string().nullable().optional(),
    url: z.string().optional(),
    total_count: z.number().optional(),
  }) as unknown as z.ZodType<StripeSearchPage<z.infer<T>>>;

/**
 * Walk a Stripe SEARCH result to exhaustion: yield every item of every page,
 * requesting the next page with `page = <next_page token>` while `has_more`
 * is true (https://docs.stripe.com/api/pagination/search — verified
 * 2026-07-12). Search pagination is token-based — deliberately separate from
 * `iterateStripeList`'s `starting_after` cursor walk. `fetchPage` receives
 * the token for the page to load (`undefined` for the first page).
 */
export async function* iterateStripeSearch<T>(
  fetchPage: (page: string | undefined) => Promise<StripeSearchPage<T>>,
): AsyncGenerator<T, void, undefined> {
  let page: string | undefined;
  for (;;) {
    const result = await fetchPage(page);
    for (const item of result.data) yield item;
    if (!result.has_more || result.next_page == null) return;
    page = result.next_page;
  }
}
