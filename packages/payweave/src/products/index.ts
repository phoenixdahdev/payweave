/**
 * Products domain (EPICs 8–9). Public as the `payweave/products` subpath
 * since PW-505; `plan()`/`feature()` join with PW-801
 * (plans-and-features.md §1–§6, §9–§10).
 *
 * NOTE: `plans-and-features.md §9` also wants `feature`/`plan` re-exported
 * from the package root (`"."`). PW-505 deferred that wire-up to this ticket,
 * but touching `src/index.ts` is out of PW-801's scope (PW-502/504 own that
 * file in flight) — it's a one-line follow-up
 * (`export { feature, plan } from "./products/feature"` /
 * `"./products/plan"`, or re-export from this barrel) for whoever next owns
 * `src/index.ts` (PW-802 is the natural owner, since it already wires
 * `products` into `createPayweave`).
 */
export { advance, currentPeriod, DAY_MS, WEEK_MS } from "./period";
export type { BillingPeriod, ResetInterval } from "./period";

export { feature } from "./feature";
export type {
  BooleanFeatureInclusion,
  FeatureDef,
  FeatureDefInput,
  FeatureFn,
  FeatureInclusion,
  FeatureType,
  MeteredFeatureArg,
  MeteredFeatureInclusion,
} from "./feature";

export { plan, resolvePlanPricing } from "./plan";
export type {
  Plan,
  PlanDefInput,
  PlanPrice,
  PlanPriceInput,
  ResolvedPlanPrice,
} from "./plan";
