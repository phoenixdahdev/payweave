/**
 * `subscribe()` — the billing module's entry point (plans-and-features.md §11,
 * PW-804). This file is the foundation the rest of EPIC 8/9 builds on:
 *
 * - PW-803 (`BillingSync`) pushes `pw_plans` rows with `provider_refs` —
 *   {@link subscribe} only READS them (`database.plans.getActiveVersion`); it
 *   never pushes/syncs. Until PW-803 lands, callers (and this ticket's tests)
 *   seed `pw_plans` rows directly via `database.plans.pushVersion(...)`.
 * - PW-805 (`event.apply()`) flips the `incomplete` row this module creates to
 *   `active` once the provider confirms payment — see the "seams for PW-805"
 *   note below for exactly what correlation data this module leaves behind.
 * - PW-902 (`check`/`report`) reuses {@link resolvePlanGroup} and the
 *   {@link BillingContext} shape (or a lookalike) to resolve a customer's
 *   effective plan/group the same way `subscribe` does.
 *
 * Everything here operates ONLY through the `DatabaseAdapter` contract
 * (`../db/index`) and the existing Surface A resource classes
 * (`StripeClient`/`PaystackClient`) — no new provider HTTP calls, no changes
 * to the DB contract.
 *
 * ── Seams left for PW-805 (webhook → billing state) ─────────────────────────
 * The `incomplete` row this module creates has `providerSubscriptionRef: null`
 * — the real provider subscription id doesn't exist until checkout completes.
 * Correlation data left for the webhook handler to pick up:
 * - Stripe: the Checkout Session's `client_reference_id` AND
 *   `metadata.pwv_reference` are both set to the local `pw_subscriptions` row
 *   id (`incompleteRow.id`). `checkout.session.completed` carries both plus
 *   the resulting `subscription` id, so PW-805 can resolve
 *   `incompleteRow.id → sub_xxx` directly from that one event without a new
 *   DB query method (`database.md §3`, `subscriptions.getActive` only
 *   surfaces the active-set statuses today — `incomplete` rows aren't
 *   listable by (customer, group), so event-carried correlation is the only
 *   path available inside this ticket's file scope).
 * - Paystack: `transactions.initialize` is called with OUR OWN `reference` set
 *   to the local `pw_subscriptions` row id — Paystack echoes it back on every
 *   subsequent event/verify call, so `subscription.create`/`charge.success`
 *   payloads carry it as `data.reference` verbatim.
 *
 * ── Spec-silent decision: a plan without an explicit `group` ────────────────
 * `default: true` plans always have a `group` (`plan()` enforces it,
 * plans-and-features.md §4), but a non-default plan may not. `pw_subscriptions
 * .group` is a required, non-null column (database.md §2), so *something* has
 * to fill it. The spec doesn't say what — the conservative reading kept here
 * is: a groupless plan is its own singleton group (its `id`), so subscribing
 * to it never contends with any other plan (see {@link resolvePlanGroup}).
 *
 * ── Spec-silent decision: a second `subscribe()` while a checkout is pending ─
 * `incomplete` sits OUTSIDE the partial-unique active-status set
 * (`active`/`past_due`/`trialing`, database.md §2), and the `DatabaseAdapter`
 * contract exposes no way to look up a customer's pending `incomplete` row by
 * (customer, group) — only `subscriptions.getActive` exists, and it
 * deliberately excludes `incomplete`. Superseding the prior pending row would
 * need a new adapter read method, which is out of this ticket's scope (the DB
 * contract is forbidden territory here). The conservative, contract-respecting
 * behavior implemented below: each paid `subscribe()` call with no ACTIVE-set
 * row in the group creates a NEW `incomplete` row — this never violates the
 * partial-unique index (it doesn't apply to `incomplete`), but it can leave
 * an orphaned `incomplete` row behind if the customer abandons a checkout and
 * re-subscribes. Provider-customer creation is still idempotent either way
 * (`ensureProviderCustomer` below) — the "two subscribes → one provider
 * customer" acceptance criterion holds regardless of this row-level gap.
 * Flagged per agent-playbook §6 rather than silently narrowed.
 *
 * ── Spec-silent decision: Paystack requires an email `subscribe()` doesn't take ─
 * Paystack's customer-create AND transaction-initialize endpoints both require
 * `email` (not optional — `paystack/schemas/customers.ts`,
 * `paystack/schemas/transactions.ts`), but `plans-and-features.md §11`'s
 * `subscribe()` signature carries no `email` field, and v1 exposes no public
 * `payweave.customers.*` surface to set one. The conservative path taken
 * here: read `email` off the LOCAL `pw_customers` row (nullable,
 * `database.md §2`) — callers who need Paystack billing must have set it via
 * their OWN `database` adapter reference (`database.customers.upsert({
 * externalId, email })`) at some point before calling `subscribe`; `upsert`
 * preserves an existing email when a later call omits it (PW-706). Missing
 * email + Paystack throws a clear, actionable {@link PayweaveValidationError}
 * rather than silently failing at the provider.
 */
