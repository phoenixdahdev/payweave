/**
 * Builds a `DatabaseAdapter` over a connected
 * `mongodb` `Db` — the MongoDB dialect's store implementations.
 *
 * ── `_id` mapping ──────────────────────────────────────────
 * Every document IS the `src/db/schema.ts` row shape, with `id` stored as
 * `_id`: `pw_customers`/`pw_plans`/`pw_subscriptions`/`pw_feature_balances`
 * use a `pwv_<ulid>` (`./id.ts`); `pw_webhook_events`' `_id` IS `dedupeKey`
 * directly (the schema's own documented natural-key exception, `./rows.ts`).
 *
 * ── `balances.consume` / `webhookEvents.claim` atomicity ──
 * Each is EXACTLY ONE `findOneAndUpdate` with `upsert: true` and an
 * AGGREGATION-PIPELINE update (an array of stages, not a plain `$set`
 * object) — MongoDB evaluates the whole pipeline against the matched (or, on
 * upsert, the query-filter-seeded empty) document as ONE atomic
 * read-decide-write per document, on any topology, with no second round
 * trip. `consume`'s pipeline (`./period-pipeline.ts` + the stages below)
 * computes the lazy period reset and the conditional decrement server-side;
 * `claim`'s pipeline expresses "first sight OR stale-claim steal" as a single
 * eligibility check that also naturally handles the upsert race (MongoDB's
 * own documented "upsert on a unique-indexed filter" pattern: a losing
 * concurrent upsert attempt is retried by the server against the winner's
 * now-existing document, not treated as an application-level error).
 *
 * Two internal bookkeeping fields ride alongside the modeled row fields ON
 * PURPOSE (never surfaced through `./rows.ts`'s mappers, so they never leak
 * into a `Pw*` row): `pw_feature_balances._pwLastApplied` (the `consume`
 * pipeline's own computed `applied` outcome — there is no other way to learn
 * it from a single write-only round trip without a token/second read) and
 * `pw_webhook_events._pwWon` (the `claim` pipeline's computed
 * "did-I-just-win" outcome, same reasoning). All other `__`-prefixed fields
 * a pipeline computes along the way are transient and `$unset` before the
 * document is returned.
 *
 * ── `$literal` wrapping (a real MongoDB pipeline gotcha, not a mock artifact) ──
 * Inside an aggregation-PIPELINE expression, ANY bare string starting with
 * `$` is a field path (or, with `$$`, a variable) — never a literal, unless
 * wrapped in `$literal`. Every caller-supplied string embedded in a pipeline
 * below (dedupe keys, customer/feature/group ids, plan ids, provider/type
 * names, external ids, emails) is arbitrary data this adapter never controls
 * the shape of, so it is always `lit(...)`-wrapped before going into a
 * pipeline stage — a value that happened to start with `$` would otherwise
 * silently be misread as a field reference instead of stored verbatim. This
 * does NOT apply to the PLAIN (non-pipeline) `$set` updates elsewhere in this
 * file (`customersLinkProviderRef`, `subscriptionsUpdate`) — ordinary update
 * documents always treat their values as literals, pipeline or not is the
 * whole distinction.
 *
 * ── Transactions ────────────────────────────────────────────
 * `transaction()` delegates to `./topology.ts`'s `runTransaction`, which
 * tries a real multi-document transaction and falls back to the documented
 * non-atomic path on standalone deployments. Every store method below
 * accepts the ambient `session` (threaded through `deps.session`) so a
 * `tx`-scoped adapter's writes all belong to the same transaction.
 */
import { PayweaveNotFoundError } from "../../core/errors";
import { currentPeriod } from "../../products/period";
import type { DatabaseAdapter, PwConsumeInput, PwConsumeResult } from "../index";
import {
  DEFAULT_STALE_CLAIM_AFTER_MS,
  PW_ACTIVE_SUBSCRIPTION_STATUSES,
  PW_TABLES,
  type PwCustomerUpsert,
  type PwFeatureBalanceInit,
  type PwPlanVersion,
  type PwPlanVersionInput,
  type PwSubscription,
  type PwSubscriptionInput,
  type PwSubscriptionPatch,
} from "../schema";
import { isDuplicateKeyError, wrapDriverError } from "./errors";
import { generatePwId } from "./id";
import { mongoMigrationApply, mongoMigrationStatus } from "./migrations";
import { buildPeriodExpr } from "./period-pipeline";
import {
  docToCustomer,
  docToFeatureBalance,
  docToPlanVersion,
  docToSubscription,
  docToWebhookEvent,
  type CustomerDoc,
  type FeatureBalanceDoc,
  type PlanVersionDoc,
  type SubscriptionDoc,
  type WebhookEventDoc,
} from "./rows";
import { runTransaction, type MongoClientForTransactions, type MongoSessionLike } from "./topology";
import type { MongoCollectionLike, MongoDbLike } from "./types";

