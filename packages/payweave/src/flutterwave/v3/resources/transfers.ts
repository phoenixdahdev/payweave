/**
 * Flutterwave v3 Transfers resource (Surface A): create, list/iterate, fetch,
 * and fee lookup. Amounts are MAJOR units, passed through unchanged.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/create-a-transfer
 */
import type { HttpClient } from "../../../core/http";
import { parseRequest, flwEnvelope, flwListEnvelope, metaNumber } from "../shared";
import {
  createTransferReq,
  listTransfersQuery,
  transfer,
  transferFee,
  transferFeeQuery,
  type CreateTransferReq,
  type ListTransfersQuery,
  type TransferFeeQuery,
} from "../schemas/transfers";

const transferRes = flwEnvelope(transfer);
const transferListRes = flwListEnvelope(transfer);
const transferFeeRes = flwEnvelope(transferFee.array());

export class Transfers {
  constructor(private readonly http: HttpClient) {}

  /**
   * Initiate a transfer (payout) to a bank account. `amount` is MAJOR units,
   * passed through unchanged.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/create-a-transfer
   *
   * @example
   * const res = await fw.flutterwave.transfers.create({
   *   account_bank: "044", account_number: "0690000040",
   *   amount: 5000, currency: "NGN", narration: "Payout",
   * });
   */
  async create(input: CreateTransferReq) {
    const body = parseRequest(createTransferReq, input);
    return this.http.request({
      method: "POST",
      path: "/transfers",
      body,
      schema: transferRes,
    });
  }

  /**
   * List transfers on the account.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/list-all-transfers
   *
   * @example
   * const page = await fw.flutterwave.transfers.list({ status: "SUCCESSFUL" });
   */
  async list(query: ListTransfersQuery = {}) {
    const q = parseRequest(listTransfersQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transfers",
      query: q,
      schema: transferListRes,
    });
  }

  /**
   * Async iterator over ALL transfers matching `query`, walking every page via
   * `meta.page_info.total_pages`.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/list-all-transfers
   *
   * @example
   * for await (const t of fw.flutterwave.transfers.iterate()) console.log(t.id);
   */
  async *iterate(query: ListTransfersQuery = {}) {
    const base = parseRequest(listTransfersQuery, query);
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/transfers",
        query: { ...base, page },
        schema: transferListRes,
      });
      for (const t of res.data) yield t;
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
   * Fetch a single transfer by its id.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-a-transfer
   *
   * @example
   * const res = await fw.flutterwave.transfers.fetch(27494);
   */
  async fetch(id: number | string) {
    return this.http.request({
      method: "GET",
      path: `/transfers/${encodeURIComponent(String(id))}`,
      schema: transferRes,
    });
  }

  /**
   * Get the fee Flutterwave charges for a transfer of `amount` MAJOR units.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-transfer-fee
   *
   * @example
   * const res = await fw.flutterwave.transfers.fees({ amount: 5000, currency: "NGN" });
   */
  async fees(query: TransferFeeQuery) {
    const q = parseRequest(transferFeeQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transfers/fee",
      query: q,
      schema: transferFeeRes,
    });
  }
}
