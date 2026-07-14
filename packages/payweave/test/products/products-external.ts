/**
 * Fixture module for the §10 "cross-module import survival" assertion
 * : plans/features MUST be defined in a
 * SEPARATE module from the type test that imports them and passes them to
 * `createPayweave` — otherwise a same-file definition could accidentally pass
 * only because the literal types never left the file. This is deliberately
 * NOT a `.test-d.ts` file itself; it is a plain module `products/index.ts`
 * users would actually write (plans-and-features.md §7's `products.ts`
 * example), imported BY `test/products/inference.test-d.ts`.
 */
import { feature, plan } from "../../src/products/index";

export const proModels = feature({ id: "pro_models", type: "boolean" });
export const messages = feature({ id: "messages", type: "metered" });

export const free = plan({
  id: "free",
  name: "Free",
  group: "base",
  default: true,
  includes: [messages({ limit: 100, reset: "month" })],
});

export const pro = plan({
  id: "pro",
  name: "Pro",
  group: "base",
  price: { amount: 19, currency: "USD", interval: "month" },
  includes: [messages({ limit: 2_000, reset: "month" }), proModels()],
});

export const ultra = plan({
  id: "ultra",
  name: "Ultra",
  group: "base",
  price: { amount: 49, currency: "USD", interval: "month" },
  includes: [messages({ limit: 10_000, reset: "month" }), proModels()],
});

export const products = [free, pro, ultra] as const;

/**
 * A SEPARATE, type-mixing-free products array (no single plan below includes
 * both a boolean AND a metered feature) — used ONLY to demonstrate the
 * `FeatureIdsOf<C, "metered">` / `FeatureIdsOf<C, "boolean">` per-type
 * narrowing mechanism cleanly.
 *
 * KNOWN LIMITATION (documented, not hidden — agent-playbook §6): `Plan`'s
 * public shape (PW-801, `src/products/plan.ts`) declares
 * `includes: readonly FeatureInclusion<FeatureIds>[]` — ONE union type
 * parameter shared by every inclusion in a plan, not a per-item-correlated
 * tuple. So when a SINGLE plan mixes a boolean and a metered feature in the
 * SAME `includes` array (like `pro`/`ultra` above — the §7 example itself),
 * TypeScript cannot tell, from that plan alone, which id belongs to which
 * type — both leak into both `FeatureIdsOf<C,"metered">` and
 * `FeatureIdsOf<C,"boolean">`. This matches §10's own hedge ("`report` is a
 * compile-time error WHERE THE PRODUCTS ARRAY MAKES THE TYPE KNOWN") — the
 * runtime `PayweaveValidationError` guard is the unconditional
 * backstop regardless of what the compiler can prove. Fixing this at the
 * type level would mean widening `Plan.includes` to a correlated tuple in
 * `src/products/plan.ts`, which is out of PW-802's scope (forbidden file).
 */
export const meteredOnlyPlan = plan({
  id: "usage-addon",
  group: "addons",
  includes: [messages({ limit: 500, reset: "day" })],
});
export const booleanOnlyPlan = plan({
  id: "seat-addon",
  group: "addons",
  includes: [proModels()],
});
export const nonMixingProducts = [meteredOnlyPlan, booleanOnlyPlan] as const;
