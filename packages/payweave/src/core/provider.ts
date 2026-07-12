/**
 * Provider adapter contract (TDD §8). Third parties (and our own two adapters)
 * implement {@link ProviderAdapter}; {@link defineProvider} is the Arcie-style
 * identity helper that also validates the shape at runtime. Adapters may depend
 * ONLY on `core/`; `unified/` depends on adapters, never the reverse.
 */
import { z } from "zod";
import { PayweaveConfigError } from "./errors";
import type { HttpClient, HeadersLike } from "./http";
import type { ResolvedConfig } from "./config";

/** Per-environment endpoint spec. */
export interface EnvSpec {
  baseUrl: string;
}

/** Case-insensitive header source accepted by webhook verification. */
export type HeaderLookup = HeadersLike | Record<string, string | string[] | undefined>;

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

/** Optional unified-layer operations an adapter can implement to join Surface B. */
export type UnifiedOps = Record<string, unknown>;

/**
 * The contract every provider adapter satisfies (TDD §8). `webhooks.verify`
 * runs on raw bytes with a timing-safe comparison; `toUnified` uses
 * `unified/mappings.ts`.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly environments: { test: EnvSpec; live: EnvSpec };
  inferEnvironment(secretKey: string): "test" | "live" | null;
  createHttp(cfg: ResolvedConfig): HttpClient;
  webhooks: {
    verify(input: { rawBody: string | Uint8Array; headers: HeaderLookup; secret: string }): boolean;
    parse(rawBody: string): ProviderEvent;
    toUnified(e: ProviderEvent): UnifiedEvent;
  };
  unified?: UnifiedOps;
}

const isFn = (v: unknown): boolean => typeof v === "function";
const fnSchema = z.custom<(...args: never[]) => unknown>(isFn, {
  message: "expected a function",
});
const envSpecSchema = z.object({ baseUrl: z.string().min(1) });

/**
 * Structural runtime schema for a {@link ProviderAdapter}. Kept loose (methods
 * validated as functions) — we assert presence/shape, not signatures.
 */
const providerAdapterSchema = z.object({
  id: z.string().min(1),
  environments: z.object({ test: envSpecSchema, live: envSpecSchema }),
  inferEnvironment: fnSchema,
  createHttp: fnSchema,
  webhooks: z.object({
    verify: fnSchema,
    parse: fnSchema,
    toUnified: fnSchema,
  }),
  unified: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Identity helper that validates an adapter's shape at runtime (Arcie `define*`
 * pattern, TDD §8). Returns the same object (typed) on success; throws
 * {@link PayweaveConfigError} describing the first structural problem otherwise.
 *
 * @example
 * const myProvider = defineProvider({ id: "acme", environments: {...}, ... });
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
