import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveNotFoundError } from "../../src/core/errors";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

describe("beneficiaries.create", () => {
  it("POSTs /beneficiaries", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/beneficiaries",
        json: loadFixture("flutterwave", "beneficiaries", "create.success"),
      },
    ]);
    const res = await h.client.beneficiaries.create({
      account_bank: "044",
      account_number: "0690000040",
      beneficiary_name: "Jane Doe",
    });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/beneficiaries");
    expect(req.body).toMatchObject({ account_bank: "044", account_number: "0690000040" });
    expect(res.data.id).toBe(5307);
  });
});

describe("beneficiaries.list + iterate + fetch", () => {
  it("GETs /beneficiaries", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/beneficiaries",
        json: loadFixture("flutterwave", "beneficiaries", "list.success"),
      },
    ]);
    const res = await h.client.beneficiaries.list();
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/beneficiaries");
    expect(res.data).toHaveLength(2);
  });

  it("iterate() yields every beneficiary and stops at total_pages", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/beneficiaries",
        json: loadFixture("flutterwave", "beneficiaries", "list.success"),
      },
    ]);
    const ids: number[] = [];
    for await (const b of h.client.beneficiaries.iterate()) ids.push(b.id!);
    expect(ids).toEqual([5307, 5308]);
    expect(await h.requests()).toHaveLength(1);
  });

  it("GETs /beneficiaries/:id", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/beneficiaries/:id",
        json: loadFixture("flutterwave", "beneficiaries", "fetch.success"),
      },
    ]);
    const res = await h.client.beneficiaries.fetch(5307);
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/beneficiaries/5307");
    expect(res.data.id).toBe(5307);
  });

  it("maps a 404 fetch to PayweaveNotFoundError", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/beneficiaries/:id",
        status: 404,
        json: { status: "error", message: "Beneficiary not found", data: null },
      },
    ]);
    await expect(h.client.beneficiaries.fetch(0)).rejects.toBeInstanceOf(PayweaveNotFoundError);
  });
});
