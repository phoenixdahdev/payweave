/**
 * Paystack Plans resource. Docs: https://paystack.com/docs/api/plan/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  createPlanReq,
  listPlansQuery,
  plan,
  type CreatePlanReq,
  type ListPlansQuery,
} from "../schemas/plans";

const planRes = paystackEnvelope(plan);
const planListRes = paystackListEnvelope(plan);

export class Plans {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a plan. `amount` is KOBO minor units.
   *
   * Docs: https://paystack.com/docs/api/plan/#create
   *
   * @example
   * const res = await ps.paystack.plans.create({
   *   name: "Monthly", amount: 500000, interval: "monthly",
   * });
   */
  async create(input: CreatePlanReq) {
    const body = parseRequest(createPlanReq, input);
    return this.http.request({
      method: "POST",
      path: "/plan",
      body,
      schema: planRes,
    });
  }

  /**
   * List plans.
   *
   * Docs: https://paystack.com/docs/api/plan/#list
   *
   * @example
   * const page = await ps.paystack.plans.list({ perPage: 50 });
   */
  async list(query: ListPlansQuery = {}) {
    const q = parseRequest(listPlansQuery, query);
    return this.http.request({
      method: "GET",
      path: "/plan",
      query: q,
      schema: planListRes,
    });
  }

  /**
   * Async iterator over ALL plans.
   *
   * Docs: https://paystack.com/docs/api/plan/#list
   *
   * @example
   * for await (const p of ps.paystack.plans.iterate()) console.log(p.plan_code);
   */
  async *iterate(query: ListPlansQuery = {}) {
    const base = parseRequest(listPlansQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/plan",
        query: { ...base, perPage, page },
        schema: planListRes,
      });
      for (const p of res.data) yield p;
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
   * Fetch a plan by id or plan code.
   *
   * Docs: https://paystack.com/docs/api/plan/#fetch
   *
   * @example
   * const res = await ps.paystack.plans.fetch("PLN_example");
   */
  async fetch(idOrCode: string | number) {
    const key = z.string().min(1).parse(String(idOrCode));
    return this.http.request({
      method: "GET",
      path: `/plan/${encodeURIComponent(key)}`,
      schema: planRes,
    });
  }
}
