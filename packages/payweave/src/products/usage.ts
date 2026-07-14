/**
 * `check()` + `report()` — the metered-usage surface. Mirrors `subscribe.ts`'s
 * structure/seams on purpose (same {@link BillingContext}, same "non-generic
 * module, generic facade" split with `src/index.ts`) — this file never
 * imports `../index` (avoids a circular import back into the facade).
 *
 * Both `check` and `report` bottom out in EXACTLY ONE
 * `database.balances.consume` call: the SDK layer adds zero atomicity of its
 * own — no read-modify-write, no retry, no rollback machinery. `check` is
 * `consume(amount: 0)` (a peek that still performs the lazy reset — "amount:
 * 0 must still trigger row creation + reset"); `report` is `consume(amount:
 * n, conditional: false)` (unconditional — never throws for "over limit");
 * `check({ consume: true })` is `consume(amount: 1, conditional: true)` — the
 * documented atomic gate.
 *
 * ── Resolution order ────────────────────────────────────────────────────
 * 1. Find the feature across `ctx.products` to learn its `type` and its
 *    "home" group (`resolvePlanGroup` of the first plan that includes it —
 *    spec-silent: a config where the SAME feature id appears under more than
 *    one group is unspecified; the first occurrence in array order wins,
 *    deterministically).
 * 2. The customer's active subscription in that group (`subscriptions.getActive`)
 *    → resolve its `planId` back against `ctx.products` (NOT a
 *    `database.plans.getActiveVersion` round trip — see the spec-silent note
 *    below) and read that plan's inclusion of the feature.
 * 3. No active subscription → the group's default plan's inclusion (no rows
 *    required).
 * 4. Feature not included in whichever plan answered → `allowed: false` /
 *    `balance: null` / `limit: null` / `resetsAt: null` for metered, and
 *    `allowed: false` for boolean — a normal "upsell" answer, never an error.
 *
 * ── Spec-silent decision: resolving limits from `ctx.products`, not `pw_plans` ─
 * The active-subscription path resolves "that plan version's inclusion of the
 * feature," which could be read as a `database.plans.
 * getActiveVersion(planId)` round trip against the persisted, pushed
 * `features` JSON. This module resolves the feature's `limit`/`reset` from the
 * in-memory `ctx.products` (keyed by `subscription.planId`) instead, for two
 * reasons: (1) `DatabaseAdapter.plans` only exposes the LATEST pushed version
 * per plan id (no lookup by a specific historical version number), so a DB
 * round trip would answer with the exact same "latest known definition" that
 * `ctx.products` already holds from the source-controlled config — at the
 * cost of a network round trip on every `check`/`report` call; (2) this
 * mirrors `subscribe()`'s own `findPlan(ctx.products, planId)` pattern for its
 * free/default branches (`./subscribe.ts`). `subscription.planId`/
 * `planVersion` remain the authoritative "what was pushed and paid for at
 * subscribe time" record on the row itself; the limits `check`/`report`
 * *enforce* follow the code's current `products` definition — which is
 * expected to be pushed (`payweave push`) whenever it changes. `database.
 * plans.getActiveVersion` is still consulted, but only to stamp a real
 * `planVersion` int onto a LAZILY-CREATED balance row for a plan with no
 * active subscription (the default-plan path) — see {@link buildMeteredInit}.
 *
 * ── Spec-silent decision: a group with no default plan, no active subscription ─
 * "No subscription → the group's default plan inclusion (no rows required)"
 * assumes a default plan exists. A group that legitimately has none (e.g. an
 * opt-in-only `addons` group, see `subscribe.ts`'s own `teamAddonPlan`
 * fixture) has no plan to answer from when nobody has subscribed.
 * Conservative reading: this is a configuration gap, not a normal "no access"
 * answer (which is what `allowed: false` already means for a
 * plan-that-lacks-the-feature) — `check`/`report` throw
 * {@link PayweaveConfigError} naming the group, rather than silently guessing.
 *
 * ── Spec-silent decision: anchor seeding, paid vs free ─────────────────
 * "Paid subscriptions seed [the anchor] from the subscription's
 * `current_period_start`; default-plan (and free-plan) balances seed it at
 * first use." Read literally: the split is on the RESOLVED PLAN'S price, not
 * on subscription-existence — a free, NON-default plan (e.g. `team-addon`)
 * still gets a `pw_subscriptions` row from `subscribe()` (`nominalPeriod`'s
 * placeholder bounds, not a real provider cycle), but its metered balances
 * anchor at the customer's own first `check`/`report` call, exactly like the
 * default-plan path — because a free plan's "period start" is a locally
 * invented placeholder, not a real billing date worth aligning to. Only a
 * plan with an actual `price` anchors from `subscription.currentPeriodStart`.
 *
 * ── Spec-silent decision: `report()` on a feature the current plan excludes ──
 * `report`'s public shape has no `allowed` field to express "not
 * included" the way `check` does — there is also no `limit`/`reset` to build
 * an `init` template from. `report()` throws {@link PayweaveValidationError}
 * pointing the caller at `check()` (whose `allowed: false` IS the documented
 * answer for this case) rather than guessing a limit.
 */
