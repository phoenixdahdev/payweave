/**
 * Paystack Transfer Recipients resource.
 * Docs: https://paystack.com/docs/api/transfer-recipient/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  createRecipientReq,
  listRecipientsQuery,
  recipient,
  type CreateRecipientReq,
  type ListRecipientsQuery,
} from "../schemas/transfers";

const recipientRes = paystackEnvelope(recipient);
const recipientListRes = paystackListEnvelope(recipient);

export class TransferRecipients {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a transfer recipient.
   *
   * Docs: https://paystack.com/docs/api/transfer-recipient/#create
   *
   * @example
   * const res = await ps.paystack.transferRecipients.create({
   *   type: "nuban", name: "Ada Lovelace",
   *   account_number: "0000000000", bank_code: "011",
   * });
   */
  async create(input: CreateRecipientReq) {
    const body = parseRequest(createRecipientReq, input);
    return this.http.request({
      method: "POST",
      path: "/transferrecipient",
      body,
      schema: recipientRes,
    });
  }

  /**
   * List transfer recipients.
   *
   * Docs: https://paystack.com/docs/api/transfer-recipient/#list
   *
   * @example
   * const page = await ps.paystack.transferRecipients.list({ perPage: 50 });
   */
  async list(query: ListRecipientsQuery = {}) {
    const q = parseRequest(listRecipientsQuery, query);
    return this.http.request({
      method: "GET",
      path: "/transferrecipient",
      query: q,
      schema: recipientListRes,
    });
  }

  /**
   * Async iterator over ALL transfer recipients.
   *
   * Docs: https://paystack.com/docs/api/transfer-recipient/#list
   *
   * @example
   * for await (const r of ps.paystack.transferRecipients.iterate()) console.log(r.recipient_code);
   */
  async *iterate(query: ListRecipientsQuery = {}) {
    const base = parseRequest(listRecipientsQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/transferrecipient",
        query: { ...base, perPage, page },
        schema: recipientListRes,
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
   * Fetch a transfer recipient by id or recipient code.
   *
   * Docs: https://paystack.com/docs/api/transfer-recipient/#fetch
   *
   * @example
   * const res = await ps.paystack.transferRecipients.fetch("RCP_example");
   */
  async fetch(idOrCode: string | number) {
    const key = z.string().min(1).parse(String(idOrCode));
    return this.http.request({
      method: "GET",
      path: `/transferrecipient/${encodeURIComponent(key)}`,
      schema: recipientRes,
    });
  }
}
