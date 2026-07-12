/**
 * Flutterwave v3 Refunds resource (Surface A). A refund is created against a
 * transaction id (`POST /transactions/:id/refund`); listing/fetching use the
 * top-level `/refunds` collection. Amounts are MAJOR units, passed through.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/refund-a-transaction
 */
import type { HttpClient } from "../../../core/http";
import { parseRequest, flwEnvelope, flwListEnvelope, metaNumber } from "../shared";
import {
  createRefundReq,
  listRefundsQuery,
  refund,
  type CreateRefundReq,
  type ListRefundsQuery,
} from "../schemas/refunds";

const refundRes = flwEnvelope(refund);
const refundListRes = flwListEnvelope(refund);

export class Refunds {
  constructor(private readonly http: HttpClient) {}

  /**
   * Refund a transaction by its numeric id. Omit `amount` to refund in full;
   * `amount` (when given) is MAJOR units, passed through unchanged.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/refund-a-transaction
   *
   * @example
   * const res = await fw.flutterwave.refunds.create(288200108, { amount: 1000 });
   */
  async create(transactionId: number | string, input: CreateRefundReq = {}) {
    const body = parseRequest(createRefundReq, input);
    return this.http.request({
      method: "POST",
      path: `/transactions/${encodeURIComponent(String(transactionId))}/refund`,
      body,
      schema: refundRes,
    });
  }

  /**
   * List refunds on the account.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-all-refunds
   *
   * @example
   * const page = await fw.flutterwave.refunds.list({ status: "completed" });
   */
  async list(query: ListRefundsQuery = {}) {
    const q = parseRequest(listRefundsQuery, query);
    return this.http.request({
      method: "GET",
      path: "/refunds",
      query: q,
      schema: refundListRes,
    });
  }

  /**
   * Async iterator over ALL refunds matching `query`, walking every page via
   * `meta.page_info.total_pages`.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-all-refunds
   *
   * @example
   * for await (const r of fw.flutterwave.refunds.iterate()) console.log(r.id);
   */
  async *iterate(query: ListRefundsQuery = {}) {
    const base = parseRequest(listRefundsQuery, query);
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/refunds",
        query: { ...base, page },
        schema: refundListRes,
      });
      for (const r of res.data) yield r;
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
   * Fetch a single refund by its id.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-a-refund
   *
   * @example
   * const res = await fw.flutterwave.refunds.fetch(15221);
   */
  async fetch(refundId: number | string) {
    return this.http.request({
      method: "GET",
      path: `/refunds/${encodeURIComponent(String(refundId))}`,
      schema: refundRes,
    });
  }
}
