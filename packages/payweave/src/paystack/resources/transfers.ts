/**
 * Paystack Transfers + Balance resource.
 * Docs: https://paystack.com/docs/api/transfer/
 *
 * NOTE: POST /transfer is a money-moving call. The SDK never
 * auto-retries bare POSTs, so `initiate` is not retried on network errors.
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  balanceEntry,
  initiateTransferReq,
  listTransfersQuery,
  transfer,
  type InitiateTransferReq,
  type ListTransfersQuery,
} from "../schemas/transfers";

const transferRes = paystackEnvelope(transfer);
const transferListRes = paystackListEnvelope(transfer);
const balanceRes = paystackEnvelope(z.array(balanceEntry));

export class Transfers {
  constructor(private readonly http: HttpClient) {}

  /**
   * Initiate a transfer to a recipient. `amount` is KOBO minor units.
   *
   * Docs: https://paystack.com/docs/api/transfer/#initiate
   *
   * @example
   * const res = await ps.paystack.transfers.initiate({
   *   source: "balance", amount: 500000, recipient: "RCP_example",
   * });
   */
  async initiate(input: InitiateTransferReq) {
    const body = parseRequest(initiateTransferReq, input);
    return this.http.request({
      method: "POST",
      path: "/transfer",
      body,
      schema: transferRes,
    });
  }

  /**
   * List transfers.
   *
   * Docs: https://paystack.com/docs/api/transfer/#list
   *
   * @example
   * const page = await ps.paystack.transfers.list({ perPage: 50 });
   */
  async list(query: ListTransfersQuery = {}) {
    const q = parseRequest(listTransfersQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transfer",
      query: q,
      schema: transferListRes,
    });
  }

  /**
   * Async iterator over ALL transfers.
   *
   * Docs: https://paystack.com/docs/api/transfer/#list
   *
   * @example
   * for await (const t of ps.paystack.transfers.iterate()) console.log(t.transfer_code);
   */
  async *iterate(query: ListTransfersQuery = {}) {
    const base = parseRequest(listTransfersQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/transfer",
        query: { ...base, perPage, page },
        schema: transferListRes,
      });
      for (const t of res.data) yield t;
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
   * Fetch a transfer by id or transfer code.
   *
   * Docs: https://paystack.com/docs/api/transfer/#fetch
   *
   * @example
   * const res = await ps.paystack.transfers.fetch("TRF_example");
   */
  async fetch(idOrCode: string | number) {
    const key = z.string().min(1).parse(String(idOrCode));
    return this.http.request({
      method: "GET",
      path: `/transfer/${encodeURIComponent(key)}`,
      schema: transferRes,
    });
  }

  /**
   * Verify a transfer by its reference.
   *
   * Docs: https://paystack.com/docs/api/transfer/#verify
   *
   * @example
   * const res = await ps.paystack.transfers.verify("pwv_transfer_ref");
   */
  async verify(reference: string) {
    const ref = parseRequest(z.string().min(1), reference);
    return this.http.request({
      method: "GET",
      path: `/transfer/verify/${encodeURIComponent(ref)}`,
      schema: transferRes,
    });
  }

  /**
   * Fetch the balance(s) available on the integration.
   *
   * Docs: https://paystack.com/docs/api/transfer/#balance
   *
   * @example
   * const res = await ps.paystack.transfers.balance();
   * console.log(res.data[0]?.balance);
   */
  async balance() {
    return this.http.request({
      method: "GET",
      path: "/balance",
      schema: balanceRes,
    });
  }
}
