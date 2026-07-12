/**
 * FlutterwaveClient — Surface A shell (TDD §7/§9, §11 version isolation). Holds
 * the shared {@link HttpClient} and the active `version` so Wave 3 can mount the
 * v3 or v4 resource surface (kept separate — never shared). Resource classes
 * land in Wave 3; each takes the same `HttpClient`.
 */
import type { HttpClient } from "../core/http";

export class FlutterwaveClient {
  /**
   * Shared HTTP client. Wave-3 resource classes receive THIS instance:
   * `new Payments(this.http)`.
   */
  readonly http: HttpClient;

  /** Configured API generation — decides which resource surface is mounted. */
  readonly version: "v3" | "v4";

  constructor(http: HttpClient, version: "v3" | "v4") {
    this.http = http;
    this.version = version;

    // ── resources wired here in Wave 3 ─────────────────────────────────────
    // Version-isolated (TDD §11): mount v3 resources when version === "v3" and
    // v4 resources when "v4"; never share schemas across versions. Pattern:
    //   if (version === "v3") this.payments = new PaymentsV3(this.http);
    //   else                  this.charges  = new ChargesV4(this.http);
    // Export each resource class from `src/flutterwave/index.ts`.
  }
}
