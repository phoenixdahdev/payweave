/**
 * Flutterwave v3 Standard Payments resource (Surface A). Validates input with a
 * request schema (throws {@link PayweaveValidationError} before the network
 * call) and passes a loose response schema to the HttpClient (drift logged,
 * never thrown). Amounts are MAJOR units (naira), passed through unchanged.
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/standard
 */
import type { HttpClient } from "../../../core/http";
import { parseRequest, flwEnvelope } from "../shared";
import {
  createPaymentReq,
  paymentInitData,
  type CreatePaymentReq,
} from "../schemas/payments";

const paymentInitRes = flwEnvelope(paymentInitData);

export class Payments {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a Standard payment and get a hosted checkout link. `amount` is in
   * MAJOR units (e.g. `5000` = ₦5,000) and is sent to Flutterwave unchanged
   * (Surface A). The checkout URL is returned at `data.link`.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/standard
   *
   * @example
   * const res = await fw.flutterwave.payments.create({
   *   tx_ref: "pwv_tx_001",
   *   amount: 5000, // ₦5,000 in major units
   *   currency: "NGN",
   *   redirect_url: "https://example.com/callback",
   *   customer: { email: "buyer@example.com" },
   * });
   * console.log(res.data.link);
   */
  async create(input: CreatePaymentReq) {
    const body = parseRequest(createPaymentReq, input);
    return this.http.request({
      method: "POST",
      path: "/payments",
      body,
      schema: paymentInitRes,
    });
  }
}
