/**
 * `BillingSync` — pushes locally-defined plans (plans-and-features.md §7,
 * PW-801/802) to the database and every configured billing-capable provider
 * (`payweave push`, §12, PW-803). This file MIRRORS `./subscribe.ts`'s shape
 * on purpose (same {@link BillingContext} seam, same "operate ONLY through
 * `DatabaseAdapter` + the existing Surface A resource classes, no raw HTTP"
 * rule) — it imports `subscribe.ts`'s exports rather than re-declaring them.
 *
 * ── The two-layer idempotency story (§12, §13) ──────────────────────────────
 * 1. **Hash match → skip the provider entirely.** Every paid plan's
 *    provider-relevant content is hashed (sha256 over canonical JSON;
 *    deliberately NEVER `includes`/features — §12 says a feature is "nothing
 *    — Payweave-side state, never provider objects", so a features-only
 *    change must produce a new `pw_plans` version with ZERO provider calls)
 *    and compared against what's already recorded in the ACTIVE version's
 *    `provider_refs` (`pw_plans.providerRefs[provider].hash` — an ordinary
 *    string entry in the existing `Record<string, Record<string,string>>`
 *    column, database.md §2; no schema change). Stripe's Product (`name`)
 *    and Price (`amount`/`currency`/`interval`) are hashed/diffed
 *    INDEPENDENTLY ({@link planPriceHash} covers price only; `name` is
 *    compared directly against the stored row) so a display-name-only edit
 *    refreshes the Product in place with zero Price churn — Paystack has no
 *    such split (one Plan object carries both, {@link planPaystackHash}).
 *    Nothing differing → zero HTTP calls for that provider (the §13
 *    double-push AC).
 * 2. **Hash miss → adopt-or-create.** Before ANY provider create, search for
 *    an object already tagged with our `pwv_plan` (+, where it disambiguates
 *    a price rotation, `pwv_hash`) reference and ADOPT it instead of
 *    creating a duplicate — the crash-between-create-and-`pushVersion` case
 *    (§12). Genuinely new content (first push, or a real price change) finds
 *    nothing and creates fresh; a crash-resumed run finds the object an
 *    earlier, interrupted run already created and reuses its id.
 *
 * `plans.pushVersion` is ALSO its own no-op on unchanged content
 * (database.md §3, `src/db/sqlite/adapter.ts`'s `planContentEquals`) — this
 * module still calls it unconditionally after resolving `provider_refs`
 * ("belt and braces" per the PW-803 brief's contract notes), relying on that
 * DB-level check rather than skipping the call itself.
 *
 * ── Free / default plans (§12) ───────────────────────────────────────────────
 * Never touch a provider — `providerRefs` is always `{}` for a plan with no
 * `price`, regardless of any provider's configuration state.
 *
 * ── ⚠️ Flutterwave — verified 2026-07-13, deferred (see also
 * `plans-and-features.md` §12) ──────────────────────────────────────────────
 * Verified against developer.flutterwave.com (v3 Payment Plans, 2026-07-13):
 * `POST /v3/payment-plans` accepts `amount`, `name`, `interval` (`monthly`/
 * `yearly`/etc.) and an optional `duration`; `PUT /v3/payment-plans/{id}`
 * updates ONLY `name` and `status` — `amount` is confirmed immutable after
 * creation, so a price change requires a new payment plan, the same shape
 * Stripe/Paystack already use here. That much IS confidently resolved.
 *
 * What blocks shipping it in this ticket: (a) neither the create nor update
 * endpoint documents a `metadata`/tagging field of any kind, so there is no
 * provider-native place to stamp `pwv_plan`/`pwv_hash` for crash-resume
 * adoption (the `description`-field workaround this module uses for Paystack
 * — see below — has no Flutterwave equivalent to fall back to); (b) no
 * Flutterwave "payment plans" resource/schema module exists anywhere in this
 * codebase yet (`src/flutterwave/v3/resources/*` has banks/beneficiaries/
 * charges/payments/refunds/transactions/transfers — no payment-plans) —
 * building one is a new Surface A provider module, out of this ticket's file
 * scope (`src/flutterwave/**` isn't in PW-803's Create/Modify list). Per the
 * PW-803 brief's own escape hatch ("if it can't be confidently resolved,
 * implement Stripe+Paystack and leave FLW as a typed 'not yet supported'
 * path... do NOT guess FLW field mappings"), and consistent with
 * `subscribe.ts`'s `BILLING_CAPABLE_PROVIDERS` (which already excludes
 * flutterwave pending this exact verification), `sync()` silently skips a
 * configured `flutterwave` key (reported back via `SyncResult.
 * skippedProviders`) rather than attempting a guessed mapping or erroring
 * the whole push. {@link pushPlanToProvider} — the per-provider dispatch
 * `sync()`'s loop calls only for billing-capable providers — throws a typed
 * {@link PayweaveConfigError} if ever invoked directly for flutterwave (or
 * any other non-billing-capable key), so the "not yet supported" path is a
 * real, testable code path, not just an silent omission.
 *
 * ── Paystack: verified 2026-07-13, resolution recorded in
 * `plans-and-features.md` §12 ─────────────────────────────────────────────
 * Paystack's real Plan API DOES support in-place amount mutation —
 * `PUT /plan/{id_or_code}` accepts `name`, `amount`, `interval`, and
 * `update_existing_subscriptions` (whether the new price applies to
 * subscribers already on the plan) — a genuinely different mechanism from
 * Stripe's immutable-price model. However `src/paystack/resources/plans.ts`
 * (this ticket's forbidden-to-modify "use it, don't change it" surface) only
 * exposes `create`/`list`/`iterate`/`fetch` — no `update` method — and its
 * `createPlanReq` has no `metadata` field (confirmed: `name`, `amount`,
 * `interval`, `description`, `send_invoices`, `send_sms`, `currency`,
 * `invoice_limit` only). Given those two real constraints, this module:
 * (1) treats any Paystack-relevant content change as "create a NEW Plan"
 * (paralleling Stripe's new-Price pattern) rather than PUT-updating in place
 * — the old Paystack plan is left as-is (no archive/cancel call is available
 * through this resource surface either); (2) tags the new Plan for
 * crash-resume adoption by JSON-encoding `{ pwv_plan, pwv_hash }` into the
 * documented, genuinely-supported `description` field (NOT a new/invented
 * API field — `description` is real, free-text, and round-trips through
 * `list`/`fetch`) rather than a dedicated metadata mechanism Paystack's Plan
 * API does not have. FOLLOW-UP flagged, not fixed here (forbidden file): a
 * later ticket adding `plans.update()` to the Paystack resource would let
 * this module do a true in-place price rotation instead.
 */
