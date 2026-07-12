/**
 * Paystack Subscriptions resource.
 * Docs: https://paystack.com/docs/api/subscription/
 */
import { z } from "zod";
import type { HttpClient } from "../../core/http";
import { parseRequest, metaNumber, paystackEnvelope, paystackListEnvelope } from "../types";
import {
  createSubscriptionReq,
  listSubscriptionsQuery,
  subscription,
  toggleSubscriptionReq,
  type CreateSubscriptionReq,
  type ListSubscriptionsQuery,
  type ToggleSubscriptionReq,
} from "../schemas/plans";

const subscriptionRes = paystackEnvelope(subscription);
const subscriptionListRes = paystackListEnvelope(subscription);
const ackRes = paystackEnvelope(z.unknown());

export class Subscriptions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a subscription binding a customer to a plan.
   *
   * Docs: https://paystack.com/docs/api/subscription/#create
   *
   * @example
   * const res = await ps.paystack.subscriptions.create({
   *   customer: "CUS_example", plan: "PLN_example",
   * });
   */
  async create(input: CreateSubscriptionReq) {
    const body = parseRequest(createSubscriptionReq, input);
    return this.http.request({
      method: "POST",
      path: "/subscription",
      body,
      schema: subscriptionRes,
    });
  }

  /**
   * List subscriptions.
   *
   * Docs: https://paystack.com/docs/api/subscription/#list
   *
   * @example
   * const page = await ps.paystack.subscriptions.list({ perPage: 50 });
   */
  async list(query: ListSubscriptionsQuery = {}) {
    const q = parseRequest(listSubscriptionsQuery, query);
    return this.http.request({
      method: "GET",
      path: "/subscription",
      query: q,
      schema: subscriptionListRes,
    });
  }

  /**
   * Async iterator over ALL subscriptions.
   *
   * Docs: https://paystack.com/docs/api/subscription/#list
   *
   * @example
   * for await (const s of ps.paystack.subscriptions.iterate()) console.log(s.subscription_code);
   */
  async *iterate(query: ListSubscriptionsQuery = {}) {
    const base = parseRequest(listSubscriptionsQuery, query);
    const perPage = base.perPage ?? 50;
    let page = base.page ?? 1;
    for (;;) {
      const res = await this.http.request({
        method: "GET",
        path: "/subscription",
        query: { ...base, perPage, page },
        schema: subscriptionListRes,
      });
      for (const s of res.data) yield s;
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
   * Fetch a subscription by id or subscription code.
   *
   * Docs: https://paystack.com/docs/api/subscription/#fetch
   *
   * @example
   * const res = await ps.paystack.subscriptions.fetch("SUB_example");
   */
  async fetch(idOrCode: string | number) {
    const key = z.string().min(1).parse(String(idOrCode));
    return this.http.request({
      method: "GET",
      path: `/subscription/${encodeURIComponent(key)}`,
      schema: subscriptionRes,
    });
  }

  /**
   * Enable a subscription (`code` + email `token`).
   *
   * Docs: https://paystack.com/docs/api/subscription/#enable
   *
   * @example
   * await ps.paystack.subscriptions.enable({ code: "SUB_example", token: "email_token" });
   */
  async enable(input: ToggleSubscriptionReq) {
    const body = parseRequest(toggleSubscriptionReq, input);
    return this.http.request({
      method: "POST",
      path: "/subscription/enable",
      body,
      schema: ackRes,
    });
  }

  /**
   * Disable a subscription (`code` + email `token`).
   *
   * Docs: https://paystack.com/docs/api/subscription/#disable
   *
   * @example
   * await ps.paystack.subscriptions.disable({ code: "SUB_example", token: "email_token" });
   */
  async disable(input: ToggleSubscriptionReq) {
    const body = parseRequest(toggleSubscriptionReq, input);
    return this.http.request({
      method: "POST",
      path: "/subscription/disable",
      body,
      schema: ackRes,
    });
  }
}
