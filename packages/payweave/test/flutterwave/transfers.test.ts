import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveValidationError } from "../../src/core/errors";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

describe("transfers.create", () => {
  it("POSTs /transfers with amount in major units unchanged", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/transfers",
        json: loadFixture("flutterwave", "transfers", "create.success"),
      },
    ]);
    const res = await h.client.transfers.create({
      account_bank: "044",
      account_number: "0690000040",
      amount: 5000,
      currency: "NGN",
      narration: "Payout",
    });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/transfers");
    expect(req.body).toMatchObject({ account_bank: "044", amount: 5000 });
    expect(res.data.id).toBe(27494);
  });

  it("throws PayweaveValidationError before sending when account_number is missing", async () => {
    h = await makeFlutterwave([]);
    await expect(
      // @ts-expect-error — intentionally invalid input
      h.client.transfers.create({ account_bank: "044", amount: 5000 }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("transfers.list + iterate + fetch + fees", () => {
  it("GETs /transfers with query", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transfers",
        json: loadFixture("flutterwave", "transfers", "list.success"),
      },
    ]);
    const res = await h.client.transfers.list({ status: "SUCCESSFUL" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transfers");
    expect(req.search.get("status")).toBe("SUCCESSFUL");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() yields every transfer and stops at total_pages", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transfers",
        json: loadFixture("flutterwave", "transfers", "list.success"),
      },
    ]);
    const ids: number[] = [];
    for await (const t of h.client.transfers.iterate()) ids.push(t.id!);
    expect(ids).toEqual([27494, 27495]);
    expect(await h.requests()).toHaveLength(1);
  });

  it("GETs /transfers/:id", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transfers/:id",
        json: loadFixture("flutterwave", "transfers", "fetch.success"),
      },
    ]);
    const res = await h.client.transfers.fetch(27494);
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transfers/27494");
    expect(res.data.id).toBe(27494);
  });

  it("GETs /transfers/fee with amount + currency", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/transfers/fee",
        json: loadFixture("flutterwave", "transfers", "fee.success"),
      },
    ]);
    const res = await h.client.transfers.fees({ amount: 5000, currency: "NGN" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/transfers/fee");
    expect(req.search.get("amount")).toBe("5000");
    expect(res.data[0]!.fee).toBe(45);
  });
});
