/**
 * Smoke test for the conformance suite (PW-702).
 *
 * WHY THIS EXISTS INSTEAD OF RUNNING THE SUITE: `test/db/conformance.ts` is
 * the contract's executable spec and "lands red" — no adapter exists until
 * PW-704+, and database.md prescribes no in-memory reference adapter (§6
 * lists only the real first-party adapters as runners). Deliberately, the
 * suite file does not match the vitest include glob and nothing invokes
 * `runDatabaseConformance` yet, so CI stays green while the spec is
 * unimplemented. What CI MUST still guarantee is that the suite itself is
 * sound: it imports, registers cleanly, covers every database.md §6 area,
 * and stays extensible for PW-903 — that is exactly what this file asserts,
 * by dry-running the full registration through `collectConformanceTestPlan`
 * (which also proves registration never constructs an adapter: the dry-run
 * factory throws if called).
 */
import { describe, expect, it } from "vitest";
import {
  CLAIM_RACE_CALLS,
  CONSUME_RACE_CALLS,
  CONSUME_RACE_LIMIT,
  collectConformanceTestPlan,
  coreConformanceScenarios,
  registerDatabaseConformance,
  runDatabaseConformance,
  type ConformanceTestApi,
  type DatabaseConformanceScenario,
} from "./conformance";

describe("conformance suite — exports", () => {
  it("exports the parameterized entry point and the §5/§6 spec constants", () => {
    expect(typeof runDatabaseConformance).toBe("function");
    expect(typeof registerDatabaseConformance).toBe("function");
    // database.md §5: N=50 calls, limit 30; §6: 20 parallel claims.
    expect(CONSUME_RACE_CALLS).toBe(50);
    expect(CONSUME_RACE_LIMIT).toBe(30);
    expect(CLAIM_RACE_CALLS).toBe(20);
  });

  it("names every core scenario uniquely", () => {
    const names = coreConformanceScenarios.map((s) => s.name);
    expect(names.length).toBeGreaterThanOrEqual(9);
    expect(new Set(names).size).toBe(names.length);
    for (const scenario of coreConformanceScenarios) {
      expect(typeof scenario.register).toBe("function");
    }
  });
});

describe("conformance suite — dry-run registration (no adapter constructed)", () => {
  const plan = collectConformanceTestPlan();

  it("registers under the parameterized root suite", () => {
    expect(plan.suites[0]).toBe("DatabaseAdapter conformance — test-plan");
    expect(plan.tests.length).toBeGreaterThanOrEqual(35);
    // Every registered test title is unique — duplicated titles would make
    // adapter failures ambiguous.
    expect(new Set(plan.tests).size).toBe(plan.tests.length);
  });

  it("covers every database.md §6 bullet", () => {
    const mustRegister: [string, RegExp][] = [
      // CRUD + uniqueness invariants for all tables
      ["customers CRUD", /customers.*round-trips/],
      ["customer upsert uniqueness", /upsert is idempotent per externalId/],
      ["provider ref linking", /linkProviderRef merges/],
      ["subscriptions partial-unique rule", /rejects a second active-set row per \(customer, group\)/],
      ["partial-unique covers only the active set", /canceled\/incomplete rows do not occupy/],
      ["balance row uniqueness", /unique per \(customer, feature, group\)/],
      ["migrations ledger", /apply\(\) is idempotent/],
      // pushVersion idempotency
      ["pushVersion no-op", /re-pushing identical content is a no-op/],
      ["pushVersion bump", /changed content appends version \+ 1/],
      ["append-only history", /history is never mutated/],
      // claim once-only + stale re-acquisition
      ["claim once under parallelism", /20 parallel claims of one key → exactly one true/],
      ["stale re-acquisition, never before", /re-claimable at staleClaimAfterMs — and never before/],
      ["applied is terminal", /applied key is never re-claimable/],
      ["steal refreshes claimed_at", /steal refreshes claimed_at/],
      ["parallel steal atomic", /parallel steal attempts on a stale claim → exactly one true/],
      // consume conditional flag semantics
      ["conditional never over-admits / never mutates", /never mutates on denial/],
      ["unconditional goes negative", /may go negative/],
      // §5 concurrency + boundary tests
      ["THE §5 race", /50 parallel conditional consumes against limit 30/],
      ["no lost updates", /lose zero updates/],
      ["atomic lazy creation", /exactly one row \(atomic lazy creation\)/],
      ["no double-reset at the boundary", /reset exactly once \(no double-reset\)/],
      ["half-open boundary", /resets at exactly period_end/],
      ["no reset before the boundary", /does not reset strictly before period_end/],
      ["idle roll-forward", /roll forward to the CURRENT window/],
      ["EOM clamping without drift", /clamp per-period without drift/],
      // transaction semantics
      ["transaction rollback", /rolls back every write when the callback throws/],
    ];
    for (const [label, pattern] of mustRegister) {
      const hit = plan.tests.some((t) => pattern.test(t));
      expect(hit, `expected the plan to register a test for: ${label} (${pattern})`).toBe(true);
    }
  });

  it("swaps rollback for the documented fallback test when atomicTransactions is false", () => {
    const fallback = collectConformanceTestPlan({ atomicTransactions: false });
    expect(fallback.tests.some((t) => /rolls back every write/.test(t))).toBe(false);
    expect(fallback.tests.some((t) => /documented non-atomic fallback mode/.test(t))).toBe(true);
    // Everything else is identical between the two modes.
    expect(fallback.tests.length).toBe(plan.tests.length);
  });

  it("appends extra scenarios without reshaping the suite (PW-903 extension point)", () => {
    const metering: DatabaseConformanceScenario = {
      name: "metering — walkthrough flow (placeholder for PW-903)",
      register(api) {
        api.it("fresh default-plan customer: 100 reports then a denial", () => undefined);
      },
    };
    const extended = collectConformanceTestPlan({ scenarios: [metering] });
    expect(extended.tests.length).toBe(plan.tests.length + 1);
    // Appended AFTER the core list, under the same root.
    expect(extended.tests.at(-1)).toBe(
      "DatabaseAdapter conformance — test-plan > metering — walkthrough flow (placeholder for PW-903) > fresh default-plan customer: 100 reports then a denial",
    );
    expect(extended.suites.at(-1)).toContain("metering — walkthrough flow");
  });

  it("rejects duplicate scenario names loudly", () => {
    const dupe = coreConformanceScenarios[0];
    expect(dupe).toBeDefined();
    expect(() => collectConformanceTestPlan({ scenarios: dupe ? [dupe] : [] })).toThrow(
      /duplicate conformance scenario name/,
    );
  });

  it("never invokes the adapter factory during registration", () => {
    let constructed = 0;
    const api: ConformanceTestApi = {
      describe: (_t, fn) => fn(),
      it: () => undefined,
      beforeEach: () => undefined,
      afterEach: () => undefined,
    };
    registerDatabaseConformance(api, "count-factory", () => {
      constructed += 1;
      throw new Error("unreachable — registration must be adapter-free");
    });
    expect(constructed).toBe(0);
  });
});
