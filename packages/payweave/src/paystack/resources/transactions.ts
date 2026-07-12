/**
 * Paystack Transactions resource (Surface A). Every method validates its input
 * with a request schema (throws {@link PayweaveValidationError} before the
 * network call) and passes a loose response schema to the HttpClient (drift is
 * logged, never thrown). Amounts are KOBO minor units, passed through unchanged.
 *
 * Docs: https://paystack.com/docs/api/transaction/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  chargeAuthorizationReq,
  initializeData,
  initializeReq,
  listQuery,
  partialDebitReq,
  totalsQuery,
  transaction,
  type ChargeAuthorizationReq,
  type InitializeReq,
  type ListQuery,
  type PartialDebitReq,
  type TotalsQuery,
} from "../schemas/transactions";

const initializeRes = paystackEnvelope(initializeData);
const transactionRes = paystackEnvelope(transaction);
const transactionListRes = paystackListEnvelope(transaction);

/** Validate a non-empty reference string, throwing PayweaveValidationError. */
function refString(value: string): string {
  return parseRequest(z.string().min(1), value);
}
/** A permissive loose-object schema for endpoints whose data shape we don't pin. */
function looseData() {
  return z.looseObject({});
}

export class Transactions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Initialize a transaction and get a hosted checkout URL. `amount` is in KOBO
   * (minor units) and is sent to Paystack unchanged.
   *
   * Docs: https://paystack.com/docs/api/transaction/#initialize
   *
   * @example
   * const res = await ps.paystack.transactions.initialize({
   *   email: "buyer@example.com",
   *   amount: 500000, // ₦5,000 in kobo
   * });
   * console.log(res.data.authorization_url);
   */
  async initialize(input: InitializeReq) {
    const body = parseRequest(initializeReq, input);
    return this.http.request({
      method: "POST",
      path: "/transaction/initialize",
      body,
      schema: initializeRes,
    });
  }

  /**
   * Verify a transaction by its `reference` (Paystack verifies by reference, not
   * numeric id). A 404 for an unknown reference surfaces as
   * {@link PayweaveNotFoundError}.
   *
   * Docs: https://paystack.com/docs/api/transaction/#verify
   *
   * @example
   * const res = await ps.paystack.transactions.verify("pwv_ref_001");
   * if (res.data.status === "success") { }
   */
  async verify(reference: string) {
    const ref = refString(reference);
    return this.http.request({
      method: "GET",
      path: `/transaction/verify/${encodeURIComponent(ref)}`,
      schema: transactionRes,
    });
  }

  /**
   * List transactions on the integration.
   *
   * Docs: https://paystack.com/docs/api/transaction/#list
   *
   * @example
   * const page = await ps.paystack.transactions.list({ perPage: 50, status: "success" });
   */
  async list(query: ListQuery = {}) {
    const q = parseRequest(listQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transaction",
      query: q,
      schema: transactionListRes,
    });
  }

  /**
   * Async iterator over ALL transactions matching `query`, transparently walking
   * every page (`meta.pageCount`).
   *
   * Docs: https://paystack.com/docs/api/transaction/#list
   *
   * @example
   * for await (const tx of ps.paystack.transactions.iterate({ status: "success" })) {
   *   console.log(tx.id);
   * }
   */
  async *iterate(query: ListQuery = {}) {
    const base = parseRequest(listQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/transaction",
        query: { ...base, perPage, page },
        schema: transactionListRes,
      });
      for (const tx of res.data) yield tx;
      const pageCount = metaNumber(res.meta?.pageCount);
      if (pageCount !== undefined) {
        if (page >= pageCount) return;
      } else if (res.data.length < perPage) {
        return;
      }
      page += 1;
    }
  }

  /**
   * Fetch a single transaction by its numeric Paystack id.
   *
   * Docs: https://paystack.com/docs/api/transaction/#fetch
   *
   * @example
   * const res = await ps.paystack.transactions.fetch(123456789);
   */
  async fetch(id: number | string) {
    return this.http.request({
      method: "GET",
      path: `/transaction/${encodeURIComponent(String(id))}`,
      schema: transactionRes,
    });
  }

  /**
   * Charge a previously-authorized card using its reusable `authorization_code`.
   * `amount` is KOBO minor units, passed through unchanged.
   *
   * Docs: https://paystack.com/docs/api/transaction/#charge-authorization
   *
   * @example
   * const res = await ps.paystack.transactions.chargeAuthorization({
   *   email: "buyer@example.com",
   *   amount: 500000,
   *   authorization_code: "AUTH_example",
   * });
   */
  async chargeAuthorization(input: ChargeAuthorizationReq) {
    const body = parseRequest(chargeAuthorizationReq, input);
    return this.http.request({
      method: "POST",
      path: "/transaction/charge_authorization",
      body,
      schema: transactionRes,
    });
  }

  /**
   * Retrieve the timeline (event log) of a transaction by id or reference.
   *
   * Docs: https://paystack.com/docs/api/transaction/#view-timeline
   *
   * @example
   * const res = await ps.paystack.transactions.timeline("pwv_ref_001");
   */
  async timeline(idOrReference: number | string) {
    return this.http.request({
      method: "GET",
      path: `/transaction/timeline/${encodeURIComponent(String(idOrReference))}`,
      schema: paystackEnvelope(looseData()),
    });
  }

  /**
   * Total amount received on the integration over an optional date window.
   *
   * Docs: https://paystack.com/docs/api/transaction/#totals
   *
   * @example
   * const res = await ps.paystack.transactions.totals({ from: "2024-01-01" });
   */
  async totals(query: TotalsQuery = {}) {
    const q = parseRequest(totalsQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transaction/totals",
      query: q,
      schema: paystackEnvelope(looseData()),
    });
  }

  /**
   * Deduct a partial amount from a customer's authorization. `amount` is KOBO.
   *
   * Docs: https://paystack.com/docs/api/transaction/#partial-debit
   *
   * @example
   * const res = await ps.paystack.transactions.partialDebit({
   *   authorization_code: "AUTH_example",
   *   currency: "NGN",
   *   amount: 200000,
   *   email: "buyer@example.com",
   * });
   */
  async partialDebit(input: PartialDebitReq) {
    const body = parseRequest(partialDebitReq, input);
    return this.http.request({
      method: "POST",
      path: "/transaction/partial_debit",
      body,
      schema: transactionRes,
    });
  }
}
