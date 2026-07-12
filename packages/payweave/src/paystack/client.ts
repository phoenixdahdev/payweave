/**
 * PaystackClient — Surface A. Holds the shared {@link HttpClient} every Paystack
 * resource is built on and exposes each resource as a `public readonly` field.
 * The provider-narrowing facade wires `sdk.paystack` from these fields.
 */
import type { HttpClient } from "../core/http";
import { Transactions } from "./resources/transactions";
import { Refunds } from "./resources/refunds";
import { Customers } from "./resources/customers";
import { Misc } from "./resources/misc";
import { TransferRecipients } from "./resources/transfer-recipients";
import { Transfers } from "./resources/transfers";
import { Plans } from "./resources/plans";
import { Subscriptions } from "./resources/subscriptions";

export class PaystackClient {
  /** Shared HTTP client every resource is constructed with. */
  readonly http: HttpClient;

  /** Transactions: initialize, verify, list/iterate, fetch, charge auth, etc. */
  readonly transactions: Transactions;
  /** Refunds: create, list, fetch. */
  readonly refunds: Refunds;
  /** Customers: create, list, fetch, update, validate, risk action. */
  readonly customers: Customers;
  /** Verification / misc: banks, resolve account, countries, states, card BIN. */
  readonly misc: Misc;
  /** Transfer recipients: create, list, fetch. */
  readonly transferRecipients: TransferRecipients;
  /** Transfers: initiate, list, fetch, verify, balance. */
  readonly transfers: Transfers;
  /** Plans: create, list, fetch. */
  readonly plans: Plans;
  /** Subscriptions: create, list, fetch, enable, disable. */
  readonly subscriptions: Subscriptions;

  constructor(http: HttpClient) {
    this.http = http;
    this.transactions = new Transactions(this.http);
    this.refunds = new Refunds(this.http);
    this.customers = new Customers(this.http);
    this.misc = new Misc(this.http);
    this.transferRecipients = new TransferRecipients(this.http);
    this.transfers = new Transfers(this.http);
    this.plans = new Plans(this.http);
    this.subscriptions = new Subscriptions(this.http);
  }
}
