import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../src/testing/fixtures";
import { PayweaveValidationError } from "../../src/core/errors";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("misc.listBanks", () => {
  it("GETs /bank with country query", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/bank",
        json: loadFixture("paystack", "misc", "banks.success"),
      },
    ]);
    const res = await h.client.misc.listBanks({ country: "nigeria" });
    const req = await h.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/bank");
    expect(req.search.get("country")).toBe("nigeria");
    expect(res.data).toHaveLength(2);
    expect(res.data[0]?.code).toBe("011");
  });
});

describe("misc.resolveAccountNumber", () => {
  it("GETs /bank/resolve with account_number + bank_code", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/bank/resolve",
        json: loadFixture("paystack", "misc", "resolve_account.success"),
      },
    ]);
    const res = await h.client.misc.resolveAccountNumber({
      account_number: "0000000000",
      bank_code: "011",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/bank/resolve");
    expect(req.search.get("account_number")).toBe("0000000000");
    expect(req.search.get("bank_code")).toBe("011");
    expect(res.data.account_name).toBe("ADA LOVELACE");
  });

  it("rejects a missing bank_code with PayweaveValidationError", async () => {
    h = await makePaystack([]);
    await expect(
      // @ts-expect-error — intentionally invalid
      h.client.misc.resolveAccountNumber({ account_number: "0000000000" }),
    ).rejects.toBeInstanceOf(PayweaveValidationError);
  });
});

describe("misc.listCountries", () => {
  it("GETs /country", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/country",
        json: loadFixture("paystack", "misc", "countries.success"),
      },
    ]);
    const res = await h.client.misc.listCountries();
    expect((await h.lastRequest()).path).toBe("/country");
    expect(res.data[0]?.iso_code).toBe("NG");
  });
});

describe("misc.listStates", () => {
  it("GETs /address_verification/states with country", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/address_verification/states",
        json: loadFixture("paystack", "misc", "states.success"),
      },
    ]);
    const res = await h.client.misc.listStates({ country: "CA" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/address_verification/states");
    expect(req.search.get("country")).toBe("CA");
    expect(res.data).toHaveLength(2);
  });
});

describe("misc.resolveCardBin", () => {
  it("GETs /decision/bin/:bin", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/decision/bin/:bin",
        json: loadFixture("paystack", "misc", "card_bin.success"),
      },
    ]);
    const res = await h.client.misc.resolveCardBin("539983");
    expect((await h.lastRequest()).path).toBe("/decision/bin/539983");
    expect(res.data.brand).toBe("mastercard");
  });
});
