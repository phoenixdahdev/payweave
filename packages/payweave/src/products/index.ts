/**
 * Products domain. Public as the `payweave/products` subpath;
 * `feature`/`plan` are also re-exported from the package root (`src/index.ts`).
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