export interface MongoAdapterDeps {
  db: MongoDbLike;
  client: MongoClientForTransactions;
  session?: MongoSessionLike | undefined;
}

const ACTIVE_STATUSES: readonly string[] = [...PW_ACTIVE_SUBSCRIPTION_STATUSES];

/** Stable (sorted-key) JSON for order-independent structural comparison (plans.pushVersion). */
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

interface PlanContent {
  group: string;
  isDefault: boolean;
  name: string | null;
  priceMinor: number | null;
  priceCurrency: string | null;
  priceInterval: string | null;
  features: unknown;
  providerRefs: unknown;
}

const planContent = (p: PwPlanVersion | PwPlanVersionInput): PlanContent => ({
  group: p.group,
  isDefault: p.isDefault,
  name: p.name,
  priceMinor: p.priceMinor,
  priceCurrency: p.priceCurrency,
  priceInterval: p.priceInterval,
  features: p.features,
  providerRefs: p.providerRefs,
});

function planContentEquals(active: PwPlanVersion, input: PwPlanVersionInput): boolean {
  return stableStringify(planContent(active)) === stableStringify(planContent(input));
}

/**
 * Wrap a caller-supplied STRING as `$literal` before it goes into an
 * aggregation-PIPELINE stage. Inside a pipeline expression, any bare string
 * starting with `$` is a field path (`$foo`) or, with a second `$`, a
 * variable (`$$bar`) — real MongoDB behavior, not a mock artifact. Every
 * value below (dedupe keys, customer/feature/group ids, plan ids, provider
 * names, …) is arbitrary CALLER data that could — however unlikely —
 * contain a leading `$`, so it is always wrapped before being embedded in a
 * pipeline literal (never needed for the PLAIN, non-pipeline `$set` updates
 * elsewhere in this file — e.g. `customersLinkProviderRef`,
 * `subscriptionsUpdate` — where update-document values are always literal).
 */
function lit(value: string): Record<string, unknown> {
  return { $literal: value };
}

const SUBSCRIPTION_PATCH_KEYS: ReadonlyArray<keyof PwSubscriptionPatch> = [
  "planId",
  "planVersion",
  "status",
  "provider",
  "providerSubscriptionRef",
  "currentPeriodStart",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
];

/** Build a full `DatabaseAdapter` over a connected `mongodb` `Db` (mongo dialect). */
export function buildAdapter(deps: MongoAdapterDeps): DatabaseAdapter {
  const sessionOpt: Record<string, unknown> = deps.session ? { session: deps.session } : {};
  const customers = deps.db.collection<CustomerDoc>(PW_TABLES.customers);
  const plans = deps.db.collection<PlanVersionDoc>(PW_TABLES.plans);
  const subscriptions = deps.db.collection<SubscriptionDoc>(PW_TABLES.subscriptions);
  const balances = deps.db.collection<FeatureBalanceDoc>(PW_TABLES.featureBalances);
  const webhookEvents = deps.db.collection<WebhookEventDoc>(PW_TABLES.webhookEvents);

  return {
    dialect: "mongodb",
    customers: {
      getByExternalId: (externalId) => customersGetByExternalId(customers, externalId, sessionOpt),
      upsert: (input) => customersUpsert(customers, input, sessionOpt),
      linkProviderRef: (externalId, provider, ref) =>
        customersLinkProviderRef(customers, externalId, provider, ref, sessionOpt),
    },
    plans: {
      getActiveVersion: (planId) => plansGetActiveVersion(plans, planId, sessionOpt),
      listActive: () => plansListActive(plans, sessionOpt),
      pushVersion: (plan) => plansPushVersion(plans, plan, sessionOpt),
    },
    subscriptions: {
      getActive: (customerId, group) => subscriptionsGetActive(subscriptions, customerId, group, sessionOpt),
      create: (input) => subscriptionsCreate(subscriptions, input, sessionOpt),
      update: (id, patch) => subscriptionsUpdate(subscriptions, id, patch, sessionOpt),
    },
    balances: {
      get: (customerId, featureId, group) => balancesGet(balances, customerId, featureId, group, sessionOpt),
      consume: (input) => balancesConsume(balances, input, sessionOpt),
      resetTo: (customerId, featureId, group, init) =>
        balancesResetTo(balances, customerId, featureId, group, init, sessionOpt),
    },
    webhookEvents: {
      claim: (dedupeKey, meta) => webhookEventsClaim(webhookEvents, dedupeKey, meta, sessionOpt),
      markApplied: (dedupeKey) => webhookEventsMarkApplied(webhookEvents, dedupeKey, sessionOpt),
    },
    migrations: {
      status: () => mongoMigrationStatus(deps.db),
      apply: () => mongoMigrationApply(deps.db),
    },
    transaction: (fn) =>
      runTransaction(deps.client, (session) => fn(buildAdapter({ ...deps, session }))),
  };
}

