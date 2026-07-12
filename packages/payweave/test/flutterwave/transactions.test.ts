import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError } from "../../src/core/errors";
import { HttpClient, bearer } from "../../src/core/http";
import { FLW_V3_BASE_URL } from "../../src/core/config";
import { FlutterwaveClient } from "../../src/flutterwave/client";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

describe("transactions.verify (by numeric id)", () => {
  it("GETs /transactions/:id/verify and returns the parsed transaction", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/:id/verify",
        json: loadFixture("flutterwave", "transactions", "verify.success"),
      },
    ]);

    const res = await h.client.transactions.verify(288200108);
    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v3/transactions/288200108/verify");
    expect(res.data.status).toBe("successful");
    expect(res.data.id).toBe(288200108);
  });

  it("maps a 404 for an unknown id to PayweaveNotFoundError", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/:id/verify",
        status: 404,
        json: loadFixture("flutterwave", "transactions", "not_found"),
      },
    ]);
    await expect(h.client.transactions.verify(999999999)).rejects.toBeInstanceOf(
      PayweaveNotFoundError,
    );
  });
});

describe("transactions.verifyByReference (by tx_ref)", () => {
  it("GETs /transactions/verify_by_reference with tx_ref query", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/verify_by_reference",
        json: loadFixture("flutterwave", "transactions", "verify_by_reference.success"),
      },
    ]);

    const res = await h.client.transactions.verifyByReference("pwv_tx_001");
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transactions/verify_by_reference");
    expect(req.search.get("tx_ref")).toBe("pwv_tx_001");
    expect(res.data.tx_ref).toBe("pwv_tx_001");
  });
});

describe("transactions.list + iterate", () => {
  it("GETs /transactions with query and returns the list", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions",
        json: loadFixture("flutterwave", "transactions", "list.success"),
      },
    ]);

    const res = await h.client.transactions.list({ status: "successful" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transactions");
    expect(req.search.get("status")).toBe("successful");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() walks every page via meta.page_info.total_pages", async () => {
    // Dynamic MSW server so page 1 and page 2 return different fixtures.
    const { http, HttpResponse } = await import("msw");
    const { setupServer } = await import("msw/node");
    const server = setupServer(
      http.get("https://api.flutterwave.com/v3/transactions", ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        const fixture =
          page === "2"
            ? loadFixture("flutterwave", "transactions", "list.page2")
            : loadFixture("flutterwave", "transactions", "list.page1");
        return HttpResponse.json(fixture as Record<string, unknown>);
      }),
    );
    server.listen({ onUnhandledRequest: "error" });
    try {
      const client = new FlutterwaveClient(
        new HttpClient({
          baseUrl: FLW_V3_BASE_URL,
          auth: bearer("FLWSECK_TEST-harness"),
          provider: "flutterwave",
          version: "v3",
          maxRetries: 0,
        }),
        "v3",
      );
      const ids: number[] = [];
      for await (const tx of client.transactions.iterate({ status: "successful" })) {
        ids.push(tx.id);
      }
      expect(ids).toEqual([1, 2]);
    } finally {
      server.close();
    }
  });
});

describe("transactions.fees", () => {
  it("GETs /transactions/fee with amount + currency query", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transactions/fee",
        json: loadFixture("flutterwave", "transactions", "fee.success"),
      },
    ]);
    const res = await h.client.transactions.fees({ amount: 5000, currency: "NGN" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transactions/fee");
    expect(req.search.get("amount")).toBe("5000");
    expect(req.search.get("currency")).toBe("NGN");
    expect(res.data.fee).toBe(70);
  });
});
