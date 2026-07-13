/**
 * Config wiring for the `database` slot (PW-701): the placeholder is gone —
 * `resolvePayweaveConfig` structurally checks for a real `DatabaseAdapter`
 * and keeps the spec's exact required-with-products message
 * (unified-config.md §2 rule 5, database.md §1).
 */
import { describe, expect, it } from "vitest";
import { resolvePayweaveConfig } from "../../src/core/config";
import { PayweaveConfigError } from "../../src/core/errors";
import { plan } from "../../src/products/plan";
import { makeStubDatabaseAdapter } from "./stub-adapter";

const PROVIDER = { paystack: { secretKey: "sk_test_x" } };

/** Capture the thrown error so class AND message can be asserted together. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("rule 5 — products require a database (exact spec message)", () => {
  it("throws the exact database.md §1 / unified-config.md §2 message", () => {
    const err = captureError(() =>
      resolvePayweaveConfig({ ...PROVIDER, products: [plan({ id: "pro" })] }),
    );
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toBe("plans need a database — pass a payweave/db/* adapter");
  });

  it("is satisfied by a structurally-valid adapter", () => {
    const database = makeStubDatabaseAdapter("prisma");
    const resolved = resolvePayweaveConfig({
      ...PROVIDER,
      database,
      products: [plan({ id: "free" }), plan({ id: "pro" })],
    });
    // Pass-through by reference — the resolver must never clone/wrap the adapter.
    expect(resolved.database).toBe(database);
    expect(resolved.database?.dialect).toBe("prisma");
  });
});

describe("database slot — structural DatabaseAdapter check", () => {
  it.each([
    ["a plain object bag (the old placeholder shape)", { kind: "prisma" }],
    ["null", null],
    ["a string", "postgres://localhost/db"],
    ["an adapter missing a store", { ...makeStubDatabaseAdapter(), balances: undefined }],
    [
      "a store missing its spot-checked method",
      { ...makeStubDatabaseAdapter(), webhookEvents: { markApplied: async () => undefined } },
    ],
    [
      "a non-function transaction member",
      { ...makeStubDatabaseAdapter(), transaction: "BEGIN" },
    ],
    ["a missing dialect", { ...makeStubDatabaseAdapter(), dialect: undefined }],
  ])("rejects %s with the adapter-shape message", (_label, database) => {
    const err = captureError(() => resolvePayweaveConfig({ ...PROVIDER, database }));
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(
      /database: expected a payweave\/db\/\* database adapter object/,
    );
  });

  it("rejects a raw ORM/driver client handed over instead of an adapter factory output", () => {
    // Shaped like a PrismaClient: models + $transaction, but none of our stores.
    const prismaLike = {
      user: { findMany: async () => [] },
      $transaction: async () => undefined,
      $connect: async () => undefined,
    };
    const err = captureError(() => resolvePayweaveConfig({ ...PROVIDER, database: prismaLike }));
    expect(err).toBeInstanceOf(PayweaveConfigError);
    expect((err as Error).message).toMatch(/payweave\/db\/\*/);
  });

  it("accepts adapters of any dialect string (community adapters stay first-class)", () => {
    for (const dialect of ["postgres", "mongodb", "community-dynamodb"]) {
      const resolved = resolvePayweaveConfig({
        ...PROVIDER,
        database: makeStubDatabaseAdapter(dialect),
      });
      expect(resolved.database?.dialect).toBe(dialect);
    }
  });

  it("still treats database as optional — pure payments SDK without it", () => {
    const resolved = resolvePayweaveConfig(PROVIDER);
    expect(resolved.database).toBeUndefined();
  });
});
