/**
 * §10 type inference mechanics (plans-and-features.md §7–§8, §10;
 * unified-config.md §4 assertion 4, PW-802): `PlanIds<C>` / `FeatureIds<C>` /
 * `FeatureIdsOf<C, Type>` extracted from a `products` array and threaded into
 * `subscribe`/`check`/`report`'s id parameters.
 *
 * `free`/`pro`/`ultra` (the exact §7 example plans) are defined in
 * `./products-external` — a SEPARATE module — and imported here. That import
 * boundary is the point: §10 requires inference to survive `products` being
 * defined in, and imported from, another module, with zero literal widening
 * to `string`. A same-file fixture could pass this suite by accident; a
 * cross-module one cannot.
 */
import { describe, it, expectTypeOf } from "vitest";
import { createPayweave } from "../../src/index";
import type { PlanIds, FeatureIds, FeatureIdsOf } from "../../src/index";
import { makeStubDatabaseAdapter } from "../db/stub-adapter";
import { products, nonMixingProducts } from "./products-external";

const database = makeStubDatabaseAdapter("sqlite");

describe("subscribe/check/report — id unions from an imported `products` array (§10)", () => {
  const payweave = createPayweave({
    paystack: { secretKey: "sk_test_x" },
    database,
    products,
  });

  it("subscribe accepts every plan id in the array (§7 example, ✓ case)", async () => {
    await payweave.subscribe({ customerId: "user_123", planId: "free" });
    await payweave.subscribe({ customerId: "user_123", planId: "pro" });
    await payweave.subscribe({ customerId: "user_123", planId: "ultra" });
  });

  it("subscribe rejects a typo'd plan id at compile time (§7 example, ✗ case)", async () => {
    // @ts-expect-error — "typo" is not a plan id in the imported products array.
    await payweave.subscribe({ customerId: "user_123", planId: "typo" });
  });

  it("check accepts both boolean and metered feature ids", async () => {
    await payweave.check({ customerId: "user_123", featureId: "messages" });
    await payweave.check({ customerId: "user_123", featureId: "pro_models" });
  });

  it("check rejects a typo'd feature id at compile time", async () => {
    // @ts-expect-error — "mesages" is not a feature id in the imported products array.
    await payweave.check({ customerId: "user_123", featureId: "mesages" });
  });

  it("report accepts a metered feature id and reports usage", async () => {
    await payweave.report({ customerId: "user_123", featureId: "messages", amount: 1 });
  });

  it("subscribe's per-call provider override stays typed to the configured provider(s)", async () => {
    await payweave.subscribe({ customerId: "user_123", planId: "pro", provider: "paystack" });
    // @ts-expect-error — "stripe" is not a configured provider on this client.
    await payweave.subscribe({ customerId: "user_123", planId: "pro", provider: "stripe" });
  });
});

/**
 * `report`'s metered-only compile-time guard (§10, unified-config.md §4
 * assertion 4) — and a KNOWN, DOCUMENTED GAP (flagged, not hidden —
 * agent-playbook §6; see `FeatureIdsOf`'s doc comment in `src/index.ts` for
 * the full analysis).
 *
 * `Plan.includes` (PW-801, `src/products/plan.ts` — forbidden file for
 * PW-802) types every inclusion as `FeatureInclusion<FeatureIds>`: ONE bare
 * string union of a plan's feature ids, shared identically by BOTH the
 * boolean and metered variant, with no per-id type tag. That means there is
 * NO signal, anywhere accessible from a `Plan` VALUE, correlating one
 * specific feature id with its own one true type — verified empirically
 * against single-feature, non-mixing, AND mixing configs; all of them
 * currently resolve `FeatureIdsOf<C, Type>` to the SAME set as
 * `FeatureIds<C>` regardless of `Type`. `nonMixingProducts` here does NOT
 * work around it (tried, and disproven below) — the gap is not about
 * plans mixing feature types, it is that `Plan`'s type never carried
 * per-id correlation in the first place.
 *
 * This is exactly the case §10 hedges for ("`report` is a compile-time error
 * WHERE THE PRODUCTS ARRAY MAKES THE TYPE KNOWN") — PW-902's runtime
 * `PayweaveValidationError` guard is the unconditional enforcement either
 * way. Fixing the compile-time side needs a `Plan.includes` type-shape
 * change in PW-801 — out of this ticket's scope; flagged in the PW-802
 * report for a follow-up ticket.
 */
