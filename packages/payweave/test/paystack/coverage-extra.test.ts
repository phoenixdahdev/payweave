import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { loadFixture } from "../../src/testing/fixtures";
import { makePaystack, type PaystackHarness } from "./_harness";

let h: PaystackHarness;
afterEach(() => h?.close());

describe("transactions.iterate — multi-page walk", () => {
  it("follows meta.pageCount across pages and yields every item", async () => {
    h = await makePaystack([]);
    // Dynamic handler: page 1 and page 2 of a 2-page result set.
    h.server.use(
      http.get("https://api.paystack.co/transaction", ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        const body =
          page === "2"
            ? {
                status: true,
                message: "ok",
                data: [{ id: 3 }, { id: 4 }],
                meta: { total: 4, perPage: 2, page: 2, pageCount: 2 },
              }
            : {
                status: true,
                message: "ok",
                data: [{ id: 1 }, { id: 2 }],
                meta: { total: 4, perPage: 2, page: 1, pageCount: 2 },
              };
        return HttpResponse.json(body);
      }),
    );

    const ids: number[] = [];
    for await (const tx of h.client.transactions.iterate({ perPage: 2 })) ids.push(tx.id);
    expect(ids).toEqual([1, 2, 3, 4]);

    const reqs = await h.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.search.get("page")).toBe("1");
    expect(reqs[1]!.search.get("page")).toBe("2");
  });

  it("stops when a short page (< perPage) arrives and there is no pageCount", async () => {
    h = await makePaystack([]);
    h.server.use(
      http.get("https://api.paystack.co/transaction", () =>
        HttpResponse.json({ status: true, message: "ok", data: [{ id: 1 }] }),
      ),
    );
    const ids: number[] = [];
    for await (const tx of h.client.transactions.iterate({ perPage: 50 })) ids.push(tx.id);
    expect(ids).toEqual([1]);
    expect(await h.requests()).toHaveLength(1);
  });
});

describe("transactions — remaining methods", () => {
  it("timeline GETs /transaction/timeline/:id", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/timeline/:id",
        json: { status: true, message: "ok", data: { time_spent: 42 } },
      },
    ]);
    const res = await h.client.transactions.timeline("pwv_ref");
    expect((await h.lastRequest()).path).toBe("/transaction/timeline/pwv_ref");
    expect(res.status).toBe(true);
  });

  it("totals GETs /transaction/totals with date window", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transaction/totals",
        json: { status: true, message: "ok", data: { total_transactions: 10 } },
      },
    ]);
    await h.client.transactions.totals({ from: "2024-01-01" });
    const req = await h.lastRequest();
    expect(req.path).toBe("/transaction/totals");
    expect(req.search.get("from")).toBe("2024-01-01");
  });

  it("partialDebit POSTs /transaction/partial_debit with amount in kobo", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/transaction/partial_debit",
        json: loadFixture("paystack", "transactions", "charge_authorization.success"),
      },
    ]);
    await h.client.transactions.partialDebit({
      authorization_code: "AUTH_example",
      currency: "NGN",
      amount: 200000,
      email: "buyer@example.com",
    });
    const req = await h.lastRequest();
    expect(req.path).toBe("/transaction/partial_debit");
    expect(req.body).toMatchObject({ amount: 200000, currency: "NGN" });
  });
});

describe("fetch-by-id/code methods", () => {
  it("transferRecipients.fetch GETs /transferrecipient/:code", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transferrecipient/:code",
        json: loadFixture("paystack", "transfer-recipients", "create.success"),
      },
    ]);
    const res = await h.client.transferRecipients.fetch("RCP_example");
    expect((await h.lastRequest()).path).toBe("/transferrecipient/RCP_example");
    expect(res.data.recipient_code).toBe("RCP_example");
  });

  it("transfers.fetch GETs /transfer/:code", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transfer/:code",
        json: loadFixture("paystack", "transfers", "verify.success"),
      },
    ]);
    await h.client.transfers.fetch("TRF_example");
    expect((await h.lastRequest()).path).toBe("/transfer/TRF_example");
  });

  it("plans.fetch GETs /plan/:code", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/plan/:code",
        json: loadFixture("paystack", "plans", "create.success"),
      },
    ]);
    const res = await h.client.plans.fetch("PLN_example");
    expect((await h.lastRequest()).path).toBe("/plan/PLN_example");
    expect(res.data.plan_code).toBe("PLN_example");
  });

  it("subscriptions.fetch GETs /subscription/:code", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/subscription/:code",
        json: loadFixture("paystack", "subscriptions", "create.success"),
      },
    ]);
    await h.client.subscriptions.fetch("SUB_example");
    expect((await h.lastRequest()).path).toBe("/subscription/SUB_example");
  });

  it("customers.deactivateAuthorization POSTs /customer/deactivate_authorization", async () => {
    h = await makePaystack([
      {
        method: "post",
        url: "https://api.paystack.co/customer/deactivate_authorization",
        json: { status: true, message: "Authorization has been deactivated" },
      },
    ]);
    await h.client.customers.deactivateAuthorization("AUTH_example");
    const req = await h.lastRequest();
    expect(req.path).toBe("/customer/deactivate_authorization");
    expect(req.body).toEqual({ authorization_code: "AUTH_example" });
  });
});

describe("iterate paginators — recipients / plans / subscriptions", () => {
  it("transferRecipients.iterate yields every recipient", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/transferrecipient",
        json: loadFixture("paystack", "transfer-recipients", "list.success"),
      },
    ]);
    const codes: (string | undefined)[] = [];
    for await (const r of h.client.transferRecipients.iterate()) codes.push(r.recipient_code);
    expect(codes).toEqual(["RCP_example1", "RCP_example2"]);
  });

  it("plans.iterate yields every plan", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/plan",
        json: loadFixture("paystack", "plans", "list.success"),
      },
    ]);
    const codes: (string | undefined)[] = [];
    for await (const p of h.client.plans.iterate()) codes.push(p.plan_code);
    expect(codes).toEqual(["PLN_example1", "PLN_example2"]);
  });

  it("subscriptions.iterate yields every subscription", async () => {
    h = await makePaystack([
      {
        method: "get",
        url: "https://api.paystack.co/subscription",
        json: loadFixture("paystack", "subscriptions", "list.success"),
      },
    ]);
    const codes: (string | undefined)[] = [];
    for await (const s of h.client.subscriptions.iterate()) codes.push(s.subscription_code);
    expect(codes).toEqual(["SUB_example1", "SUB_example2"]);
  });
});
