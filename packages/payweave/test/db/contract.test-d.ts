/**
 * Compile-time contract tests for the `DatabaseAdapter` interface + row types
 * (database.md §3, PW-701 AC): a conforming adapter typechecks; missing or
 * misshapen members fail compilation; row types are exactly the z.infer of
 * their schemas.
 */
import { describe, it, expectTypeOf } from "vitest";
import type { z } from "zod";
import type {
  DatabaseAdapter,
  PwClaimMeta,
  PwConsumeInput,
  PwConsumeResult,
  PwCustomer,
  PwFeatureBalance,
  PwFeatureBalanceInit,
  PwMigrationApplyResult,
  PwPlanVersion,
  PwSubscription,
  PwSubscriptionInput,
  PwWebhookEvent,
} from "../../src/db/index";
import {
  pwCustomerSchema,
  pwFeatureBalanceSchema,
  pwPlanVersionSchema,
  pwSubscriptionSchema,
  pwWebhookEventSchema,
} from "../../src/db/schema";
import type { PayweaveConfig, ResolvedPayweaveConfig } from "../../src/core/config";
import { makeStubDatabaseAdapter } from "./stub-adapter";

// Freshness-checked assignment target: literals with missing/mistyped members
// fail to compile here.
const acceptAdapter = (adapter: DatabaseAdapter): DatabaseAdapter => adapter;

const stub = makeStubDatabaseAdapter();

