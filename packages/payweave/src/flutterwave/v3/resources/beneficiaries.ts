/**
 * Flutterwave v3 Transfer Beneficiaries resource (Surface A): create,
 * list/iterate, fetch. Beneficiaries are saved payout destinations reusable via
 * `transfers.create({ beneficiary })`.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/create-a-transfer-beneficiary
 */
import type { HttpClient } from "../../../core/http";
import { parseRequest, flwEnvelope, flwListEnvelope, metaNumber } from "../shared";
import {
  beneficiary,
  createBeneficiaryReq,
  listBeneficiariesQuery,
  type CreateBeneficiaryReq,
  type ListBeneficiariesQuery,
} from "../schemas/transfers";

const beneficiaryRes = flwEnvelope(beneficiary);
const beneficiaryListRes = flwListEnvelope(beneficiary);

export class Beneficiaries {
  constructor(private readonly http: HttpClient) {}

  /**
   * Save a transfer beneficiary.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/create-a-transfer-beneficiary
   *
   * @example
   * const res = await fw.flutterwave.beneficiaries.create({
   *   account_bank: "044", account_number: "0690000040", beneficiary_name: "Jane Doe",
   * });
   */
  async create(input: CreateBeneficiaryReq) {
    const body = parseRequest(createBeneficiaryReq, input);
    return this.http.request({
      method: "POST",
      path: "/beneficiaries",
      body,
      schema: beneficiaryRes,
    });
  }

  /**
   * List saved beneficiaries.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/list-all-transfer-beneficiaries
   *
   * @example
   * const page = await fw.flutterwave.beneficiaries.list();
   */
  async list(query: ListBeneficiariesQuery = {}) {
    const q = parseRequest(listBeneficiariesQuery, query);
    return this.http.request({
      method: "GET",
      path: "/beneficiaries",
      query: q,
      schema: beneficiaryListRes,
    });
  }

  /**
   * Async iterator over ALL beneficiaries, walking every page via
   * `meta.page_info.total_pages`.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/list-all-transfer-beneficiaries
   *
   * @example
   * for await (const b of fw.flutterwave.beneficiaries.iterate()) console.log(b.id);
   */
  async *iterate(query: ListBeneficiariesQuery = {}) {
    const base = parseRequest(listBeneficiariesQuery, query);
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/beneficiaries",
        query: { ...base, page },
        schema: beneficiaryListRes,
      });
      for (const b of res.data) yield b;
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
   * Fetch a single beneficiary by its id.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/fetch-a-transfer-beneficiary
   *
   * @example
   * const res = await fw.flutterwave.beneficiaries.fetch(5307);
   */
  async fetch(id: number | string) {
    return this.http.request({
      method: "GET",
      path: `/beneficiaries/${encodeURIComponent(String(id))}`,
      schema: beneficiaryRes,
    });
  }
}
