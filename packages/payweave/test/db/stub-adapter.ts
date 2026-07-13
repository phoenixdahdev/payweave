/**
 * A TYPED stub `DatabaseAdapter` for contract/type/config tests (PW-701).
 *
 * This is NOT an adapter implementation (those are PW-704+) and it is NOT
 * conformant — every method throws. It exists so tests can (a) prove a
 * conforming shape typechecks against the contract and (b) hand
 * `resolvePayweaveConfig` something that passes the structural
 * `database` check without pretending persistence exists.
 */
import type { DatabaseAdapter } from "../../src/db/index";

const notImplemented = (method: string) => async (): Promise<never> => {
  throw new Error(`stub DatabaseAdapter: ${method} is not implemented — real adapters land in PW-704+`);
};

/** Build a fresh, fully-shaped (but non-functional) `DatabaseAdapter`. */
export function makeStubDatabaseAdapter(dialect: DatabaseAdapter["dialect"] = "stub"): DatabaseAdapter {
  return {
    dialect,
    customers: {
      getByExternalId: notImplemented("customers.getByExternalId"),
      upsert: notImplemented("customers.upsert"),
      linkProviderRef: notImplemented("customers.linkProviderRef"),
    },
    plans: {
      getActiveVersion: notImplemented("plans.getActiveVersion"),
      listActive: notImplemented("plans.listActive"),
      pushVersion: notImplemented("plans.pushVersion"),
    },
    subscriptions: {
      getActive: notImplemented("subscriptions.getActive"),
      create: notImplemented("subscriptions.create"),
      update: notImplemented("subscriptions.update"),
    },
    balances: {
      get: notImplemented("balances.get"),
      consume: notImplemented("balances.consume"),
      resetTo: notImplemented("balances.resetTo"),
    },
    webhookEvents: {
      claim: notImplemented("webhookEvents.claim"),
      markApplied: notImplemented("webhookEvents.markApplied"),
    },
    migrations: {
      status: notImplemented("migrations.status"),
      apply: notImplemented("migrations.apply"),
    },
    transaction: notImplemented("transaction"),
  };
}