import { PayweaveConfigError, PayweaveValidationError } from "../core/errors";
import type { ResolvedProduct } from "../core/config";
import type {
  DatabaseAdapter,
  PwCustomer,
  PwFeatureBalanceInit,
  PwSubscription,
} from "../db/index";
import type { FeatureInclusion, FeatureType, MeteredFeatureInclusion } from "./feature";
import type { BillingContext } from "./subscribe";
import { resolvePlanGroup } from "./subscribe";

/**
 * `check()`'s input. Mirrors `CheckInput<C>` in
 * `src/index.ts` field-for-field, but non-generic — the compile-time
 * `FeatureIds<C>` narrowing is the client facade's job (it widens back to
 * this plain type before calling in here).
 */
export interface CheckInput {
  customerId: string;
  featureId: string;
  /** Atomic gate: consume 1 unit iff allowed, in the SAME operation. */
  consume?: boolean;
}

/**
 * `check()`'s result (matched verbatim — this shape becomes the docs page).
 * `balance`/`limit`/`resetsAt` are `null` for boolean features (no usage to
 * track) and for a metered feature the resolved plan doesn't include (the
 * normal "upsell" answer).
 */
export interface CheckResult {
  /** Boolean feature: plan includes it. Metered: remaining balance > 0. */
  allowed: boolean;
  /** Remaining units this period; `null` for boolean features or a plan lacking the feature. */
  balance: number | null;
  /** The plan's configured limit; `null` alongside `balance`. */
  limit: number | null;
  /** End of the current billing period; `null` alongside `balance`. */
  resetsAt: Date | null;
  /** The plan that answered — may be the group's default plan id. */
  planId: string;
}

/**
 * `report()`'s input. Mirrors `ReportInput<C>` in
 * `src/index.ts`, non-generic. `amount` defaults to `1` when omitted.
 */
export interface ReportInput {
  customerId: string;
  featureId: string;
  amount?: number;
}

/** `report()`'s result — the post-decrement balance snapshot. */
export interface ReportResult {
  balance: number;
  resetsAt: Date;
}

function requireDatabase(ctx: BillingContext, method: "check" | "report"): DatabaseAdapter {
  if (!ctx.database) {
    throw new PayweaveConfigError(
      `payweave.${method}() needs a database — pass a payweave/db/* adapter to createPayweave().`,
    );
  }
  return ctx.database;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PayweaveValidationError(`${name} must be a positive safe integer — got ${value}`);
  }
}

/** Resolved answer to "which plan/group/subscription governs this (customer, feature) pair". */
interface FeatureContext {
  group: string;
  type: FeatureType;
  /** The plan that answered — the active subscription's plan, or the group's default. */
  plan: ResolvedProduct;
  /** `undefined` when the resolved plan doesn't include this feature. */
  inclusion: FeatureInclusion | undefined;
  /** The active subscription row, or `null` on the default-plan path. */
  subscription: PwSubscription | null;
  customerRow: PwCustomer;
}

/** Resolution order — shared by `check` and `report`. */
async function resolveFeatureContext(
  ctx: BillingContext,
  database: DatabaseAdapter,
  customerId: string,
  featureId: string,
): Promise<FeatureContext> {
  const products = ctx.products ?? [];

  let type: FeatureType | undefined;
  let group: string | undefined;
  for (const p of products) {
    const inc = p.includes.find((i) => i.featureId === featureId);
    if (inc) {
      type = inc.type;
      group = resolvePlanGroup(p);
      break;
    }
  }
  if (type === undefined || group === undefined) {
    throw new PayweaveValidationError(
      `unknown feature "${featureId}" — configure it in \`products\`.`,
    );
  }

  // Resolve the customer's internal `pwv_` id (every store keys
  // balances on it). Read first and upsert only when the customer is absent, so
  // the metering hot path avoids a write on the common (already-exists) case;
  // the read→upsert gap is safe because `upsert` is idempotent.
  let customerRow = await database.customers.getByExternalId(customerId);
  if (customerRow === null) {
    customerRow = await database.customers.upsert({ externalId: customerId });
  }
  const subscription = await database.subscriptions.getActive(customerRow.id, group);

  if (subscription) {
    const plan = products.find((p) => p.id === subscription.planId);
    if (!plan) {
      throw new PayweaveValidationError(
        `customer's active subscription references plan "${subscription.planId}", which is no longer in ` +
          "`products` — was it renamed or removed?",
      );
    }
    const inclusion = plan.includes.find((i) => i.featureId === featureId);
    return { group, type, plan, inclusion, subscription, customerRow };
  }

  const defaultPlan = products.find((p) => p.default && resolvePlanGroup(p) === group);
  if (!defaultPlan) {
    throw new PayweaveConfigError(
      `group "${group}" has no default plan — check()/report() need one to answer for a customer with no ` +
        "active subscription in that group.",
    );
  }
  const inclusion = defaultPlan.includes.find((i) => i.featureId === featureId);
  return { group, type, plan: defaultPlan, inclusion, subscription: null, customerRow };
}

