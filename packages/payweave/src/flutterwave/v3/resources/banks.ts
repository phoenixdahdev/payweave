/**
 * Flutterwave v3 Banks + account-resolution resource (Surface A). Feeds the
 * unified banks layer later.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-all-banks
 */
import { z } from "zod";
import type { HttpClient } from "../../../core/http";
import { parseRequest, flwEnvelope } from "../shared";
import {
  bank,
  bankBranch,
  resolveAccountReq,
  resolvedAccount,
  type ResolveAccountReq,
} from "../schemas/banks";

const bankListRes = flwEnvelope(z.array(bank));
const branchListRes = flwEnvelope(z.array(bankBranch));
const resolveRes = flwEnvelope(resolvedAccount);

export class Banks {
  constructor(private readonly http: HttpClient) {}

  /**
   * List the banks Flutterwave supports for a country (ISO-2 code, e.g. "NG").
   * `data` is a flat array (no pagination on this endpoint).
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-all-banks
   *
   * @example
   * const res = await fw.flutterwave.banks.list("NG");
   * console.log(res.data[0].code);
   */
  async list(country: string) {
    const value = parseRequest(z.string().min(1), country);
    return this.http.request({
      method: "GET",
      path: `/banks/${encodeURIComponent(value)}`,
      schema: bankListRes,
    });
  }

  /**
   * List branches for a bank by its Flutterwave bank id.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/get-bank-branches
   *
   * @example
   * const res = await fw.flutterwave.banks.branches(280);
   */
  async branches(bankId: number | string) {
    return this.http.request({
      method: "GET",
      path: `/banks/${encodeURIComponent(String(bankId))}/branches`,
      schema: branchListRes,
    });
  }

  /**
   * Resolve a bank account number to its account holder name.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/resolve-account-details
   *
   * @example
   * const res = await fw.flutterwave.banks.resolveAccount({
   *   account_number: "0690000040",
   *   account_bank: "044",
   * });
   * console.log(res.data.account_name);
   */
  async resolveAccount(input: ResolveAccountReq) {
    const body = parseRequest(resolveAccountReq, input);
    return this.http.request({
      method: "POST",
      path: "/accounts/resolve",
      body,
      schema: resolveRes,
    });
  }
}