// ── customers ────────────────────────────────────────────────────────────────

async function customersGetByExternalId(
  collection: MongoCollectionLike<CustomerDoc>,
  externalId: string,
  sessionOpt: Record<string, unknown>,
) {
  const doc = await collection.findOne({ externalId }, sessionOpt);
  return doc ? docToCustomer(doc) : null;
}

async function customersUpsert(
  collection: MongoCollectionLike<CustomerDoc>,
  input: PwCustomerUpsert,
  sessionOpt: Record<string, unknown>,
) {
  const now = new Date();
  const generatedId = generatePwId(now.getTime());
  const emailExpr = input.email !== undefined ? lit(input.email) : { $ifNull: ["$email", null] };
  try {
    const doc = await collection.findOneAndUpdate(
      { externalId: input.externalId },
      [
        {
          $set: {
            _id: { $ifNull: ["$_id", lit(generatedId)] },
            externalId: lit(input.externalId),
            providerIds: { $ifNull: ["$providerIds", {}] },
            email: emailExpr,
            createdAt: { $ifNull: ["$createdAt", now] },
            updatedAt: now,
          },
        },
      ],
      { upsert: true, returnDocument: "after", ...sessionOpt },
    );
    if (!doc) throw new Error("mongodb adapter: customers.upsert returned no document");
    return docToCustomer(doc);
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/mongodb: customers.upsert(${JSON.stringify(input.externalId)}) failed.`,
    );
  }
}

async function customersLinkProviderRef(
  collection: MongoCollectionLike<CustomerDoc>,
  externalId: string,
  provider: string,
  ref: string,
  sessionOpt: Record<string, unknown>,
): Promise<void> {
  // Single round trip: dot-path `$set` merges ONE provider key without
  // clobbering the rest of `providerIds` — no read-modify-write needed
  // (unlike the sqlite adapter, which reads then rewrites the whole JSON
  // blob because SQL has no equivalent of a nested-field `$set`).
  const result = await collection.updateOne(
    { externalId },
    { $set: { [`providerIds.${provider}`]: ref, updatedAt: new Date() } },
    sessionOpt,
  );
  if (result.matchedCount === 0) {
    throw new PayweaveNotFoundError(
      `payweave/db/mongodb: customers.linkProviderRef: no customer with externalId ` +
        `${JSON.stringify(externalId)}.`,
    );
  }
}

// ── plans ────────────────────────────────────────────────────────────────────

async function plansGetActiveVersion(
  collection: MongoCollectionLike<PlanVersionDoc>,
  planId: string,
  sessionOpt: Record<string, unknown>,
) {
  const doc = await collection.findOne({ planId }, { sort: { version: -1 }, ...sessionOpt });
  return doc ? docToPlanVersion(doc) : null;
}

async function plansListActive(
  collection: MongoCollectionLike<PlanVersionDoc>,
  sessionOpt: Record<string, unknown>,
) {
  const docs = await collection
    .aggregate(
      [
        { $sort: { planId: 1, version: -1 } },
        { $group: { _id: "$planId", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
      ],
      sessionOpt,
    )
    .toArray();
  return docs.map(docToPlanVersion);
}

const PUSH_VERSION_MAX_ATTEMPTS = 5;

async function plansPushVersion(
  collection: MongoCollectionLike<PlanVersionDoc>,
  plan: PwPlanVersionInput,
  sessionOpt: Record<string, unknown>,
): Promise<PwPlanVersion> {
  // No injectable `now`/no atomicity race REQUIRED by the conformance suite
  // (only `balances.consume`/`webhookEvents.claim` carry that obligation)
  // — but a bounded retry loop on the (planId, version)
  // unique-index collision hardens this against real concurrent pushes
  // without needing a session transaction for every call.
  for (let attempt = 0; attempt < PUSH_VERSION_MAX_ATTEMPTS; attempt++) {
    const active = await plansGetActiveVersion(collection, plan.planId, sessionOpt);
    if (active && planContentEquals(active, plan)) return active;

    const now = new Date();
    const nextVersion = (active?.version ?? 0) + 1;
    const doc: PlanVersionDoc = {
      _id: generatePwId(now.getTime()),
      planId: plan.planId,
      version: nextVersion,
      group: plan.group,
      isDefault: plan.isDefault,
      name: plan.name,
      priceMinor: plan.priceMinor,
      priceCurrency: plan.priceCurrency,
      priceInterval: plan.priceInterval,
      features: plan.features,
      providerRefs: plan.providerRefs,
      pushedAt: now,
    };
    try {
      await collection.insertOne(doc, sessionOpt);
      return docToPlanVersion(doc);
    } catch (error) {
      if (isDuplicateKeyError(error) && attempt < PUSH_VERSION_MAX_ATTEMPTS - 1) continue;
      throw wrapDriverError(
        error,
        `payweave/db/mongodb: plans.pushVersion(${JSON.stringify(plan.planId)}) failed.`,
      );
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws. */
  throw new Error("payweave/db/mongodb: plans.pushVersion exhausted retries under contention");
}

// ── subscriptions ────────────────────────────────────────────────────────────

async function subscriptionsGetActive(
  collection: MongoCollectionLike<SubscriptionDoc>,
  customerId: string,
  group: string,
  sessionOpt: Record<string, unknown>,
) {
  const doc = await collection.findOne(
    { customerId, group, status: { $in: ACTIVE_STATUSES } },
    sessionOpt,
  );
  return doc ? docToSubscription(doc) : null;
}

async function subscriptionsCreate(
  collection: MongoCollectionLike<SubscriptionDoc>,
  input: PwSubscriptionInput,
  sessionOpt: Record<string, unknown>,
): Promise<PwSubscription> {
  const now = new Date();
  const doc: SubscriptionDoc = {
    _id: generatePwId(now.getTime()),
    customerId: input.customerId,
    planId: input.planId,
    planVersion: input.planVersion,
    group: input.group,
    status: input.status,
    provider: input.provider,
    providerSubscriptionRef: input.providerSubscriptionRef,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await collection.insertOne(doc, sessionOpt);
    return docToSubscription(doc);
  } catch (error) {
    throw wrapDriverError(
      error,
      `payweave/db/mongodb: subscriptions.create for customer ${JSON.stringify(input.customerId)} ` +
        `group ${JSON.stringify(input.group)} violated a uniqueness rule (an active-set ` +
        "subscription already exists for this customer/group, or another constraint failed).",
    );
  }
}

async function subscriptionsUpdate(
  collection: MongoCollectionLike<SubscriptionDoc>,
  id: string,
  patch: PwSubscriptionPatch,
  sessionOpt: Record<string, unknown>,
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const patchRecord = patch as Record<string, unknown>;
  for (const key of SUBSCRIPTION_PATCH_KEYS) {
    if (!(key in patch) || patchRecord[key] === undefined) continue;
    set[key] = patchRecord[key];
  }
  try {
    const doc = await collection.findOneAndUpdate(
      { _id: id },
      { $set: set },
      { returnDocument: "after", ...sessionOpt },
    );
    if (!doc) {
      throw new PayweaveNotFoundError(
        `payweave/db/mongodb: subscriptions.update: no subscription with id ${JSON.stringify(id)}.`,
      );
    }
    return docToSubscription(doc);
  } catch (error) {
    if (error instanceof PayweaveNotFoundError) throw error;
    throw wrapDriverError(error, `payweave/db/mongodb: subscriptions.update(${JSON.stringify(id)}) failed.`);
  }
}

// ── balances ─────────────────────────────────────────────────────────────────

async function balancesGet(
  collection: MongoCollectionLike<FeatureBalanceDoc>,
  customerId: string,
  featureId: string,
  group: string,
  sessionOpt: Record<string, unknown>,
) {
  const doc = await collection.findOne({ customerId, featureId, group }, sessionOpt);
  return doc ? docToFeatureBalance(doc) : null;
}

/**
 * Build `consume`'s single pipeline-update — see the module header. Every
 * stage is a plain `$set`/`$unset`; the whole array is what
 * `findOneAndUpdate` evaluates atomically.
 */
function buildConsumePipeline(input: PwConsumeInput, generatedId: string): Record<string, unknown>[] {
  const nowMs = input.now.getTime();
  const nowLiteral = input.now;
  const conditional = input.conditional === true;
  const amount = input.amount;

  return [
    // A: fill creation defaults. Deliberately does NOT rely on MongoDB
    // auto-seeding the query filter's equality fields into a fresh upserted
    // document (that behavior is a real-server implementation detail this
    // sandbox cannot verify one way or the other) — EVERY field the document
    // needs, including customerId/featureId/group, is explicitly `$ifNull`'d
    // from this call's own inputs (the "$ifNull defaults" pattern),
    // so the pipeline is correct regardless of that assumption.
    {
      $set: {
        _id: { $ifNull: ["$_id", lit(generatedId)] },
        customerId: { $ifNull: ["$customerId", lit(input.customerId)] },
        featureId: { $ifNull: ["$featureId", lit(input.featureId)] },
        group: { $ifNull: ["$group", lit(input.group)] },
        anchor: { $ifNull: ["$anchor", input.init.anchor] },
        resetInterval: { $ifNull: ["$resetInterval", lit(input.init.resetInterval)] },
        limit: { $ifNull: ["$limit", input.init.limit] },
        planId: { $ifNull: ["$planId", lit(input.init.planId)] },
        planVersion: { $ifNull: ["$planVersion", input.init.planVersion] },
        used: { $ifNull: ["$used", 0] },
      },
    },
    // B: the anchor-relative current period (./period-pipeline.ts).
    {
      $set: {
        __period: buildPeriodExpr(nowMs, "$anchor", "$resetInterval"),
      },
    },
    // C: reset-due / conditional-gate arithmetic, entirely server-side.
    {
      $set: {
        __hasPeriodEnd: { $ne: [{ $ifNull: ["$periodEnd", null] }, null] },
      },
    },
    {
      $set: {
        __resetDue: {
          $cond: ["$__hasPeriodEnd", { $gte: [nowLiteral, "$periodEnd"] }, true],
        },
      },
    },
    {
      $set: {
        __baseUsed: { $cond: ["$__resetDue", 0, "$used"] },
      },
    },
    // Each of the following stays in its OWN `$set` stage rather than sharing
    // one with the field it depends on — deliberately conservative given this
    // sandbox cannot execute a real pipeline to confirm same-stage field
    // visibility ordering.
    {
      $set: {
        __remaining: { $subtract: ["$limit", "$__baseUsed"] },
      },
    },
    {
      $set: {
        __applied: conditional ? { $gte: ["$__remaining", amount] } : true,
      },
    },
    {
      $set: {
        __finalUsed: {
          $cond: ["$__applied", { $add: ["$__baseUsed", amount] }, "$__baseUsed"],
        },
        __shouldWrite: { $or: ["$__applied", "$__resetDue"] },
      },
    },
    // D: write the real fields — untouched (including `updatedAt`) when
    // denied AND no reset was due (leave the row untouched in that case).
    {
      $set: {
        used: { $cond: ["$__shouldWrite", "$__finalUsed", "$used"] },
        periodStart: { $cond: ["$__shouldWrite", "$__period.start", "$periodStart"] },
        periodEnd: { $cond: ["$__shouldWrite", "$__period.end", "$periodEnd"] },
        updatedAt: { $cond: ["$__shouldWrite", nowLiteral, { $ifNull: ["$updatedAt", nowLiteral] }] },
        _pwLastApplied: "$__applied",
      },
    },
    {
      $unset: [
        "__period",
        "__hasPeriodEnd",
        "__resetDue",
        "__baseUsed",
        "__remaining",
        "__applied",
        "__finalUsed",
        "__shouldWrite",
      ],
    },
  ];
}

async function balancesConsume(
  collection: MongoCollectionLike<FeatureBalanceDoc>,
  input: PwConsumeInput,
  sessionOpt: Record<string, unknown>,
): Promise<PwConsumeResult> {
  const generatedId = generatePwId(input.now.getTime());
  const pipeline = buildConsumePipeline(input, generatedId);
  const doc = await collection.findOneAndUpdate(
    { customerId: input.customerId, featureId: input.featureId, group: input.group },
    pipeline,
    { upsert: true, returnDocument: "after", ...sessionOpt },
  );
  if (!doc) throw new Error("mongodb adapter: balances.consume returned no document");
  const applied = doc._pwLastApplied ?? true;
  return { ...docToFeatureBalance(doc), applied };
}

async function balancesResetTo(
  collection: MongoCollectionLike<FeatureBalanceDoc>,
  customerId: string,
  featureId: string,
  group: string,
  init: PwFeatureBalanceInit,
  sessionOpt: Record<string, unknown>,
): Promise<void> {
  // No injectable `now` in this contract method — a plan
  // change's anchor IS "now", and this is
  // an unconditional REPLACE regardless of the row's prior state, so no
  // pipeline/atomicity concern applies (unlike `consume`).
  const now = new Date();
  const period = currentPeriod(init.anchor.getTime(), init.resetInterval, now.getTime());
  const generatedId = generatePwId(now.getTime());
  await collection.findOneAndUpdate(
    { customerId, featureId, group },
    [
      {
        $set: {
          _id: { $ifNull: ["$_id", lit(generatedId)] },
          // Same defensive explicitness as `buildConsumePipeline` — never
          // rely on MongoDB auto-seeding the filter's equality fields, and
          // never let a caller-supplied string be misread as a field path.
          customerId: lit(customerId),
          featureId: lit(featureId),
          group: lit(group),
          used: 0,
          limit: init.limit,
          resetInterval: lit(init.resetInterval),
          anchor: init.anchor,
          periodStart: new Date(period.start),
          periodEnd: new Date(period.end),
          planId: lit(init.planId),
          planVersion: init.planVersion,
          updatedAt: now,
        },
      },
    ],
    { upsert: true, ...sessionOpt },
  );
}

// ── webhookEvents ────────────────────────────────────────────────────────────

/**
 * Build `claim`'s single pipeline-update — see the module header. Expresses
 * "first sight OR stale-claim steal" as one eligibility check
 * (`_pwWon`) computed and written in the SAME atomic operation, then read
 * back from the returned document — no second round trip, no caller-unique
 * token needed (a single `findOneAndUpdate` is one atomic per-document
 * operation regardless of topology, so at most one concurrent caller ever
 * observes `_pwWon: true` for a given transition.
 */
function buildClaimPipeline(
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
): Record<string, unknown>[] {
  const staleClaimAfterMs = meta.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_AFTER_MS;
  const staleThreshold = new Date(meta.now.getTime() - staleClaimAfterMs);
  return [
    {
      $set: {
        // Same defensive explicitness as `buildConsumePipeline` — never rely
        // on MongoDB auto-seeding the `_id` filter's equality match on
        // upsert, and never let a caller-supplied string be misread as a
        // field path.
        _id: { $ifNull: ["$_id", lit(dedupeKey)] },
        provider: { $ifNull: ["$provider", lit(meta.provider)] },
        type: { $ifNull: ["$type", lit(meta.type)] },
        receivedAt: { $ifNull: ["$receivedAt", meta.now] },
        appliedAt: { $ifNull: ["$appliedAt", null] },
        claimedAt: { $ifNull: ["$claimedAt", null] },
      },
    },
    {
      $set: {
        _pwWon: {
          $and: [
            { $eq: ["$appliedAt", null] },
            { $or: [{ $eq: ["$claimedAt", null] }, { $lte: ["$claimedAt", staleThreshold] }] },
          ],
        },
      },
    },
    {
      $set: {
        claimedAt: { $cond: ["$_pwWon", meta.now, "$claimedAt"] },
      },
    },
  ];
}

async function webhookEventsClaim(
  collection: MongoCollectionLike<WebhookEventDoc>,
  dedupeKey: string,
  meta: { provider: string; type: string; now: Date; staleClaimAfterMs?: number },
  sessionOpt: Record<string, unknown>,
): Promise<boolean> {
  const pipeline = buildClaimPipeline(dedupeKey, meta);
  const doc = await collection.findOneAndUpdate(
    { _id: dedupeKey },
    pipeline,
    { upsert: true, returnDocument: "after", ...sessionOpt },
  );
  return doc?._pwWon === true;
}

async function webhookEventsMarkApplied(
  collection: MongoCollectionLike<WebhookEventDoc>,
  dedupeKey: string,
  sessionOpt: Record<string, unknown>,
): Promise<void> {
  await collection.updateOne({ _id: dedupeKey }, { $set: { appliedAt: new Date() } }, sessionOpt);
}

// Re-exported so tests can round-trip a raw document without duplicating the
// mapping logic.
export { docToWebhookEvent };
