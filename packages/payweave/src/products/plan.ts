/**
 * `plan()` primitive (plans-and-features.md §3–§6, §9, PW-801).
 *
 * `plan()` validates the parts of a plan definition that don't need the rest
 * of the `products` array: `id`, the `default: true` ⇒ `group` requirement
 * (§4), the price shape (§6 — still MAJOR units, see below), and its own
 * `includes` (§9 — duplicate feature ids, a raw uncalled feature passed by
 * mistake, and the deferred boolean-called-with-argument violation from
 * `feature()`). Rules that need the WHOLE `products` array — duplicate plan
 * ids, more than one `default: true` per group, a feature id used with
 * conflicting types across plans, currency resolution against
 * `defaultCurrency` — are `createPayweave`'s job (PW-802, agent-playbook
 * contract notes: "cross-plan rules... belong to config parse, not here. Do
 * not half-implement them.").
 *
 * **The money deviation** (AGENTS.md golden rule 7, §9, §6): `price.amount`
 * stays in MAJOR units on the value `plan()` returns — that is the ONE place
 * a float is allowed to sit in a Payweave-defined shape. Conversion to
 * integer minor units happens exactly once, via {@link resolvePlanPricing},
 * at config-parse time where a currency (the plan's own, or `defaultCurrency`)
 * is known. `plan()` itself never calls `toMinor` — it cannot: at
 * definition time (this module has no access to `createPayweave`'s config),
 * a plan omitting `price.currency` has no currency to convert against yet.
 */
import { z } from "zod";
import { PayweaveValidationError } from "../core/errors";
import { exponentFor, toMinor, type Money } from "../core/money";
import {
  featureFnDef,
  inclusionMeta,
  PRODUCT_ID_MESSAGE,
  PRODUCT_ID_REGEX,
  type FeatureInclusion,
} from "./feature";

const planPriceSchema = z.strictObject({
  /** Major units at definition time ONLY (§6, §9) — e.g. `19.99` for $19.99. */
  amount: z
    .number({ error: "price.amount must be a finite number" })
    .positive("price.amount must be positive"),
  /** ISO 4217; omit to use `defaultCurrency` from `createPayweave` (§6). */
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'price.currency must be a 3-letter ISO 4217 code, e.g. "USD"')
    .transform((value) => value.toUpperCase())
    .optional(),
  interval: z.enum(["month", "year"]),
});

/** A plan's price at DEFINITION time — `amount` is MAJOR units (the money deviation, §9). */
export type PlanPrice = z.infer<typeof planPriceSchema>;
/** `price` as accepted by `plan()` (§6). */
export type PlanPriceInput = z.input<typeof planPriceSchema>;

const planBaseSchema = z.strictObject({
  id: z.string().regex(PRODUCT_ID_REGEX, PRODUCT_ID_MESSAGE),
  name: z.string().min(1, "name must not be empty").optional(),
  group: z.string().min(1, "group must not be empty").optional(),
  default: z.boolean().optional(),
  price: planPriceSchema.optional(),
});

