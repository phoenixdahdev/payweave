/**
 * FlutterwaveClient — Surface A. Holds the shared {@link HttpClient} and the
 * active `version`, and mounts the version-isolated resource surface (TDD §11:
 * v3 and v4 schemas are NEVER shared). Wave 3 mounts the **v3** resources; v4 is
 * a later wave. The provider-narrowing facade wires `sdk.flutterwave` from these
 * public fields.
 */
import type { HttpClient } from "../core/http";
import { Payments } from "./v3/resources/payments";
import { Transactions } from "./v3/resources/transactions";
import { Banks } from "./v3/resources/banks";
import { Refunds } from "./v3/resources/refunds";
import { Charges } from "./v3/resources/charges";
import { Transfers } from "./v3/resources/transfers";
import { Beneficiaries } from "./v3/resources/beneficiaries";

export class FlutterwaveClient {
  /**
   * Shared HTTP client. Resource classes receive THIS instance:
   * `new Payments(this.http)`.
   */
  readonly http: HttpClient;

  /** Configured API generation — decides which resource surface is mounted. */
  readonly version: "v3" | "v4";

  // ── v3 resources (mounted when version === "v3") ─────────────────────────────
  /** Standard Payments: hosted checkout link (`data.link`). */
  readonly payments!: Payments;
  /** Transactions: verify by id / by tx_ref, list/iterate, fees. */
  readonly transactions!: Transactions;
  /** Banks + account resolution: list banks by country, branches, resolve. */
  readonly banks!: Banks;
  /** Refunds: create, list/iterate, fetch. */
  readonly refunds!: Refunds;
  /** Direct charges: card (3DES), bank transfer, USSD, NG account, validate. */
  readonly charges!: Charges;
  /** Transfers: create, list/iterate, fetch, fees. */
  readonly transfers!: Transfers;
  /** Transfer beneficiaries: create, list/iterate, fetch. */
  readonly beneficiaries!: Beneficiaries;

  /**
   * @param http - Shared HTTP client every resource is built on.
   * @param version - `"v3"` mounts the v3 surface; `"v4"` is a later wave.
   * @param encryptionKey - The v3 dashboard Encryption Key (from resolved
   *   config), consumed by `charges.card`. Optional so the facade can construct
   *   the client without it; card charges then require a per-call override.
   */
  constructor(http: HttpClient, version: "v3" | "v4", encryptionKey?: string) {
    this.http = http;
    this.version = version;

    // ── resources wired here in Wave 3 ─────────────────────────────────────
    // Version-isolated (TDD §11): mount v3 resources when version === "v3";
    // v4 resources land in a later wave (branch intentionally left empty).
    if (version === "v3") {
      this.payments = new Payments(this.http);
      this.transactions = new Transactions(this.http);
      this.banks = new Banks(this.http);
      this.refunds = new Refunds(this.http);
      this.charges = new Charges(this.http, encryptionKey);
      this.transfers = new Transfers(this.http);
      this.beneficiaries = new Beneficiaries(this.http);
    }
  }
}
