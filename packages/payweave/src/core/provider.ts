/**
 * Provider adapter contract v2.
 * Third parties (and our own three adapters) implement {@link ProviderAdapter};
 * {@link defineProvider} is the Arcie-style identity helper that also validates
 * the shape at runtime. Adapters may depend ONLY on `core/`; `unified/` depends
 * on adapters, never the reverse.
 *
 * v2 additions over the v1 shape (additive — every v1 field is unchanged):
 * - `configKey` + `configSchema`: the root config key an adapter registers
 *   under and the Zod schema validating its slice of config, so third-party
 *   adapters can compose onto `createPayweave`'s config WITHOUT core edits
 * - `webhooks.signatureHeader`: the webhook signature header name this
 *   adapter's scheme is detected by — the multi-provider
 *   dispatcher matches on header NAMES only, never the body.
 * - `unified`: unchanged shape, documented as a PARTIAL surface — an adapter
 *   may implement any subset of the unified ops (not every provider supports
 *   every op).
 * - `billing`: a typed placeholder for the billing-adapter conformance suite
 *   — present so adapters can start declaring the slot, not yet enforced or
 *   consumed anywhere.
 */
import { z } from "zod";
import { PayweaveConfigError } from "./errors";
import type { HttpClient, HeadersLike } from "./http";
import type { ResolvedProviderConfig } from "./config";

/** Per-environment endpoint spec. */
export interface EnvSpec {
  baseUrl: string;
}

/** Case-insensitive header source accepted by webhook verification. */
export type HeaderLookup = HeadersLike | Record<string, string | string[] | undefined>;

/**
 * Case-insensitive header lookup shared by adapter webhook verifiers. Accepts
 * a WHATWG `Headers` instance or a plain/array header record — an
 * explicitly-`undefined` record value counts as ABSENT. Mirrors (but does not
 * replace) `webhooks/dispatch.ts`'s own private detection-table lookup; kept
 * here so `core/`-only adapters never need to import from `webhooks/**`.
 */
export function readHeader(headers: HeaderLookup, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/** A provider-native webhook event after parsing (pre-normalization). */
export interface ProviderEvent {
  type: string;
  data: unknown;
  raw: unknown;
  id?: string;
}

/** A normalized, provider-agnostic event (fleshed out by the unified wave). */
export interface UnifiedEvent {
  provider: string;
  type: string;
  unifiedType: string;
  data: unknown;
  raw: unknown;
  dedupeKey?: string;
}

/**
 * Optional unified-layer operations an adapter can implement to join Surface
 * B. Deliberately loose/PARTIAL — a real adapter may (and
 * often does) implement only a subset of `UnifiedNamespace`'s ops; the actual
 * per-op shape lives in `unified/types.ts` (which `core/` never imports —
 * dependency direction is `unified/` → adapters → `core/`, never reversed).
 */
export type UnifiedOps = Record<string, unknown>;

/**
 * Billing-adapter conformance slot — a typed placeholder for third-party
 * adapters that want to participate in the billing surface
 * (`subscribe`/`check`/`report`); the shape is intentionally opaque today
 * (mirrors {@link UnifiedOps}'s own looseness) — the conformance suite that
 * gives it real structure and enforces it is separate follow-up work. Not
 * consumed anywhere yet.
 */
export type BillingOps = Record<string, unknown>;

/**
 * The contract every provider adapter satisfies. `id` is the
 * adapter's identity; `configKey` is the root config key it registers under
 * (usually equal to `id` — kept separate so a third-party adapter can choose
 * its own key without colliding). `webhooks.verify` runs on raw bytes with a
 * timing-safe comparison; `webhooks.toUnified` uses `unified/mappings.ts`.
 */
export interface ProviderAdapter {
  readonly id: string;
  /**
   * Root config key this adapter registers under — the
   * key third-party consumers pass to `createPayweave({ [configKey]: ... })`.
   */
  readonly configKey: string;
  /**
   * Zod schema validating this adapter's slice of the root config. Kept as a
   * loose `z.ZodType` (not generic over a config type) — same "assert
   * presence/shape, not signatures" philosophy {@link defineProvider} already
   * uses for the method fields below — so a third-party adapter's own config
   * shape composes onto the root schema without `core/` needing to know it.
   */
  configSchema: z.ZodType;
  readonly environments: { test: EnvSpec; live: EnvSpec };
  inferEnvironment(secretKey: string): "test" | "live" | null;
  createHttp(cfg: ResolvedProviderConfig): HttpClient;
  webhooks: {
    /**
     * The webhook signature header name this adapter's scheme is detected by
     * (e.g. `"stripe-signature"`). Drives multi-provider header dispatch —
     * matched case-insensitively, on the header NAME only.
     */
    signatureHeader: string;
    verify(input: { rawBody: string | Uint8Array; headers: HeaderLookup; secret: string }): boolean;
    parse(rawBody: string): ProviderEvent;
    toUnified(e: ProviderEvent): UnifiedEvent;
  };
  /** Partial unified-ops surface (Surface B) this adapter implements — see {@link UnifiedOps}. */
  unified?: UnifiedOps;
  /** Billing conformance slot (placeholder) — typed, not implemented. */
  billing?: BillingOps;
}

const isFn = (v: unknown): boolean => typeof v === "function";
const fnSchema = z.custom<(...args: never[]) => unknown>(isFn, {
  message: "expected a function",
});
const envSpecSchema = z.object({ baseUrl: z.string().min(1) });
const zodSchemaSchema = z.custom<z.ZodType>((v) => v instanceof z.ZodType, {
  message: "expected a zod schema",
});

/**
 * Structural runtime schema for a {@link ProviderAdapter}. Kept loose (methods
 * validated as functions) — we assert presence/shape, not signatures.
 */
const providerAdapterSchema = z.object({
  id: z.string().min(1),
  configKey: z.string().min(1),
  configSchema: zodSchemaSchema,
  environments: z.object({ test: envSpecSchema, live: envSpecSchema }),
  inferEnvironment: fnSchema,
  createHttp: fnSchema,
  webhooks: z.object({
    signatureHeader: z.string().min(1),
    verify: fnSchema,
    parse: fnSchema,
    toUnified: fnSchema,
  }),
  unified: z.record(z.string(), z.unknown()).optional(),
  billing: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Identity helper that validates an adapter's shape at runtime (Arcie `define*`
 * pattern). Returns the same object (typed) on success; throws
 * {@link PayweaveConfigError} describing the first structural problem otherwise.
 *
 * @example
 * const myProvider = defineProvider({ id: "acme", configKey: "acme", configSchema, ... });
 */
export function defineProvider(adapter: ProviderAdapter): ProviderAdapter {
  const result = providerAdapterSchema.safeParse(adapter);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new PayweaveConfigError(`Invalid provider adapter — ${detail}`);
  }
  return adapter;
}
