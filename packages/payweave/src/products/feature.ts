/**
 * `feature()` primitive.
 *
 * A feature is either a boolean access gate or a metered usage limit,
 * identified by a lowercase id. `feature()` validates the definition with Zod
 * and returns a CALLABLE: invoking it produces a {@link FeatureInclusion} for
 * a `plan()`'s `includes` array:
 *
 * ```ts
 * const proModels = feature({ id: "pro_models", type: "boolean" });
 * const messages = feature({ id: "messages", type: "metered" });
 * // ...
 * proModels();                                  // FeatureInclusion<"pro_models">
 * messages({ limit: 100, reset: "month" });      // FeatureInclusion<"messages">
 * ```
 *
 * The parsed def rides along on a module-private symbol so `plan()` (a
 * SEPARATE file) can recognize a raw, uncalled feature passed by mistake and
 * give the "did you mean" hint. The symbol itself is never exported —
 * {@link featureFnDef} is the only way to read it, and neither it nor
 * {@link inclusionMeta} are re-exported from `src/products/index.ts`, so they
 * never become part of the public `payweave/products` surface.
 *
 * Argument-shape validation is split by timing on purpose (agent-playbook
 * contract notes — a spec-silent decision recorded here since only ONE half
 * of it is spelled out verbatim):
 *  - a METERED feature validates its `{ limit, reset }` argument IMMEDIATELY
 *    when called — there is no reason to defer an unambiguous shape check.
 *  - a BOOLEAN feature called with an argument is the one deviation the spec
 *    calls out explicitly: the callable never throws for this — it just
 *    records the violation on the returned inclusion, and `plan()` is the
 *    one that rejects it, at plan-parse time (so every "you gave `plan()`
 *    something wrong" error surfaces from one place: `plan()` itself).
 */
import { z } from "zod";
import { PayweaveValidationError } from "../core/errors";
import type { ResetInterval } from "./period";

/** Feature/plan id: lowercase alphanumeric, dashes/underscores, max 64 chars. */
export const PRODUCT_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Shared with `plan.ts` — plans use the exact same id rule. */
export const PRODUCT_ID_MESSAGE =
  "must be lowercase alphanumeric with dashes or underscores, max 64 characters";

const RESET_INTERVALS = ["day", "week", "month", "year"] as const;

/** Module-private — carries the parsed {@link FeatureDef} on a feature callable. */
const FEATURE_DEF: unique symbol = Symbol("payweave.products.featureDef");
/** Module-private — marks a genuine {@link FeatureInclusion} and its deferred-violation flag. */
const INCLUSION: unique symbol = Symbol("payweave.products.inclusion");

const featureDefSchema = z.strictObject({
  id: z.string().regex(PRODUCT_ID_REGEX, PRODUCT_ID_MESSAGE),
  type: z.enum(["boolean", "metered"]),
});