import { createHash } from "node:crypto";
import type { PayweaveProviderKey, ResolvedProduct } from "../core/config";
import { PayweaveConfigError, PayweaveProviderError } from "../core/errors";
import type {
  DatabaseAdapter,
  PwFeatureInclusion,
  PwPlanVersion,
  PwPlanVersionInput,
} from "../db/index";
import type { PaystackClient } from "../paystack/client";
import type { StripeClient } from "../stripe/client";
import {
  BILLING_CAPABLE_PROVIDERS,
  resolvePlanGroup,
  type BillingCapableProvider,
  type BillingContext,
} from "./subscribe";

/** Same check as `subscribe.ts`'s (module-private there, so re-declared here — see that file's doc comment). */
function isBillingCapableProvider(provider: PayweaveProviderKey): provider is BillingCapableProvider {
  return (BILLING_CAPABLE_PROVIDERS as readonly string[]).includes(provider);
}

// ── Content hashing (§12, §13) ───────────────────────────────────────────────

/** Stable (sorted-key) JSON for order-independent structural comparison — mirrors `src/db/sqlite/adapter.ts`'s private helper (not exported/importable from that forbidden file). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Just a plan's `price` (§12) — hashed with sha256 over canonical JSON and
 * stamped into both `pw_plans.providerRefs.stripe.hash` and the Stripe
 * Price's own `pwv_hash` metadata, so a crash-resumed run can recognize
 * "this is the Price object for THIS exact amount/currency/interval" without
 * a read-after-write race on the local DB. Deliberately NOT `name` — Stripe
 * separates Product (display `name`) from Price (the immutable amount), so
 * a display-name-only change must refresh the Product in place rather than
 * rotate the Price (see {@link syncStripe}); `includes`/features are never
 * hashed here either (§12: they never become provider objects at all).
 */
