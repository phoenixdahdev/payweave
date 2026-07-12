import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError } from "../../src/core/errors";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

describe("refunds.create", () => {
  it("POSTs /transactions/:id/refund with amount in major units", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/transactions/:id/refund",
        json: loadFixture("flutterwave", "refunds", "create.success"),
      },
    ]);
    const res = await h.client.refunds.create(288200108, { amount: 1000 });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/transactions/288200108/refund");
    expect(req.body).toEqual({ amount: 1000 });
    expect(res.data.status).toBe("completed");
  });

  it("defaults to a full refund (empty body) when amount omitted", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/transactions/:id/refund",
        json: loadFixture("flutterwave", "refunds", "create.success"),
      },
    ]);
    await h.client.refunds.create(288200108);
    const req = await h.lastRequest();
    expect(req.body).toEqual({});
  });
});

describe("refunds.list + iterate + fetch", () => {
  it("GETs /refunds and lists refunds", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/refunds",
        json: loadFixture("flutterwave", "refunds", "list.success"),
      },
    ]);
    const res = await h.client.refunds.list({ status: "completed" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/refunds");
    expect(req.search.get("status")).toBe("completed");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() yields every refund and stops at total_pages", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/refunds",
        json: loadFixture("flutterwave", "refunds", "list.success"),
      },
    ]);
    const ids: number[] = [];
    for await (const r of h.client.refunds.iterate()) ids.push(r.id!);
    expect(ids).toEqual([15221, 15222]);
    expect(await h.requests()).toHaveLength(1);
  });

  it("GETs /refunds/:id", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/refunds/:id",
        json: loadFixture("flutterwave", "refunds", "fetch.success"),
      },
    ]);
    const res = await h.client.refunds.fetch(15221);
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/refunds/15221");
    expect(res.data.id).toBe(15221);
  });

  it("maps a 404 fetch to PayweaveNotFoundError", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/refunds/:id",
        status: 404,
        json: { status: "error", message: "Refund not found", data: null },
      },
    ]);
    await expect(h.client.refunds.fetch(0)).rejects.toBeInstanceOf(PayweaveNotFoundError);
  });
});