import type { PayweaveProviderKey, ResolvedProduct } from "../core/config";
import { PayweaveConfigError, PayweaveProviderError, PayweaveValidationError } from "../core/errors";
import type { DatabaseAdapter, PwCustomer, PwPlanVersion, PwSubscription } from "../db/index";
import type { PaystackClient } from "../paystack/client";
import type { StripeClient } from "../stripe/client";
import { advance } from "./period";

/**
 * Providers with a working `subscribe()` mapping in v1
 * (plans-and-features.md §11/§12, providers.md §4). Flutterwave's
 * payment-plan flow is ⚠️ pending PW-803's build-time doc verification — it is
 * not billing-capable yet, so `subscribe()` rejects it with a typed
 * capability error rather than silently no-op'ing or guessing a mapping.
 */
export const BILLING_CAPABLE_PROVIDERS = ["stripe", "paystack"] as const;

/** A provider key {@link BILLING_CAPABLE_PROVIDERS} lists. */
export type BillingCapableProvider = (typeof BILLING_CAPABLE_PROVIDERS)[number];

function isBillingCapableProvider(provider: PayweaveProviderKey): provider is BillingCapableProvider {
  return (BILLING_CAPABLE_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Everything `subscribe()` (and, by the same shape, PW-805's `event.apply()`
 * and PW-902's `check`/`report`) needs out of `createPayweave`'s resolved
 * config and mounted provider surfaces. Deliberately NOT the full
 * `PayweaveClient` — just the billing-relevant slice, so this module never
 * imports `../index` (avoids a circular import back into the facade).
 */
export interface BillingContext {
  readonly database: DatabaseAdapter | undefined;
  readonly products: readonly ResolvedProduct[] | undefined;
  readonly providers: readonly PayweaveProviderKey[];
  readonly defaultProvider: PayweaveProviderKey;
  readonly stripe: StripeClient | undefined;
  readonly paystack: PaystackClient | undefined;
}

/**
 * `subscribe()`'s input (plans-and-features.md §11). Mirrors `SubscribeInput<C>`
 * in `src/index.ts` field-for-field, but non-generic — the compile-time
 * `PlanIds<C>`/`ConfiguredProvider<C>` narrowing is the client facade's job
 * (it widens back to these plain types before calling in here).
 */
export interface SubscribeInput {
  /** YOUR user id (external id) — Payweave maps it to provider customers (§11.1). */
  customerId: string;
  planId: string;
  /** Defaults to `defaultProvider`; must be a configured, billing-capable provider. */
  provider?: PayweaveProviderKey;
  /** Checkout redirect target on success (provider-dependent, §11). */
  successUrl?: string;
  /** Checkout redirect target on cancel (provider-dependent, §11). */
  cancelUrl?: string;
}

/**
 * `subscribe()`'s discriminated result (§11) — mirrors `SubscribeResult` in
 * `src/index.ts` exactly (kept as a separate identical declaration rather than
 * an import to avoid a circular module dependency on the facade).
 */
export type SubscribeResult =
  | { status: "checkout"; checkoutUrl: string; reference: string }
  | { status: "active"; planId: string; subscription: PwSubscription | null };

/**
 * A plan's group (§4). `default: true` plans always have one (`plan()`
 * enforces it), but a non-default plan may not — see the module doc comment's
 * "groupless plan" decision: it becomes its own singleton group.
 */
export function resolvePlanGroup(plan: ResolvedProduct): string {
  return plan.group ?? plan.id;
}

/**
 * Nominal period bounds for a subscription row created OUTSIDE a provider's
 * own billing cycle math: a free (non-default) plan has no `interval` at all,
 * and a freshly-created `incomplete` paid row doesn't have Stripe/Paystack's
 * real cycle yet either (Stripe's pinned API version puts that on the
 * subscription's ITEMS — `items.data[].current_period_start/end`, NOT the
 * subscription itself — database.md/PW-604 finding; PW-805 overwrites these
 * placeholders with the provider's real bounds once the webhook confirms).
 * `pw_subscriptions.currentPeriodStart/End` are non-null columns
 * (database.md §2), so a placeholder is required either way; anchoring it at
 * `now` for one plan-interval (defaulting to `month` when the plan has none)
 * is the conservative reading (`AGENTS.md §8`).
 */
function nominalPeriod(interval: "month" | "year" | undefined, now: Date): { start: Date; end: Date } {
  const startMs = now.getTime();
  return { start: new Date(startMs), end: new Date(advance(startMs, interval ?? "month", 1)) };
}

function findPlan(
  products: readonly ResolvedProduct[] | undefined,
  planId: string,
): ResolvedProduct | undefined {
  return products?.find((p) => p.id === planId);
}

function groupExclusivityError(group: string): PayweaveValidationError {
  // Exact message per plans-and-features.md §11.6 — asserted verbatim by tests.
  return new PayweaveValidationError(`customer already has an active plan in group '${group}'`);
}

/**
 * Create (once) or reuse the per-provider customer for `customerRow`
 * (§11.1): consult `providerIds` BEFORE ever creating one remotely, and
 * persist a fresh id via `linkProviderRef` — this is what makes "two
 * subscribes → one provider customer" hold regardless of how many times
 * `subscribe()` runs.
 */
async function ensureProviderCustomer(
  ctx: BillingContext,
  database: DatabaseAdapter,
  provider: BillingCapableProvider,
  customerRow: PwCustomer,
  externalId: string,
): Promise<string> {
  const existing = customerRow.providerIds[provider];
  if (existing !== undefined) return existing;

  if (provider === "stripe") {
    /* istanbul ignore next -- defensive: unreachable — `provider` was already
       confirmed configured (and therefore mounted) before this is called. */
    if (!ctx.stripe) throw new PayweaveConfigError("stripe is not configured on this client.");
    const created = await ctx.stripe.customers.create({
      ...(customerRow.email !== null ? { email: customerRow.email } : {}),
      metadata: { pwv_reference: customerRow.id },
    });
    await database.customers.linkProviderRef(externalId, "stripe", created.id);
    return created.id;
  }

  /* istanbul ignore next -- defensive: same as the stripe branch above. */
  if (!ctx.paystack) throw new PayweaveConfigError("paystack is not configured on this client.");
  if (customerRow.email === null) {
    throw new PayweaveValidationError(
      "paystack billing requires a customer email, but this customer has none on file — call " +
        "`database.customers.upsert({ externalId, email })` against your own adapter reference " +
        "before subscribing (plans-and-features.md §11 does not carry an email on `subscribe()`'s " +
        "input, and Paystack's customer/transaction APIs require one).",
    );
  }
  const created = await ctx.paystack.customers.create({
    email: customerRow.email,
    metadata: { pwv_reference: customerRow.id },
  });
  const customerCode = created.data.customer_code;
  if (customerCode === undefined) {
    throw new PayweaveProviderError("paystack created a customer without a customer_code", {
      provider: "paystack",
    });
  }
  await database.customers.linkProviderRef(externalId, "paystack", customerCode);
  return customerCode;
}

/** Stripe leg of the paid-plan branch — checkout session in `subscription` mode against the synced price (§11.3). */
async function createStripeCheckout(
  ctx: BillingContext,
  database: DatabaseAdapter,
  plan: ResolvedProduct,
  providerRefs: Record<string, string>,
  customerRow: PwCustomer,
  incompleteRow: PwSubscription,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const priceId = providerRefs.priceId;
  if (priceId === undefined) {
    throw new PayweaveValidationError(
      `plan "${plan.id}" has no pushed stripe price — run \`payweave push\` (plans-and-features.md §12).`,
    );
  }
  /* istanbul ignore next -- defensive: `provider` was confirmed configured before this is called. */
  if (!ctx.stripe) throw new PayweaveConfigError("stripe is not configured on this client.");

  const providerCustomerId = await ensureProviderCustomer(
    ctx,
    database,
    "stripe",
    customerRow,
    input.customerId,
  );

  const session = await ctx.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: providerCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // Correlates the resulting `checkout.session.completed` event back to
    // this local row (see the module doc comment's "seams for PW-805" note).
    client_reference_id: incompleteRow.id,
    metadata: { pwv_reference: incompleteRow.id, pwv_plan: plan.id, pwv_customer: customerRow.id },
    ...(input.successUrl !== undefined ? { success_url: input.successUrl } : {}),
    ...(input.cancelUrl !== undefined ? { cancel_url: input.cancelUrl } : {}),
  });

  if (!session.url) {
    throw new PayweaveProviderError("stripe created a checkout session without a hosted URL", {
      provider: "stripe",
      raw: session,
    });
  }
  return { status: "checkout", checkoutUrl: session.url, reference: session.id };
}

/** Paystack leg of the paid-plan branch — initialize a transaction against the synced plan code (§11.3). */
async function createPaystackCheckout(
  ctx: BillingContext,
  database: DatabaseAdapter,
  plan: ResolvedProduct,
  providerRefs: Record<string, string>,
  customerRow: PwCustomer,
  incompleteRow: PwSubscription,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const planCode = providerRefs.planCode;
  if (planCode === undefined) {
    throw new PayweaveValidationError(
      `plan "${plan.id}" has no pushed paystack plan code — run \`payweave push\` (plans-and-features.md §12).`,
    );
  }
  /* istanbul ignore next -- defensive: `provider` was confirmed configured before this is called. */
  if (!ctx.paystack) throw new PayweaveConfigError("paystack is not configured on this client.");

  await ensureProviderCustomer(ctx, database, "paystack", customerRow, input.customerId);
  // `ensureProviderCustomer` may have just linked the ref — the email guard
  // below is still needed even when the provider customer already existed
  // (a previous `subscribe()` call could have created it before an email was
  // ever set on the local row).
  if (customerRow.email === null) {
    throw new PayweaveValidationError(
      "paystack billing requires a customer email, but this customer has none on file — call " +
        "`database.customers.upsert({ externalId, email })` against your own adapter reference " +
        "before subscribing (plans-and-features.md §11 does not carry an email on `subscribe()`'s " +
        "input, and Paystack's customer/transaction APIs require one).",
    );
  }

  // `plan.price` is already resolved to integer minor units (kobo) — never
  // re-converted here (AGENTS.md golden rule 7).
  const amountMinor = plan.price?.amount;
  /* istanbul ignore next -- defensive: only paid plans reach this function. */
  if (amountMinor === undefined) {
    throw new PayweaveValidationError(`plan "${plan.id}" has no price to charge.`);
  }

  const res = await ctx.paystack.transactions.initialize({
    email: customerRow.email,
    amount: amountMinor,
    plan: planCode,
    // Our OWN reference — Paystack echoes it back on every subsequent
    // event/verify call, so it doubles as the local row's stable correlation
    // key for PW-805 (see the module doc comment).
    reference: incompleteRow.id,
    metadata: { pwv_reference: incompleteRow.id, pwv_plan: plan.id, pwv_customer: customerRow.id },
  });

  return { status: "checkout", checkoutUrl: res.data.authorization_url, reference: res.data.reference };
}

/**
 * The `subscribe()` flow (plans-and-features.md §11). See the module doc
 * comment for the spec-silent decisions this implementation makes.
 */
export async function subscribe(ctx: BillingContext, input: SubscribeInput): Promise<SubscribeResult> {
  // unified-config.md §3: billing methods throw PayweaveConfigError at call
  // time when `database` is missing, regardless of what the type system
  // could prove statically (products-without-database is already impossible
  // once config parse succeeds — core/config.ts rule 5 — but a client with
  // NEITHER `database` NOR `products` configured still exposes `subscribe`
  // on its surface, and this is the runtime half of that guard).
  const database = ctx.database;
  if (!database) {
    throw new PayweaveConfigError(
      "payweave.subscribe() needs a database — pass a payweave/db/* adapter to createPayweave() " +
        "(plans-and-features.md §11, unified-config.md §3).",
    );
  }

  const plan = findPlan(ctx.products, input.planId);
  if (!plan) {
    throw new PayweaveValidationError(
      `unknown plan "${input.planId}" — configure it in \`products\` and run \`payweave push\` ` +
        "(plans-and-features.md §7).",
    );
  }

  const provider = input.provider ?? ctx.defaultProvider;
  if (!ctx.providers.includes(provider)) {
    throw new PayweaveConfigError(
      `provider "${provider}" is not configured on this client — configured: ${ctx.providers.join(", ")}.`,
    );
  }
  if (!isBillingCapableProvider(provider)) {
    throw new PayweaveConfigError(
      `provider "${provider}" does not support billing (subscribe) in v1 (providers.md §4, ` +
        `plans-and-features.md §11) — billing-capable providers: ${BILLING_CAPABLE_PROVIDERS.join(", ")}.`,
    );
  }

  const group = resolvePlanGroup(plan);

  // §11.1 — upsert the local customer row unconditionally (cheap, no provider
  // call); provider CUSTOMER creation is deferred to the paid branch below,
  // so default/free subscribes make zero provider calls (§12).
  const customerRow = await database.customers.upsert({ externalId: input.customerId });
  const existingActive = await database.subscriptions.getActive(customerRow.id, group);

  // §11.5/§11.6 — default plan: no-op absent an active sub in the group;
  // group-exclusivity error if one exists (paid or free — "one active plan
  // per group at a time", §4).
  if (plan.default) {
    if (existingActive) throw groupExclusivityError(group);
    return { status: "active", planId: plan.id, subscription: null };
  }

  // §11.6 — any other plan in an already-occupied group: same error.
  if (existingActive) throw groupExclusivityError(group);

  // §11.2 — resolve the plan's active pushed version (needed for BOTH the
  // free and paid branches: `pw_subscriptions.planVersion` is required
  // either way).
  const pushedVersion: PwPlanVersion | null = await database.plans.getActiveVersion(plan.id);
  if (!pushedVersion) {
    throw new PayweaveValidationError(
      `plan "${plan.id}" has no pushed version — run \`payweave push\` to sync your products ` +
        "(plans-and-features.md §11).",
    );
  }

  const now = new Date();

  // §11.4 — free non-default plan: local activation, zero provider calls.
  if (plan.price === undefined) {
    const period = nominalPeriod(undefined, now);
    const row = await database.subscriptions.create({
      customerId: customerRow.id,
      planId: plan.id,
      planVersion: pushedVersion.version,
      group,
      status: "active",
      provider: null,
      providerSubscriptionRef: null,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      cancelAtPeriodEnd: false,
    });
    return { status: "active", planId: plan.id, subscription: row };
  }

  // §11.3 — paid plan: create the provider checkout using the pushed
  // provider_refs; the local row starts `incomplete` and is flipped to
  // `active` by PW-805's `event.apply()`, never here.
  const providerRefs = pushedVersion.providerRefs[provider];
  if (!providerRefs) {
    throw new PayweaveValidationError(
      `plan "${plan.id}" has no pushed ${provider} provider refs — run \`payweave push\` ` +
        "(plans-and-features.md §12).",
    );
  }

  const period = nominalPeriod(plan.price.interval, now);
  const incompleteRow = await database.subscriptions.create({
    customerId: customerRow.id,
    planId: plan.id,
    planVersion: pushedVersion.version,
    group,
    status: "incomplete",
    provider,
    providerSubscriptionRef: null,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: false,
  });

  if (provider === "stripe") {
    return createStripeCheckout(ctx, database, plan, providerRefs, customerRow, incompleteRow, input);
  }
  return createPaystackCheckout(ctx, database, plan, providerRefs, customerRow, incompleteRow, input);
}