function zodDetail(err: z.ZodError): string {
  return err.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** `feature()`'s accepted input — the bound for its `const` generic. */
export type FeatureDefInput = z.input<typeof featureDefSchema>;
/** The two feature kinds. */
export type FeatureType = FeatureDefInput["type"];

/** A feature's parsed definition, generic over its literal id/type. */
export type FeatureDef<Id extends string = string, Type extends FeatureType = FeatureType> = {
  readonly id: Id;
  readonly type: Type;
};

/** The argument a metered feature's callable requires. */
export type MeteredFeatureArg = { readonly limit: number; readonly reset: ResetInterval };

const meteredArgSchema = z.strictObject({
  limit: z
    .number({ error: "limit must be a positive safe integer" })
    .int("limit must be a positive safe integer")
    .positive("limit must be a positive safe integer"),
  reset: z.enum(RESET_INTERVALS, 'reset must be one of "day", "week", "month", "year"'),
});

/**
 * One feature grant inside a plan's `includes` — produced by CALLING
 * a `feature()` result, never constructed directly. `featureId`/`type` are
 * always present; `limit`/`reset` only accompany a `"metered"` inclusion.
 */
export type FeatureInclusion<Id extends string = string> =
  | BooleanFeatureInclusion<Id>
  | MeteredFeatureInclusion<Id>;

/** The `"boolean"` half of {@link FeatureInclusion} — narrowed so `FeatureFn`'s boolean overload doesn't widen back to the full union. */
export type BooleanFeatureInclusion<Id extends string = string> = {
  readonly featureId: Id;
  readonly type: "boolean";
};

/** The `"metered"` half of {@link FeatureInclusion} — narrowed so `FeatureFn`'s metered overload doesn't widen back to the full union. */
export type MeteredFeatureInclusion<Id extends string = string> = {
  readonly featureId: Id;
  readonly type: "metered";
  readonly limit: number;
  readonly reset: ResetInterval;
};

/** Runtime shape of the hidden marker on every genuine {@link FeatureInclusion} (module-private). */
type InclusionMeta = {
  /** Set when a BOOLEAN feature's callable was invoked with an argument — `plan()` rejects it. */
  readonly invalidArg: boolean;
};

function createInclusion<
  Data extends { featureId: string; type: "boolean" } | (MeteredFeatureArg & { featureId: string; type: "metered" }),
>(data: Data, invalidArg: boolean): Data {
  const meta: InclusionMeta = { invalidArg };
  const inclusion: Record<PropertyKey, unknown> = { ...data };
  Object.defineProperty(inclusion, INCLUSION, { value: meta, enumerable: false });
  return Object.freeze(inclusion) as unknown as Data;
}

/**
 * Reads the hidden marker off a value produced by {@link createInclusion}, if
 * present — `undefined` for anything that isn't a genuine `FeatureInclusion`
 * (module-private; consumed by `plan.ts` only).
 */
export function inclusionMeta(value: unknown): InclusionMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<PropertyKey, unknown>)[INCLUSION] as InclusionMeta | undefined;
}

/** The callable `feature()` returns — call it to produce a {@link FeatureInclusion}. */
export type FeatureFn<Id extends string = string, Type extends FeatureType = FeatureType> = Type extends "boolean"
  ? () => BooleanFeatureInclusion<Id>
  : (arg: MeteredFeatureArg) => MeteredFeatureInclusion<Id>;

/**
 * Reads the hidden {@link FEATURE_DEF} def off a value, if it is a `feature()`
 * callable — `undefined` otherwise (module-private; consumed by `plan.ts`
 * only, to recognize a raw uncalled feature passed to `includes`).
 */
export function featureFnDef(value: unknown): FeatureDef | undefined {
  if (typeof value !== "function") return undefined;
  return (value as unknown as Record<PropertyKey, unknown>)[FEATURE_DEF] as FeatureDef | undefined;
}

/**
 * Define a feature. Validates `id` (regex) and `type` (enum) with Zod;
 * throws {@link PayweaveValidationError} on a bad definition. Returns a
 * callable — call it to produce a `FeatureInclusion` for a `plan()`'s
 * `includes` array.
 *
 * ```ts
 * const proModels = feature({ id: "pro_models", type: "boolean" });
 * const messages = feature({ id: "messages", type: "metered" });
 * ```
 */
export function feature<const Def extends FeatureDefInput>(
  def: Def,
): FeatureFn<Def["id"], Def["type"]> {
  let parsed: FeatureDef;
  try {
    parsed = featureDefSchema.parse(def);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new PayweaveValidationError(`invalid feature definition — ${zodDetail(err)}`);
    }
    throw err;
  }

  const callable = (...args: unknown[]): FeatureInclusion => {
    if (parsed.type === "boolean") {
      // Deliberate deviation: never throw here — record the violation, `plan()` rejects it.
      return createInclusion({ featureId: parsed.id, type: "boolean" }, args.length > 0);
    }
    const argResult = meteredArgSchema.safeParse(args[0]);
    if (!argResult.success) {
      throw new PayweaveValidationError(
        `metered feature "${parsed.id}" requires { limit: positive safe integer, reset: "day" | ` +
          `"week" | "month" | "year" } — ${zodDetail(argResult.error)}`,
      );
    }
    return createInclusion(
      {
        featureId: parsed.id,
        type: "metered",
        limit: argResult.data.limit,
        reset: argResult.data.reset,
      },
      false,
    );
  };

  Object.defineProperty(callable, FEATURE_DEF, { value: parsed, enumerable: false });
  return Object.freeze(callable) as unknown as FeatureFn<Def["id"], Def["type"]>;
}
