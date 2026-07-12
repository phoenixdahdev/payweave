/**
 * Paystack Refunds resource. Docs: https://paystack.com/docs/api/refund/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  createRefundReq,
  listRefundsQuery,
  refund,
  type CreateRefundReq,
  type ListRefundsQuery,
} from "../schemas/refunds";

const refundRes = paystackEnvelope(refund);
const refundListRes = paystackListEnvelope(refund);

export class Refunds {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a refund for a transaction. `amount` is KOBO minor units; omit to
   * refund in full.
   *
   * Docs: https://paystack.com/docs/api/refund/#create
   *
   * @example
   * const res = await ps.paystack.refunds.create({ transaction: "pwv_ref_001", amount: 100000 });
   */
  async create(input: CreateRefundReq) {
    const body = parseRequest(createRefundReq, input);
    return this.http.request({
      method: "POST",
      path: "/refund",
      body,
      schema: refundRes,
    });
  }

  /**
   * List refunds.
   *
   * Docs: https://paystack.com/docs/api/refund/#list
   *
   * @example
   * const page = await ps.paystack.refunds.list({ perPage: 50 });
   */
  async list(query: ListRefundsQuery = {}) {
    const q = parseRequest(listRefundsQuery, query);
    return this.http.request({
      method: "GET",
      path: "/refund",
      query: q,
      schema: refundListRes,
    });
  }

  /**
   * Async iterator over ALL refunds matching `query`.
   *
   * Docs: https://paystack.com/docs/api/refund/#list
   *
   * @example
   * for await (const r of ps.paystack.refunds.iterate()) console.log(r.id);
   */
  async *iterate(query: ListRefundsQuery = {}) {
    const base = parseRequest(listRefundsQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/refund",
        query: { ...base, perPage, page },
        schema: refundListRes,
      });
      for (const r of res.data) yield r;
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
   * Fetch a single refund by id.
   *
   * Docs: https://paystack.com/docs/api/refund/#fetch
   *
   * @example
   * const res = await ps.paystack.refunds.fetch(1234);
   */
  async fetch(id: number | string) {
    z.string().min(1).parse(String(id));
    return this.http.request({
      method: "GET",
      path: `/refund/${encodeURIComponent(String(id))}`,
      schema: refundRes,
    });
  }
}