function planPriceHash(plan: ResolvedProduct): string {
  const price = plan.price;
  const payload = price ? { amount: price.amount, currency: price.currency, interval: price.interval } : null;
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * `name` + `price` together (§12) — Paystack has no Stripe-style
 * Product/Price split (one Plan object carries both), so ANY change to
 * either requires a new Plan (module doc comment: no update endpoint is
 * available through the in-scope resource surface either way).
 */
function planPaystackHash(plan: ResolvedProduct): string {
  const price = plan.price;
  const payload = {
    name: plan.name ?? null,
    price: price ? { amount: price.amount, currency: price.currency, interval: price.interval } : null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** One resolved plan's `includes` (§9) converted to the `pw_plans.features` JSON shape (database.md §2). Never touches providers (§12). */
function buildFeatures(plan: ResolvedProduct): Record<string, PwFeatureInclusion> {
  const out: Record<string, PwFeatureInclusion> = {};
  for (const inclusion of plan.includes) {
    out[inclusion.featureId] =
      inclusion.type === "boolean"
        ? { type: "boolean" }
        : { type: "metered", limit: inclusion.limit, reset: inclusion.reset };
  }
  return out;
}

/** What one provider push produced, for {@link SyncPlanResult} reporting (informational only — never used to decide behavior). */
export type SyncProviderAction = "created" | "adopted" | "unchanged";

/** Per-plan outcome of one {@link sync} run. */
export interface SyncPlanResult {
  readonly planId: string;
  /** The plan's active `pw_plans` version AFTER this run (unchanged if nothing differed). */
  readonly version: number;
  /** Whether this run appended a NEW `pw_plans` version (false = `pushVersion`'s own no-op fired). */
  readonly versionChanged: boolean;
  /** Per-billing-capable-provider action taken — empty for a free/default plan (§12: zero provider objects). */
  readonly providers: Readonly<Partial<Record<BillingCapableProvider, SyncProviderAction>>>;
}

/** `sync()`'s result (`payweave.sync()` / the future `payweave push`, PW-1004). */
export interface SyncResult {
  readonly plans: readonly SyncPlanResult[];
  /**
   * Configured provider keys that are NOT billing-capable and were therefore
   * never pushed to (e.g. `flutterwave` — see this module's doc comment for
   * the verified-but-deferred ⚠️ resolution, plans-and-features.md §12).
   */
  readonly skippedProviders: readonly PayweaveProviderKey[];
}

// ── Stripe (Products + Prices, §12) ─────────────────────────────────────────

interface StripeProductLike {
  id: string;
}
interface StripePriceLike {
  id: string;
}

/** Search Products tagged for this plan (crash-resume adoption) — matches by `pwv_plan` ALONE: a plan's Product is never recreated across price changes (§12), so at most one live match is expected. */
async function findStripeProduct(
  stripe: StripeClient,
  planId: string,
): Promise<StripeProductLike | undefined> {
  const found = await stripe.products.search({ query: `metadata['pwv_plan']:'${planId}'` });
  return found.data[0];
}

/** Search Prices tagged for THIS exact content hash — `pwv_plan` alone is not enough here: an old, still-active price from a prior price generation would also carry it. */
async function findStripePrice(
  stripe: StripeClient,
  planId: string,
  hash: string,
): Promise<StripePriceLike | undefined> {
  const found = await stripe.prices.search({
    query: `metadata['pwv_plan']:'${planId}' AND metadata['pwv_hash']:'${hash}'`,
  });
  return found.data[0];
}

/**
 * Push one paid plan onto Stripe Products + Prices (§12). `existingVersion`
 * is the plan's CURRENT active `pw_plans` row (or `null` before any push) —
 * the source of both the "unchanged, skip entirely" fast path and the prior
 * `name`/price-id to diff/archive against.
 *
 * Product (`name`) and Price (`amount`/`currency`/`interval`) are diffed
 * INDEPENDENTLY, matching how Stripe itself separates the two objects: a
 * display-name-only change refreshes the Product in place with ZERO Price
 * churn, and a price-only change rotates the Price with zero Product calls.
 * Only when NEITHER differs does this skip Stripe entirely (§13).
 */
async function syncStripe(
  stripe: StripeClient,
  plan: ResolvedProduct,
  existingVersion: PwPlanVersion | null,
): Promise<{ refs: Record<string, string>; action: SyncProviderAction }> {
  const price = plan.price;
  /* istanbul ignore next -- defensive: only paid plans reach this function (see `sync`). */
  if (!price) throw new PayweaveConfigError(`plan "${plan.id}" has no price to sync to stripe.`);

  const priceHash = planPriceHash(plan);
  const prevRefs = existingVersion?.providerRefs.stripe;
  const prevProductId = prevRefs?.productId;
  const prevPriceId = prevRefs?.priceId;
  const nameChanged = (existingVersion?.name ?? null) !== (plan.name ?? null);
  const priceChanged = prevRefs?.hash !== priceHash;

  // Layer 1 — neither sub-object differs and both refs are already on file: zero stripe calls (§13).
  if (prevProductId !== undefined && prevPriceId !== undefined && !nameChanged && !priceChanged) {
    return { refs: { productId: prevProductId, priceId: prevPriceId, hash: priceHash }, action: "unchanged" };
  }

  let created = false;
  let adopted = false;

  // Product: adopt-or-create (only when we don't already know its id), else a
  // cheap name-only refresh when the display name changed but the id is known
  // — no Price work is triggered by a name change alone.
  let productId = prevProductId;
  if (productId === undefined) {
    const found = await findStripeProduct(stripe, plan.id);
    if (found) {
      productId = found.id;
      adopted = true;
    } else {
      const createdProduct = await stripe.products.create(
        { name: plan.name ?? plan.id, metadata: { pwv_plan: plan.id } },
        { idempotencyKey: `pwv-push-product-${plan.id}` },
      );
      productId = createdProduct.id;
      created = true;
    }
  } else if (nameChanged) {
    await stripe.products.update(productId, {
      name: plan.name ?? plan.id,
      metadata: { pwv_plan: plan.id },
    });
  }

  // Price: layer-2 adopt-or-create against the CURRENT hash, but ONLY when
  // the price itself changed (or is unknown yet) — a genuine first push /
  // price change finds nothing (creates fresh); a crash-resumed run finds
  // the price an earlier, interrupted run already created.
  let priceId = prevPriceId;
  if (priceId === undefined || priceChanged) {
    const foundPrice = await findStripePrice(stripe, plan.id, priceHash);
    if (foundPrice) {
      priceId = foundPrice.id;
      adopted = true;
    } else {
      const createdPrice = await stripe.prices.create(
        {
          currency: price.currency.toLowerCase(),
          unit_amount: price.amount,
          recurring: { interval: price.interval },
          product: productId,
          metadata: { pwv_plan: plan.id, pwv_hash: priceHash },
        },
        { idempotencyKey: `pwv-push-price-${plan.id}-${priceHash}` },
      );
      priceId = createdPrice.id;
      created = true;
    }

    // Price change (§12): archive the OLD price for new sales — never
    // delete, never touched again once superseded.
    if (prevPriceId !== undefined && prevPriceId !== priceId) {
      await stripe.prices.update(prevPriceId, { active: false });
    }
  }

  return {
    refs: { productId, priceId, hash: priceHash },
    action: adopted ? "adopted" : created ? "created" : "unchanged",
  };
}

// ── Paystack (Plans, §12) ────────────────────────────────────────────────────

const PAYSTACK_INTERVAL: Record<"month" | "year", "monthly" | "annually"> = {
  month: "monthly",
  year: "annually",
};

/** The `{ pwv_plan, pwv_hash }` tag this module round-trips through Paystack's `description` field (module doc comment — no native metadata field exists on Paystack Plans). */
interface PaystackTag {
  readonly pwv_plan: string;
  readonly pwv_hash: string;
}

function encodePaystackTag(tag: PaystackTag): string {
  return JSON.stringify(tag);
}

function decodePaystackTag(description: string | null | undefined): PaystackTag | undefined {
  if (description === null || description === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(description);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).pwv_plan === "string" &&
      typeof (parsed as Record<string, unknown>).pwv_hash === "string"
    ) {
      return parsed as unknown as PaystackTag;
    }
  } catch {
    // Not our tag — an ordinary human-written description. Not adoptable.
  }
  return undefined;
}

/**
 * Scan every Paystack plan for one tagged with this EXACT (`planId`, `hash`)
 * pair (crash-resume adoption — module doc comment: no `search`/`metadata`
 * mechanism exists on this resource, so a full list scan via the existing
 * `iterate()` is the only adoption path available through it).
 */
async function findAdoptablePaystackPlan(
  paystack: PaystackClient,
  planId: string,
  hash: string,
): Promise<string | undefined> {
  for await (const candidate of paystack.plans.iterate()) {
    const tag = decodePaystackTag(candidate.description ?? undefined);
    if (tag?.pwv_plan === planId && tag.pwv_hash === hash) {
      const code = candidate.plan_code;
      if (code !== undefined) return code;
    }
  }
  return undefined;
}

/** Push one paid plan onto a Paystack Plan (§12) — see the module doc comment for why this always creates a NEW plan on any content change rather than mutating in place. */
async function syncPaystack(
  paystack: PaystackClient,
  plan: ResolvedProduct,
  existingVersion: PwPlanVersion | null,
): Promise<{ refs: Record<string, string>; action: SyncProviderAction }> {
  const price = plan.price;
  /* istanbul ignore next -- defensive: only paid plans reach this function (see `sync`). */
  if (!price) throw new PayweaveConfigError(`plan "${plan.id}" has no price to sync to paystack.`);

  const hash = planPaystackHash(plan);
  const prevRefs = existingVersion?.providerRefs.paystack;
  const prevPlanCode = prevRefs?.planCode;

  // Layer 1 — hash match + ref already on file: zero paystack calls (§13).
  if (prevPlanCode !== undefined && prevRefs?.hash === hash) {
    return { refs: { planCode: prevPlanCode, hash }, action: "unchanged" };
  }

  // Layer 2 — adopt-or-create against the CURRENT hash.
  const adoptedCode = await findAdoptablePaystackPlan(paystack, plan.id, hash);
  if (adoptedCode !== undefined) {
    return { refs: { planCode: adoptedCode, hash }, action: "adopted" };
  }

  const created = await paystack.plans.create({
    name: plan.name ?? plan.id,
    amount: price.amount,
    interval: PAYSTACK_INTERVAL[price.interval],
    currency: price.currency,
    description: encodePaystackTag({ pwv_plan: plan.id, pwv_hash: hash }),
  });
  const planCode = created.data.plan_code;
  if (planCode === undefined) {
    throw new PayweaveProviderError("paystack created a plan without a plan_code", {
      provider: "paystack",
    });
  }
  return { refs: { planCode, hash }, action: "created" };
}

// ── Per-provider dispatch ────────────────────────────────────────────────────

/**
 * Push one paid plan to ONE provider. `sync()`'s own loop only ever calls
 * this for a billing-capable, configured provider — the `else` branch below
 * (flutterwave, or any future non-billing-capable key) is therefore normally
 * unreachable through the public surface, but stays a REAL, directly-callable
 * function (not folded into `sync()`'s loop body) precisely so the
 * "Flutterwave payment-plan sync is not supported yet" path is a typed,
 * testable error rather than a silent gap (module doc comment).
 */
export async function pushPlanToProvider(
  ctx: BillingContext,
  provider: PayweaveProviderKey,
  plan: ResolvedProduct,
  existingVersion: PwPlanVersion | null,
): Promise<{ refs: Record<string, string>; action: SyncProviderAction }> {
  if (provider === "stripe") {
    /* istanbul ignore next -- defensive: `sync()` only calls this for configured providers. */
    if (!ctx.stripe) throw new PayweaveConfigError("stripe is not configured on this client.");
    return syncStripe(ctx.stripe, plan, existingVersion);
  }
  if (provider === "paystack") {
    /* istanbul ignore next -- defensive: `sync()` only calls this for configured providers. */
    if (!ctx.paystack) throw new PayweaveConfigError("paystack is not configured on this client.");
    return syncPaystack(ctx.paystack, plan, existingVersion);
  }
  throw new PayweaveConfigError(
    `payweave.sync() does not support pushing plans to "${provider}" yet — its payment-plan mapping ` +
      "is deferred pending further API verification (plans-and-features.md §12 ⚠️); billing-capable " +
      `providers: ${BILLING_CAPABLE_PROVIDERS.join(", ")}.`,
  );
}

// ── The engine ───────────────────────────────────────────────────────────────

/** Build the `plans.pushVersion` input for one plan, given its already-resolved `providerRefs` (§12, database.md §2). */
function planVersionInput(plan: ResolvedProduct, providerRefs: Record<string, Record<string, string>>): PwPlanVersionInput {
  return {
    planId: plan.id,
    group: resolvePlanGroup(plan),
    isDefault: plan.default,
    name: plan.name ?? null,
    priceMinor: plan.price?.amount ?? null,
    priceCurrency: plan.price?.currency ?? null,
    priceInterval: plan.price?.interval ?? null,
    features: buildFeatures(plan),
    providerRefs,
  };
}

/**
 * `BillingSync` — push every configured plan/feature definition to the
 * database and each configured billing-capable provider
 * (plans-and-features.md §12, PW-803). Mounted as `payweave.sync()`; PW-1004's
 * `payweave push` drives this same function.
 *
 * Runtime guard (unified-config.md §3 pattern, mirrors `subscribe()`):
 * `database` AND `products` must both be configured — `sync()` has nothing to
 * push without a products array, and nowhere to push it without a database.
 */
export async function sync(ctx: BillingContext): Promise<SyncResult> {
  const database: DatabaseAdapter | undefined = ctx.database;
  if (!database) {
    throw new PayweaveConfigError(
      "payweave.sync() needs a database — pass a payweave/db/* adapter to createPayweave() " +
        "(plans-and-features.md §12, unified-config.md §3).",
    );
  }
  const products = ctx.products;
  if (!products) {
    throw new PayweaveConfigError(
      "payweave.sync() needs products — pass a `products` array to createPayweave() " +
        "(plans-and-features.md §7, §12).",
    );
  }

  const billingProviders = ctx.providers.filter(isBillingCapableProvider);
  const skippedProviders = ctx.providers.filter((provider) => !isBillingCapableProvider(provider));

  const plans: SyncPlanResult[] = [];
  for (const plan of products) {
    const existingVersion = await database.plans.getActiveVersion(plan.id);

    // §12 — free/default plans: DB only, zero provider objects, zero provider calls.
    const providerRefs: Record<string, Record<string, string>> = {};
    const providerActions: Partial<Record<BillingCapableProvider, SyncProviderAction>> = {};

    if (plan.price !== undefined) {
      for (const provider of billingProviders) {
        const result = await pushPlanToProvider(ctx, provider, plan, existingVersion);
        providerRefs[provider] = result.refs;
        providerActions[provider] = result.action;
      }
    }

    const pushed = await database.plans.pushVersion(planVersionInput(plan, providerRefs));

    plans.push({
      planId: plan.id,
      version: pushed.version,
      versionChanged: existingVersion === null || existingVersion.version !== pushed.version,
      providers: providerActions,
    });
  }

  return { plans, skippedProviders };
}
