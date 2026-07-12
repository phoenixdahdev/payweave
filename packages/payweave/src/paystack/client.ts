/**
 * PaystackClient — Surface A shell (TDD §7/§9). Holds the shared
 * {@link HttpClient} every Paystack resource is built on. Resource classes land
 * in Wave 3; each takes the same `HttpClient` in its constructor.
 */
import type { HttpClient } from "../core/http";

export class PaystackClient {
  /**
   * Shared HTTP client. Wave-3 resource classes receive THIS instance:
   * `new Transactions(this.http)`.
   */
  readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;

    // ── resources wired here in Wave 3 ─────────────────────────────────────
    // Pattern (TDD §9): each resource is a class taking the HttpClient, assigned
    // to a public readonly field so it appears on the typed Surface A, e.g.
    //   this.transactions = new Transactions(this.http);
    //   this.refunds      = new Refunds(this.http);
    //   this.customers    = new Customers(this.http);
    // Export each resource class from `src/paystack/index.ts`.
  }
}
