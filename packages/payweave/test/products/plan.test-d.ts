/**
 * Type-level assertions for `feature()`/`plan()` (plans-and-features.md §10,
 * PW-801): the `const` generics preserve literal ids/types/groups WITHOUT
 * `as const` in user code, so PW-802 can extract `PlanIds<C>`/`FeatureIds<C>`
 * from a `products` array. Full cross-module survival (products defined in a
 * separate file, then imported into `createPayweave`) is PW-802's own
 * `test/products/inference.test-d.ts` — this file only covers what PW-801
 * itself returns.
 */
import { describe, expectTypeOf, it } from "vitest";
import { feature, type FeatureInclusion } from "../../src/products/feature";
import { plan } from "../../src/products/plan";

describe("feature() — literal id/type preservation (§10)", () => {
  it("a boolean feature's callable takes no arguments and returns FeatureInclusion<Id>", () => {
    const proModels = feature({ id: "pro_models", type: "boolean" });
    expectTypeOf(proModels).toBeCallableWith();
    // @ts-expect-error — boolean features take no arguments.
    proModels({ limit: 1, reset: "month" });

    const inclusion = proModels();
    expectTypeOf(inclusion.featureId).toEqualTypeOf<"pro_models">();
    expectTypeOf(inclusion.type).toEqualTypeOf<"boolean">();
  });

  it("a metered feature's callable requires { limit, reset } and returns FeatureInclusion<Id>", () => {
    const messages = feature({ id: "messages", type: "metered" });
    // @ts-expect-error — metered features require an argument.
    messages();

    const inclusion = messages({ limit: 100, reset: "month" });
    expectTypeOf(inclusion.featureId).toEqualTypeOf<"messages">();
    if (inclusion.type === "metered") {
      expectTypeOf(inclusion.limit).toEqualTypeOf<number>();
      expectTypeOf(inclusion.reset).toEqualTypeOf<"day" | "week" | "month" | "year">();
    }
  });

  it("two different feature ids are NOT widened to a shared `string` type", () => {
    const a = feature({ id: "aaa", type: "boolean" });
    expectTypeOf(a()).not.toEqualTypeOf<{ featureId: "bbb"; type: "boolean" }>();
  });
});

describe("plan() — literal id/group/feature-id preservation (§10)", () => {
  const proModels = feature({ id: "pro_models", type: "boolean" });
  const messages = feature({ id: "messages", type: "metered" });

  it("plan.id is the literal id, not widened to `string`", () => {
    const free = plan({ id: "free", group: "base", default: true });
    expectTypeOf(free.id).toEqualTypeOf<"free">();
    expectTypeOf(free.id).not.toEqualTypeOf<string>();
  });

  it("plan.group is the literal group when present", () => {
    const pro = plan({ id: "pro", group: "base" });
    expectTypeOf(pro.group).toEqualTypeOf<"base">();
  });

  it("plan.group is `undefined` when omitted — no group to preserve", () => {
    const standalone = plan({ id: "addon" });
    expectTypeOf(standalone.group).toEqualTypeOf<undefined>();
  });

  it("includes[number].featureId is the literal union of every included feature's id", () => {
    const pro = plan({
      id: "pro",
      group: "base",
      includes: [messages({ limit: 100, reset: "month" }), proModels()],
    });
    expectTypeOf(pro.includes).items.toHaveProperty("featureId");
    // The union survives — assigning to a narrower literal union type-checks.
    const ids: readonly ("messages" | "pro_models")[] = pro.includes.map((i) => i.featureId);
    expectTypeOf(ids).toEqualTypeOf<readonly ("messages" | "pro_models")[]>();
  });

  it("a plan with no includes has a `never` feature-id union — the runtime array is always empty", () => {
    const free = plan({ id: "free", group: "base", default: true });
    expectTypeOf(free.includes).toEqualTypeOf<readonly FeatureInclusion<never>[]>();
  });
});
