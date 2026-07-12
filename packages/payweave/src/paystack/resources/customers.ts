/**
 * Paystack Customers resource. Docs: https://paystack.com/docs/api/customer/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  createCustomerReq,
  customer,
  listCustomersQuery,
  setRiskActionReq,
  updateCustomerReq,
  validateCustomerReq,
  type CreateCustomerReq,
  type ListCustomersQuery,
  type SetRiskActionReq,
  type UpdateCustomerReq,
  type ValidateCustomerReq,
} from "../schemas/customers";

const customerRes = paystackEnvelope(customer);
const customerListRes = paystackListEnvelope(customer);
// NOTE(verify): validate/deactivate acknowledge asynchronously; Paystack returns
// `{status,message}` with no stable `data` payload. Modelled as an ack envelope
// with `data: unknown` (loose) so any future data field passes through.
const ackRes = paystackEnvelope(z.unknown());

export class Customers {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a customer.
   *
   * Docs: https://paystack.com/docs/api/customer/#create
   *
   * @example
   * const res = await ps.paystack.customers.create({ email: "buyer@example.com" });
   */
  async create(input: CreateCustomerReq) {
    const body = parseRequest(createCustomerReq, input);
    return this.http.request({
      method: "POST",
      path: "/customer",
      body,
      schema: customerRes,
    });
  }

  /**
   * List customers.
   *
   * Docs: https://paystack.com/docs/api/customer/#list
   *
   * @example
   * const page = await ps.paystack.customers.list({ perPage: 50 });
   */
  async list(query: ListCustomersQuery = {}) {
    const q = parseRequest(listCustomersQuery, query);
    return this.http.request({
      method: "GET",
      path: "/customer",
      query: q,
      schema: customerListRes,
    });
  }

  /**
   * Async iterator over ALL customers.
   *
   * Docs: https://paystack.com/docs/api/customer/#list
   *
   * @example
   * for await (const c of ps.paystack.customers.iterate()) console.log(c.customer_code);
   */
  async *iterate(query: ListCustomersQuery = {}) {
    const base = parseRequest(listCustomersQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/customer",
        query: { ...base, perPage, page },
        schema: customerListRes,
      });
      for (const c of res.data) yield c;
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
   * Fetch a customer by email or customer code.
   *
   * Docs: https://paystack.com/docs/api/customer/#fetch
   *
   * @example
   * const res = await ps.paystack.customers.fetch("CUS_example");
   */
  async fetch(emailOrCode: string) {
    const key = parseRequest(z.string().min(1), emailOrCode);
    return this.http.request({
      method: "GET",
      path: `/customer/${encodeURIComponent(key)}`,
      schema: customerRes,
    });
  }

  /**
   * Update a customer by customer code.
   *
   * Docs: https://paystack.com/docs/api/customer/#update
   *
   * @example
   * const res = await ps.paystack.customers.update("CUS_example", { first_name: "Ada" });
   */
  async update(code: string, input: UpdateCustomerReq) {
    const key = parseRequest(z.string().min(1), code);
    const body = parseRequest(updateCustomerReq, input);
    return this.http.request({
      method: "PUT",
      path: `/customer/${encodeURIComponent(key)}`,
      body,
      schema: customerRes,
    });
  }

  /**
   * Validate a customer's identity (e.g. bank account). Paystack processes this
   * asynchronously and returns an acknowledgement envelope.
   *
   * Docs: https://paystack.com/docs/api/customer/#validate
   *
   * @example
   * await ps.paystack.customers.validate("CUS_example", {
   *   country: "NG", type: "bank_account",
   *   account_number: "0000000000", bank_code: "011",
   *   first_name: "Ada", last_name: "Lovelace",
   * });
   */
  async validate(code: string, input: ValidateCustomerReq) {
    const key = parseRequest(z.string().min(1), code);
    const body = parseRequest(validateCustomerReq, input);
    return this.http.request({
      method: "POST",
      path: `/customer/${encodeURIComponent(key)}/identification`,
      body,
      schema: ackRes,
    });
  }

  /**
   * Whitelist or blacklist a customer (set risk action).
   *
   * Docs: https://paystack.com/docs/api/customer/#whitelist-blacklist
   *
   * @example
   * await ps.paystack.customers.setRiskAction({ customer: "CUS_example", risk_action: "allow" });
   */
  async setRiskAction(input: SetRiskActionReq) {
    const body = parseRequest(setRiskActionReq, input);
    return this.http.request({
      method: "POST",
      path: "/customer/set_risk_action",
      body,
      schema: customerRes,
    });
  }

  /**
   * Deactivate a reusable authorization on a customer.
   *
   * Docs: https://paystack.com/docs/api/customer/#deactivate-authorization
   *
   * @example
   * await ps.paystack.customers.deactivateAuthorization("AUTH_example");
   */
  async deactivateAuthorization(authorizationCode: string) {
    const code = parseRequest(z.string().min(1), authorizationCode);
    return this.http.request({
      method: "POST",
      path: "/customer/deactivate_authorization",
      body: { authorization_code: code },
      schema: ackRes,
    });
  }
}
