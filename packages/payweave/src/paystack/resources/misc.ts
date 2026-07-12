/**
 * Paystack Verification + Miscellaneous resource (banks, account resolution,
 * countries, states, card BIN). These feed the unified layer later.
 * Docs: https://paystack.com/docs/api/verification/ and
 *       https://paystack.com/docs/api/miscellaneous/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  avsState,
  bank,
  cardBin,
  country,
  listBanksQuery,
  listStatesQuery,
  resolveAccountQuery,
  resolvedAccount,
  type ListBanksQuery,
  type ListStatesQuery,
  type ResolveAccountQuery,
} from "../schemas/misc";

const bankListRes = paystackListEnvelope(bank);
const resolveRes = paystackEnvelope(resolvedAccount);
const countryListRes = paystackListEnvelope(country);
const stateListRes = paystackListEnvelope(avsState);
const cardBinRes = paystackEnvelope(cardBin);

export class Misc {
  constructor(private readonly http: HttpClient) {}

  /**
   * List banks (and other financial channels) for a country.
   *
   * Docs: https://paystack.com/docs/api/miscellaneous/#bank
   *
   * @example
   * const res = await ps.paystack.misc.listBanks({ country: "nigeria" });
   */
  async listBanks(query: ListBanksQuery = {}) {
    const q = parseRequest(listBanksQuery, query);
    return this.http.request({
      method: "GET",
      path: "/bank",
      query: q,
      schema: bankListRes,
    });
  }

  /**
   * Resolve an account number to an account name at a bank.
   *
   * Docs: https://paystack.com/docs/api/verification/#resolve-account
   *
   * @example
   * const res = await ps.paystack.misc.resolveAccountNumber({
   *   account_number: "0000000000", bank_code: "011",
   * });
   * console.log(res.data.account_name);
   */
  async resolveAccountNumber(query: ResolveAccountQuery) {
    const q = parseRequest(resolveAccountQuery, query);
    return this.http.request({
      method: "GET",
      path: "/bank/resolve",
      query: q,
      schema: resolveRes,
    });
  }

  /**
   * List countries Paystack currently supports.
   *
   * Docs: https://paystack.com/docs/api/miscellaneous/#country
   *
   * @example
   * const res = await ps.paystack.misc.listCountries();
   */
  async listCountries() {
    return this.http.request({
      method: "GET",
      path: "/country",
      schema: countryListRes,
    });
  }

  /**
   * List the states for a country's address verification.
   *
   * Docs: https://paystack.com/docs/api/miscellaneous/#avs-states
   *
   * @example
   * const res = await ps.paystack.misc.listStates({ country: "CA" });
   */
  async listStates(query: ListStatesQuery) {
    const q = parseRequest(listStatesQuery, query);
    return this.http.request({
      method: "GET",
      path: "/address_verification/states",
      query: q,
      schema: stateListRes,
    });
  }

  /**
   * Resolve a card BIN (first 6 digits) to its issuer/brand.
   *
   * Docs: https://paystack.com/docs/api/verification/#resolve-card-bin
   *
   * @example
   * const res = await ps.paystack.misc.resolveCardBin("539983");
   */
  async resolveCardBin(bin: string) {
    const value = parseRequest(z.string().min(1), bin);
    return this.http.request({
      method: "GET",
      path: `/decision/bin/${encodeURIComponent(value)}`,
      schema: cardBinRes,
    });
  }
}