/** Builds `balances.consume`'s creation-time `init` template — ignored when the row already exists. */
async function buildMeteredInit(
  database: DatabaseAdapter,
  resolved: FeatureContext,
  inclusion: MeteredFeatureInclusion,
  now: Date,
): Promise<PwFeatureBalanceInit> {
  const isPaid = resolved.plan.price !== undefined;
  const anchor = isPaid && resolved.subscription ? resolved.subscription.currentPeriodStart : now;
  const planVersion = resolved.subscription
    ? resolved.subscription.planVersion
    : ((await database.plans.getActiveVersion(resolved.plan.id))?.version ?? 1);

  return {
    limit: inclusion.limit,
    resetInterval: inclusion.reset,
    anchor,
    planId: resolved.plan.id,
    planVersion,
  };
}

/**
 * `check()`. Never mutates the balance except the
 * lazy reset; `consume: true` makes it the atomic gate.
 */
export async function check(ctx: BillingContext, input: CheckInput): Promise<CheckResult> {
  const database = requireDatabase(ctx, "check");
  const resolved = await resolveFeatureContext(ctx, database, input.customerId, input.featureId);

  if (resolved.type === "boolean") {
    return {
      allowed: resolved.inclusion !== undefined,
      balance: null,
      limit: null,
      resetsAt: null,
      planId: resolved.plan.id,
    };
  }

  if (!resolved.inclusion) {
    // Feature not included in the resolved plan. Normal answer.
    return { allowed: false, balance: null, limit: null, resetsAt: null, planId: resolved.plan.id };
  }

  const inclusion = resolved.inclusion as MeteredFeatureInclusion;
  const now = new Date();
  const init = await buildMeteredInit(database, resolved, inclusion, now);
  const conditional = input.consume === true;
  const amount = conditional ? 1 : 0;

  const result = await database.balances.consume({
    customerId: resolved.customerRow.id,
    featureId: input.featureId,
    group: resolved.group,
    amount,
    conditional,
    init,
    now,
  });

  const balance = result.limit - result.used;
  return {
    allowed: conditional ? result.applied : balance > 0,
    balance,
    limit: result.limit,
    resetsAt: result.periodEnd,
    planId: resolved.plan.id,
  };
}

/**
 * `report()`. Unconditional decrement — never throws for "over limit";
 * `check` is the hard-blocking gate.
 */
export async function report(ctx: BillingContext, input: ReportInput): Promise<ReportResult> {
  const database = requireDatabase(ctx, "report");

  const amount = input.amount ?? 1;
  assertPositiveSafeInteger(amount, "amount");

  const resolved = await resolveFeatureContext(ctx, database, input.customerId, input.featureId);

  if (resolved.type === "boolean") {
    throw new PayweaveValidationError(
      `report() only accepts metered features — "${input.featureId}" is a boolean feature.`,
    );
  }

  if (!resolved.inclusion) {
    throw new PayweaveValidationError(
      `report(): feature "${input.featureId}" is not included in customer "${input.customerId}"'s current ` +
        `plan "${resolved.plan.id}" — call check() first, which answers { allowed: false } for a plan ` +
        "lacking a feature.",
    );
  }

  const inclusion = resolved.inclusion as MeteredFeatureInclusion;
  const now = new Date();
  const init = await buildMeteredInit(database, resolved, inclusion, now);

  const result = await database.balances.consume({
    customerId: resolved.customerRow.id,
    featureId: input.featureId,
    group: resolved.group,
    amount,
    conditional: false,
    init,
    now,
  });

  return { balance: result.limit - result.used, resetsAt: result.periodEnd };
}