describe("DatabaseAdapter — conforming adapters typecheck", () => {
  it("accepts a fully-shaped adapter (stub helper is annotation-checked)", () => {
    expectTypeOf(stub).toEqualTypeOf<DatabaseAdapter>();
    acceptAdapter(stub);
  });

  it("accepts a realistic unannotated literal via `satisfies`", () => {
    const row: PwCustomer = {
      id: "pwv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      externalId: "user_1",
      providerIds: {},
      email: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const adapter = {
      dialect: "postgres",
      customers: {
        getByExternalId: async (externalId: string) => (externalId === row.externalId ? row : null),
        upsert: async () => row,
        linkProviderRef: async () => undefined,
      },
      plans: {
        getActiveVersion: async () => null,
        listActive: async () => [],
        pushVersion: async (plan) => ({
          ...plan,
          id: row.id,
          version: 1,
          pushedAt: new Date(),
        }),
      },
      subscriptions: {
        getActive: async () => null,
        create: async (input: PwSubscriptionInput) => ({
          ...input,
          id: row.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: async (): Promise<PwSubscription> => {
          throw new Error("unused in type test");
        },
      },
      balances: {
        get: async () => null,
        consume: async (input) => ({
          id: row.id,
          customerId: input.customerId,
          featureId: input.featureId,
          group: input.group,
          used: input.amount,
          limit: input.init.limit,
          resetInterval: input.init.resetInterval,
          anchor: input.init.anchor,
          periodStart: input.init.anchor,
          periodEnd: input.now,
          planId: input.init.planId,
          planVersion: input.init.planVersion,
          updatedAt: input.now,
          applied: input.conditional !== true,
        }),
        resetTo: async () => undefined,
      },
      webhookEvents: {
        claim: async (_key: string, meta) => meta.now.getTime() >= 0,
        markApplied: async () => undefined,
      },
      migrations: {
        status: async () => ({ pending: ["0001_init"], applied: [] }),
        apply: async () => ({ applied: ["0001_init"] }),
      },
      transaction: async <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => fn(stub),
    } satisfies DatabaseAdapter;
    acceptAdapter(adapter);
  });

  it("keeps the dialect union open for community adapters", () => {
    expectTypeOf<"postgres">().toExtend<DatabaseAdapter["dialect"]>();
    expectTypeOf<"mongodb">().toExtend<DatabaseAdapter["dialect"]>();
    expectTypeOf<"community-dynamodb">().toExtend<DatabaseAdapter["dialect"]>();
    // @ts-expect-error — dialect is a string, not a number
    acceptAdapter({ ...stub, dialect: 3 });
  });
});

describe("DatabaseAdapter — missing/misshapen members fail compilation", () => {
  it("rejects adapters missing a store", () => {
    // @ts-expect-error — webhookEvents store is required
    acceptAdapter({ ...stub, webhookEvents: undefined });
    // @ts-expect-error — balances store is required
    acceptAdapter({ ...stub, balances: undefined });
    const withoutMigrations: Omit<DatabaseAdapter, "migrations"> = stub;
    // @ts-expect-error — migrations store is required
    acceptAdapter(withoutMigrations);
  });

  it("rejects stores missing a method", () => {
    acceptAdapter({
      ...stub,
      // @ts-expect-error — claim is required next to markApplied
      webhookEvents: { markApplied: stub.webhookEvents.markApplied },
    });
    acceptAdapter({
      ...stub,
      // @ts-expect-error — consume is required on balances
      balances: { get: stub.balances.get, resetTo: stub.balances.resetTo },
    });
  });

  it("rejects misshapen method signatures", () => {
    acceptAdapter({
      ...stub,
      webhookEvents: {
        // @ts-expect-error — claim must resolve to boolean, not string
        claim: async () => "claimed",
        markApplied: stub.webhookEvents.markApplied,
      },
    });
    acceptAdapter({
      ...stub,
      customers: {
        ...stub.customers,
        // @ts-expect-error — upsert must resolve to a full PwCustomer row
        upsert: async () => ({ externalId: "user_1" }),
      },
    });
    // @ts-expect-error — transaction must return the callback's promise, not void
    acceptAdapter({ ...stub, transaction: () => undefined });
  });

  it("requires consume's init template and typed meta on claim", () => {
    expectTypeOf<PwConsumeInput>().toHaveProperty("init").toEqualTypeOf<PwFeatureBalanceInit>();
    expectTypeOf<PwConsumeInput["conditional"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PwConsumeInput["now"]>().toEqualTypeOf<Date>();
    expectTypeOf<PwConsumeResult>().toEqualTypeOf<PwFeatureBalance & { applied: boolean }>();
    expectTypeOf<PwClaimMeta["staleClaimAfterMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PwClaimMeta["now"]>().toEqualTypeOf<Date>();
    expectTypeOf<PwMigrationApplyResult["instructions"]>().toEqualTypeOf<string | undefined>();
    const consume = stub.balances.consume;
    // @ts-expect-error — init is required (lazy-creation template)
    void consume({ customerId: "c", featureId: "f", group: "g", amount: 1, now: new Date() });
  });
});

describe("row types are z.infer of their schemas (no hand-written drift)", () => {
  it("equates each exported row type with its schema inference", () => {
    expectTypeOf<PwCustomer>().toEqualTypeOf<z.infer<typeof pwCustomerSchema>>();
    expectTypeOf<PwPlanVersion>().toEqualTypeOf<z.infer<typeof pwPlanVersionSchema>>();
    expectTypeOf<PwSubscription>().toEqualTypeOf<z.infer<typeof pwSubscriptionSchema>>();
    expectTypeOf<PwFeatureBalance>().toEqualTypeOf<z.infer<typeof pwFeatureBalanceSchema>>();
    expectTypeOf<PwWebhookEvent>().toEqualTypeOf<z.infer<typeof pwWebhookEventSchema>>();
  });

  it("pins the §2 nullability + integer decisions", () => {
    expectTypeOf<PwCustomer["email"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PwCustomer["providerIds"]>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<PwPlanVersion["priceMinor"]>().toEqualTypeOf<number | null>();
    expectTypeOf<PwSubscription["status"]>().toEqualTypeOf<
      "active" | "past_due" | "canceled" | "incomplete" | "trialing"
    >();
    expectTypeOf<PwSubscription["cancelAtPeriodEnd"]>().toEqualTypeOf<boolean>();
    expectTypeOf<PwFeatureBalance["used"]>().toEqualTypeOf<number>();
    expectTypeOf<PwFeatureBalance["anchor"]>().toEqualTypeOf<Date>();
    expectTypeOf<PwWebhookEvent["claimedAt"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<PwWebhookEvent["appliedAt"]>().toEqualTypeOf<Date | null>();
  });
});

describe("config wiring (PW-701) — database slot is the real contract", () => {
  it("types PayweaveConfig.database / ResolvedPayweaveConfig.database as DatabaseAdapter", () => {
    expectTypeOf<PayweaveConfig["database"]>().toEqualTypeOf<DatabaseAdapter | undefined>();
    expectTypeOf<ResolvedPayweaveConfig["database"]>().toEqualTypeOf<
      DatabaseAdapter | undefined
    >();
  });

  it("rejects non-adapter database values at compile time", () => {
    const acceptConfig = (config: PayweaveConfig): PayweaveConfig => config;
    acceptConfig({ stripe: { secretKey: "sk_test_x" }, database: makeStubDatabaseAdapter() });
    // @ts-expect-error — a bag of unknowns is no longer an acceptable adapter
    acceptConfig({ stripe: { secretKey: "sk_test_x" }, database: { kind: "prisma" } });
  });
});