describe("report — metered-only compile-time guard (§10) — KNOWN GAP, flagged not hidden", () => {
  const payweave = createPayweave({
    paystack: { secretKey: "sk_test_x" },
    database,
    products: nonMixingProducts,
  });

  it("accepts a genuinely metered feature id (the part that works today)", async () => {
    await payweave.report({ customerId: "user_123", featureId: "messages", amount: 1 });
  });

  it("KNOWN GAP: a boolean feature id is NOT yet rejected at compile time", async () => {
    // Per §10 this SHOULD be a `@ts-expect-error`. It deliberately is NOT
    // one: if a future `Plan.includes` type fix (PW-801 follow-up) makes
    // this start failing to compile, this test then fails LOUDLY (a
    // TypeCheckError, not a silently-passing `@ts-expect-error`) — the
    // signal to promote it to `@ts-expect-error` and close the gap, rather
    // than a fix silently going unnoticed.
    await payweave.report({ customerId: "user_123", featureId: "pro_models", amount: 1 });
  });
});

describe("PlanIds<C> / FeatureIds<C> — direct extraction, cross-module survival (§10)", () => {
  it("resolves the literal id unions from the cross-module products array — no widening to `string`", () => {
    type Ids = PlanIds<{ products: typeof products }>;
    expectTypeOf<Ids>().toEqualTypeOf<"free" | "pro" | "ultra">();
    expectTypeOf<Ids>().not.toEqualTypeOf<string>();

    type Features = FeatureIds<{ products: typeof products }>;
    expectTypeOf<Features>().toEqualTypeOf<"messages" | "pro_models">();
    expectTypeOf<Features>().not.toEqualTypeOf<string>();
  });

  it("resolves to `never` when `products` is not configured at all", () => {
    expectTypeOf<PlanIds<{ paystack: { secretKey: string } }>>().toEqualTypeOf<never>();
    expectTypeOf<FeatureIds<{ paystack: { secretKey: string } }>>().toEqualTypeOf<never>();
    expectTypeOf<FeatureIdsOf<{ paystack: { secretKey: string } }, "metered">>().toEqualTypeOf<never>();
  });

  it("KNOWN GAP: FeatureIdsOf currently equals FeatureIds regardless of Type (see report's describe block above)", () => {
    // Documents the gap at the type-utility level directly, independent of
    // `report`'s call site — both `Type` arguments currently resolve to the
    // SAME full set, even for `nonMixingProducts` where a naive reading
    // might expect precise per-type narrowing.
    type Metered = FeatureIdsOf<{ products: typeof nonMixingProducts }, "metered">;
    type BooleanIds = FeatureIdsOf<{ products: typeof nonMixingProducts }, "boolean">;
    type AllIds = FeatureIds<{ products: typeof nonMixingProducts }>;
    expectTypeOf<Metered>().toEqualTypeOf<AllIds>();
    expectTypeOf<BooleanIds>().toEqualTypeOf<AllIds>();
  });
});

describe("no `products` configured — billing id params are uncallable (unified-config.md §3 note)", () => {
  const payweaveNoProducts = createPayweave({
    paystack: { secretKey: "sk_test_x" },
    database,
  });

  it("subscribe is a compile-time error with no products configured", async () => {
    // @ts-expect-error — no `products` key at all means `planId` is `never`.
    await payweaveNoProducts.subscribe({ customerId: "user_123", planId: "pro" });
  });

  it("check is a compile-time error with no products configured", async () => {
    // @ts-expect-error — no `products` key at all means `featureId` is `never`.
    await payweaveNoProducts.check({ customerId: "user_123", featureId: "messages" });
  });

  it("report is a compile-time error with no products configured", async () => {
    // @ts-expect-error — no `products` key at all means `featureId` is `never`.
    await payweaveNoProducts.report({ customerId: "user_123", featureId: "messages", amount: 1 });
  });
});
