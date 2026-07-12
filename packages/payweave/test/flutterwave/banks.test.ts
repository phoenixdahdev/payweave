import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveValidationError } from "../../src/core/errors";
import { makeFlutterwave, type FlutterwaveHarness } from "./_harness";

let h: FlutterwaveHarness;
afterEach(() => h?.close());

describe("banks.list", () => {
  it("GETs /banks/:country and returns a flat array", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/banks/:country",
        json: loadFixture("flutterwave", "banks", "list.success"),
      },
    ]);
    const res = await h.client.banks.list("NG");
    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v3/banks/NG");
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.code).toBe("044");
  });
});

describe("banks.branches", () => {
  it("GETs /banks/:id/branches", async () => {
    h = await makeFlutterwave([
      {
        method: "get",
        url: "https://api.flutterwave.com/v3/banks/:id/branches",
        json: loadFixture("flutterwave", "banks", "branches.success"),
      },
    ]);
    const res = await h.client.banks.branches(132);
    const req = await h.lastRequest();
    expect(req.path).toBe("/v3/banks/132/branches");
    expect(res.data[0]!.branch_code).toBe("044150149");
  });
});

describe("banks.resolveAccount", () => {
  it("POSTs /accounts/resolve with account_number + account_bank", async () => {
    h = await makeFlutterwave([
      {
        method: "post",
        url: "https://api.flutterwave.com/v3/accounts/resolve",
        json: loadFixture("flutterwave", "banks", "resolve.success"),
      },
    ]);
    const res = await h.client.banks.resolveAccount({
      account_number: "0690000040",
      account_bank: "044",
    });
    const req = await h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v3/accounts/resolve");
    expect(req.body).toEqual({ account_number: "0690000040", account_bank: "044" });
    expect(res.data.account_name).toBe("Jane Doe");
  });

  it("throws PayweaveValidationError before sending when account_bank is missing", async () => {
    h = await makeFlutterwave([]);
    await expect(
      // @ts-expect-error — intentionally invalid input
      h.client.banks.resolveAccount({ account_number: "0690000040" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});