function zodDetail(err: z.ZodError): string {
  return err.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** `plan()`'s accepted input shape, minus `includes` (handled separately — see module docs). */
type PlanBaseInput = z.input<typeof planBaseSchema>;

/** `plan()`'s accepted input — the bound for its `const` generic (§10). */
export type PlanDefInput = PlanBaseInput & {
  readonly includes?: readonly FeatureInclusion[];
};

/**
 * A defined plan (§3), generic over its literal id/group/feature-ids so
 * `PayweaveClient<C>` can extract `PlanIds<C>`/`FeatureIds<C>` from a
 * `products` array (§10, PW-802). `price` stays in MAJOR units — see
 * {@link resolvePlanPricing} for the config-parse-time conversion.
 */
export type Plan<
  Id extends string = string,
  Group extends string | undefined = string | undefined,
  FeatureIds extends string = string,
> = {
  readonly id: Id;
  readonly name: string | undefined;
  readonly group: Group;
  readonly default: boolean;
  readonly price: PlanPrice | undefined;
  readonly includes: readonly FeatureInclusion<FeatureIds>[];
};

/** Extracts `Def["group"]` as a literal, or `undefined` when omitted (§10). */
export type PlanGroupOf<Def> = Def extends { group: infer G extends string } ? G : undefined;

/** Extracts the union of every `includes` entry's literal feature id (§10). */
export type PlanFeatureIdsOf<Def> = Def extends { includes: infer Includes }
  ? Includes extends readonly (infer Item)[]
    ? Item extends FeatureInclusion<infer FeatureId>
      ? FeatureId
      : never
    : never
  : never;

/**
 * Validates one plan's `includes` array (§9): a raw, uncalled feature passed
 * by mistake gets the "did you mean" hint; a boolean feature called with an
 * argument (deferred from `feature()`, see feature.ts docs) is rejected
 * here; duplicate feature ids within this SAME plan are rejected. Anything
 * that isn't a genuine `FeatureInclusion` (nor a raw feature callable) is a
 * generic invalid-entry error.
 */
function validateIncludes(planId: string, raw: readonly unknown[]): FeatureInclusion[] {
  const seen = new Set<string>();
  const out: FeatureInclusion[] = [];
  for (const entry of raw) {
    const rawDef = featureFnDef(entry);
    if (rawDef !== undefined) {
      const hint = rawDef.type === "metered" ? "{ limit, reset }" : "";
      throw new PayweaveValidationError(`plan "${planId}": did you mean \`${rawDef.id}(${hint})\`?`);
    }

    const meta = inclusionMeta(entry);
    if (meta === undefined) {
      throw new PayweaveValidationError(
        `plan "${planId}" includes an invalid entry — expected a called feature, e.g. ` +
          `messages({ limit, reset }) or proModels()`,
      );
    }

    const inclusion = entry as FeatureInclusion;
    if (meta.invalidArg) {
      throw new PayweaveValidationError(
        `plan "${planId}": boolean feature "${inclusion.featureId}" does not take arguments`,
      );
    }
    if (seen.has(inclusion.featureId)) {
      throw new PayweaveValidationError(
        `plan "${planId}" includes feature "${inclusion.featureId}" more than once`,
      );
    }
    seen.add(inclusion.featureId);
    out.push(inclusion);
  }
  return out;
}

/**
 * Define a plan (§3). Validates `id`, the `default: true` ⇒ `group`
 * requirement (§4), the price shape (§6 — still major units), and
 * `includes` (§9) — every rule that needs only THIS plan, not the rest of
 * the `products` array (see module docs for what's deliberately NOT here).
 *
 * ```ts
 * export const pro = plan({
 *   id: "pro",
 *   name: "Pro",
 *   group: "base",
 *   price: { amount: 19, currency: "USD", interval: "month" },
 *   includes: [messages({ limit: 2_000, reset: "month" }), proModels()],
 * });
 * ```
 */
export function plan<const Def extends PlanDefInput>(
  def: Def,
): Plan<Def["id"], PlanGroupOf<Def>, PlanFeatureIdsOf<Def>> {
  const { includes, ...rest } = def;

  let base: z.infer<typeof planBaseSchema>;
  try {
    base = planBaseSchema.parse(rest);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new PayweaveValidationError(`invalid plan definition — ${zodDetail(err)}`);
    }
    throw err;
  }

  if (base.default === true && base.group === undefined) {
    throw new PayweaveValidationError(
      `plan "${base.id}": default: true requires a group (plans-and-features.md §4)`,
    );
  }

  const validatedIncludes = validateIncludes(base.id, includes ?? []);

  const result: Plan = Object.freeze({
    id: base.id,
    name: base.name,
    group: base.group,
    default: base.default ?? false,
    price: base.price,
    includes: Object.freeze(validatedIncludes),
  });

  return result as unknown as Plan<Def["id"], PlanGroupOf<Def>, PlanFeatureIdsOf<Def>>;
}

// ── Money deviation — price resolution (§9, AGENTS.md golden rule 7) ───────

/** A plan's price AFTER config-parse conversion — integer minor units. */
export type ResolvedPlanPrice = {
  readonly amount: number;
  readonly currency: string;
  readonly interval: "month" | "year";
};

/** The `999,999.99`-equivalent bound for a currency's minor-unit exponent (§6). */
function maxMajorAmount(exponent: number): string {
  const bound = 10 ** (6 + exponent) - 1;
  return (bound / 10 ** exponent).toFixed(exponent);
}

/**
 * Convert a paid plan's `price.amount` (major units, §6) to integer minor
 * units — the ONE place `toMinor` runs for a plan (AGENTS.md golden rule 7).
 * Returns `undefined` for a free plan (no `price`).
 *
 * The plan's OWN `price.currency` always wins when set (§6: "omit it to use
 * `defaultCurrency`") — `defaultCurrency` is the FALLBACK a plan without its
 * own currency resolves against. `createPayweave` (PW-802) decides "neither
 * present → config error" (`PayweaveConfigError`, cross-plan rule) BEFORE
 * ever calling this helper — this function only wraps the conversion itself
 * and the `§6` amount bound, naming the offending plan id on failure
 * (`toMinor`'s own message doesn't — agent-playbook contract notes).
 */
export function resolvePlanPricing(
  planValue: Plan,
  defaultCurrency: string,
): ResolvedPlanPrice | undefined {
  if (planValue.price === undefined) return undefined;
  const currency = planValue.price.currency ?? defaultCurrency;

  let converted: Money;
  try {
    converted = toMinor(planValue.price.amount, currency);
  } catch (err) {
    if (err instanceof PayweaveValidationError) {
      throw new PayweaveValidationError(`plan "${planValue.id}": ${err.message}`, { cause: err });
    }
    throw err;
  }

  const exp = exponentFor(currency);
  const bound = 10 ** (6 + exp) - 1;
  if (converted.value > bound) {
    throw new PayweaveValidationError(
      `plan "${planValue.id}": amount ${planValue.price.amount} ${converted.currency} exceeds the ` +
        `maximum of ${maxMajorAmount(exp)} ${converted.currency}`,
    );
  }

  return {
    amount: converted.value,
    currency: converted.currency,
    interval: planValue.price.interval,
  };
}
