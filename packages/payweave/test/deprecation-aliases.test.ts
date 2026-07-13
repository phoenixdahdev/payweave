/**
 * PW-504 — deprecation-event semantics of the legacy aliases (unified-config.md
 * §6, §9 criterion 5): `createPaystack` / `createFlutterwave` / `PaymentSDK`
 * share ONE module-level latch, so at most ONE deprecation event fires per
 * process — across every alias and every call. The event goes through the
 * tripping call's injected `logger` only (never `console.*`); with no logger
 * configured the alias stays silent.
 *
 * The latch is module state, so each test isolates it with `vi.resetModules()`
 * + a dynamic import of a FRESH facade module (the latch is deliberately not
 * weakened with a public reset hook).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkLogEvent } from "../src/core/logger";

type FacadeModule = typeof import("../src/index");

/** Import a fresh copy of the facade so each test gets an untripped latch. */
async function freshFacade(): Promise<FacadeModule> {
  return await import("../src/index");
}

/** Collect every event an injected logger receives. */
function collect(): { events: SdkLogEvent[]; logger: (event: SdkLogEvent) => void } {
  const events: SdkLogEvent[] = [];
  return { events, logger: (event) => events.push(event) };
}

beforeEach(() => {
  vi.resetModules();
});

describe("deprecation event — shape", () => {
  it("createPaystack emits ONE `warn` event naming the alias and the replacement", async () => {
    const { createPaystack } = await freshFacade();
    const { events, logger } = collect();

    createPaystack({ secretKey: "sk_test_dep", logger });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("warn");
    expect(event.message).toContain("createPaystack()");
    expect(event.message).toContain("createPayweave({ paystack: { ... } })");
    expect(event.message).toContain("deprecated");
    expect(event.deprecated).toBe("createPaystack()");
    expect(event.replacement).toBe("createPayweave({ paystack: { ... } })");
  });

  it("createFlutterwave and PaymentSDK name themselves when they trip the latch", async () => {
    {
      const { createFlutterwave } = await freshFacade();
      const { events, logger } = collect();
      createFlutterwave({ secretKey: "FLWSECK_TEST-dep", logger });
      expect(events).toHaveLength(1);
      expect(events[0]!.message).toContain("createFlutterwave()");
      expect(events[0]!.message).toContain("createPayweave({ flutterwave: { ... } })");
    }
    vi.resetModules();
    {
      const { PaymentSDK } = await freshFacade();
      const { events, logger } = collect();
      PaymentSDK({ provider: "paystack", secretKey: "sk_test_dep", logger });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("warn");
      expect(events[0]!.message).toContain("PaymentSDK()");
      expect(events[0]!.message).toContain("createPayweave");
    }
  });

  it("`new PaymentSDK(...)` trips the latch exactly like the call form", async () => {
    const { PaymentSDK } = await freshFacade();
    const { events, logger } = collect();

    const sdk = new PaymentSDK({ provider: "paystack", secretKey: "sk_test_dep", logger });

    expect(sdk.provider).toBe("paystack");
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toContain("PaymentSDK()");
  });
});

describe("deprecation event — ONE per process across ALL aliases (global latch)", () => {
  it("repeat calls to the SAME alias emit no second event", async () => {
    const { createPaystack } = await freshFacade();
    const first = collect();
    const second = collect();

    createPaystack({ secretKey: "sk_test_dep", logger: first.logger });
    createPaystack({ secretKey: "sk_test_dep", logger: second.logger });
    createPaystack({ secretKey: "sk_test_dep", logger: first.logger });

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(0);
  });

  it("a DIFFERENT alias after the first emits no second event", async () => {
    const { createPaystack, createFlutterwave, PaymentSDK } = await freshFacade();
    const first = collect();
    const later = collect();

    createPaystack({ secretKey: "sk_test_dep", logger: first.logger });
    createFlutterwave({ secretKey: "FLWSECK_TEST-dep", logger: later.logger });
    PaymentSDK({ provider: "flutterwave", secretKey: "FLWSECK_TEST-dep", logger: later.logger });
    new PaymentSDK({ provider: "paystack", secretKey: "sk_test_dep", logger: later.logger });

    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.deprecated).toBe("createPaystack()");
    expect(later.events).toHaveLength(0);
  });

  it("a call that throws still counts as the tripping call", async () => {
    const { createPaystack, createFlutterwave } = await freshFacade();
    const first = collect();
    const later = collect();

    // Invalid key prefix → PayweaveConfigError from the delegated resolver,
    // but the deprecated API WAS called, so the latch trips on this call.
    expect(() => createPaystack({ secretKey: "sk_bogus", logger: first.logger })).toThrow();

    createFlutterwave({ secretKey: "FLWSECK_TEST-dep", logger: later.logger });
    expect(first.events).toHaveLength(1);
    expect(later.events).toHaveLength(0);
  });
});

describe("deprecation event — no logger configured", () => {
  it("stays silent and does not crash without a logger", async () => {
    const { createPaystack, createFlutterwave, PaymentSDK } = await freshFacade();

    expect(() => {
      createPaystack({ secretKey: "sk_test_dep" });
      createFlutterwave({ secretKey: "FLWSECK_TEST-dep" });
      PaymentSDK({ provider: "paystack", secretKey: "sk_test_dep" });
    }).not.toThrow();
  });

  it("a logger-less first call consumes the latch (event goes to the TRIPPING call only)", async () => {
    const { createPaystack, createFlutterwave } = await freshFacade();
    const later = collect();

    // Brief-pinned reading: the latch trips on the first alias CALL; if that
    // call has no logger there is no output anywhere — a later call with a
    // logger does NOT get a make-up event.
    createFlutterwave({ secretKey: "FLWSECK_TEST-dep" });
    createPaystack({ secretKey: "sk_test_dep", logger: later.logger });

    expect(later.events).toHaveLength(0);
  });
});

describe("deprecation aliases — delegation sanity (details in facade.test.ts)", () => {
  it("the wrapper carries the delegated client surface plus the legacy props", async () => {
    const { createPaystack, PaystackSDK } = await freshFacade();
    const { events, logger } = collect();

    const sdk = createPaystack({ secretKey: "sk_test_dep", logger });

    expect(sdk).toBeInstanceOf(PaystackSDK);
    expect(sdk.provider).toBe("paystack");
    expect(sdk.environment).toBe("test");
    expect(sdk.providers).toEqual(["paystack"]);
    expect(sdk.defaultProvider).toBe("paystack");
    expect(typeof sdk.paystack.transactions.initialize).toBe("function");
    expect(typeof sdk.webhooks.constructEvent).toBe("function");
    expect(sdk.unified.checkout).toBe(sdk.checkout);
    // The deprecation event is the ONLY thing the wrapper logged.
    expect(events).toHaveLength(1);
  });
});
