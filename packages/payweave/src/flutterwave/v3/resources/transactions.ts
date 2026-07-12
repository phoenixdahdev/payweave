/**
 * Flutterwave v3 Transactions resource (Surface A). Verify by numeric id vs by
 * `tx_ref` are SEPARATE endpoints (provider-reference §5.2). Amounts are MAJOR
 * units, passed through unchanged.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/verify-transaction
 */
import { z } from "zod";
import type { HttpClient } from "../../../core/http";
import { parseRequest, flwEnvelope, flwListEnvelope, metaNumber } from "../shared";
import {
  feeData,
  feesQuery,
  listQuery,
  transaction,
  type FeesQuery,
  type ListQuery,
} from "../schemas/transactions";

const transactionRes = flwEnvelope(transaction);
const transactionListRes = flwListEnvelope(transaction);
const feeRes = flwEnvelope(feeData);

export class Transactions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Verify a transaction by its numeric Flutterwave id (NOT `tx_ref` — use
   * {@link verifyByReference} for that). A 404 for an unknown id surfaces as
   * {@link PayweaveNotFoundError}.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/verify-transaction
   *
   * @example
   * const res = await fw.flutterwave.transactions.verify(288200108);
   * if (res.data.status === "successful") { }
   */
  async verify(id: number | string) {
    return this.http.request({
      method: "GET",
      path: `/transactions/${encodeURIComponent(String(id))}/verify`,
      schema: transactionRes,
    });
  }

  /**
   * Verify a transaction by your `tx_ref` (the reference you supplied at
   * checkout). This is a distinct endpoint from verify-by-id.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/verify-transaction-by-tx_ref
   *
   * @example
   * const res = await fw.flutterwave.transactions.verifyByReference("pwv_tx_001");
   */
  async verifyByReference(txRef: string) {
    const tx_ref = parseRequest(z.string().min(1), txRef);
    return this.http.request({
      method: "GET",
      path: "/transactions/verify_by_reference",
      query: { tx_ref },
      schema: transactionRes,
    });
  }

  /**
   * List transactions on the account.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/list-transactions
   *
   * @example
   * const page = await fw.flutterwave.transactions.list({ status: "successful" });
   */
  async list(query: ListQuery = {}) {
    const q = parseRequest(listQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transactions",
      query: q,
      schema: transactionListRes,
    });
  }

  /**
   * Async iterator over ALL transactions matching `query`, transparently walking
   * every page via `meta.page_info.total_pages`.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/list-transactions
   *
   * @example
   * for await (const tx of fw.flutterwave.transactions.iterate({ status: "successful" })) {
   *   console.log(tx.id);
   * }
   */
  async *iterate(query: ListQuery = {}) {
    const base = parseRequest(listQuery, query);
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/transactions",
        query: { ...base, page },
        schema: transactionListRes,
      });
      for (const tx of res.data) yield tx;
      const totalPages = metaNumber(res.meta?.page_info?.total_pages);
      if (totalPages !== undefined) {
        if (page >= totalPages) return;
      } else if (res.data.length === 0) {
        return;
      }
      page += 1;
    }
  }

  /**
   * Get the fee Flutterwave would charge for an amount. `amount` is MAJOR units.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-transaction-fees
   *
   * @example
   * const res = await fw.flutterwave.transactions.fees({ amount: 5000, currency: "NGN" });
   */
  async fees(query: FeesQuery) {
    const q = parseRequest(feesQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transactions/fee",
      query: q,
      schema: feeRes,
    });
  }
}
