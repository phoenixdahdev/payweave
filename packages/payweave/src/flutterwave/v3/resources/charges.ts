/**
 * Flutterwave v3 direct-charge resource (Surface A): card (3DES-encrypted),
 * bank transfer, USSD, NG account debit, and the OTP/PIN `validate-charge`
 * follow-up. All go to `POST /charges?type=...` except validate.
 *
 * The card path encrypts its plaintext payload via `../encrypt` and sends only
 * `{ client }`. Plaintext card data NEVER touches the logger (the HttpClient
 * only sees the ciphertext).
 *
 * Docs: https://developer.flutterwave.com/v3.0.0/reference/initiate-a-card-charge
 */
import type { HttpClient } from "../../../core/http";
import { PayweaveConfigError } from "../../../core/errors";
import { encryptCharge } from "../encrypt";
import { parseRequest, flwEnvelope } from "../shared";
import {
  bankTransferChargeReq,
  cardChargeReq,
  chargeData,
  ngAccountChargeReq,
  ussdChargeReq,
  validateChargeReq,
  type BankTransferChargeReq,
  type CardChargeReq,
  type NgAccountChargeReq,
  type UssdChargeReq,
  type ValidateChargeReq,
} from "../schemas/charges";

const chargeRes = flwEnvelope(chargeData);

/** Per-call overrides for a card charge. */
export interface CardChargeOptions {
  /**
   * The dashboard Encryption Key to use for this charge. Overrides the key
   * threaded via the client. Required when the client wasn't given one.
   */
  encryptionKey?: string;
}

export class Charges {
  /**
   * @param http - Shared HTTP client.
   * @param encryptionKey - The account Encryption Key (from resolved config).
   *   May be `undefined` if not configured; `card()` then requires a per-call
   *   `encryptionKey` override or throws {@link PayweaveConfigError}.
   */
  constructor(
    private readonly http: HttpClient,
    private readonly encryptionKey?: string,
  ) {}

  /**
   * Charge a card. The payload is 3DES-EDE3-ECB encrypted with the account
   * Encryption Key and sent as `{ client }` (provider-reference §5.3). `amount`
   * is MAJOR units, passed through unchanged. A successful charge that needs
   * OTP/PIN returns a `flw_ref` — pass it to {@link validate}.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/initiate-a-card-charge
   *
   * @example
   * const res = await fw.flutterwave.charges.card({
   *   card_number: "5531886652142950", cvv: "564",
   *   expiry_month: "09", expiry_year: "32", currency: "NGN",
   *   amount: 1000, email: "buyer@example.com", tx_ref: "pwv_tx_001",
   * });
   */
  async card(input: CardChargeReq, opts: CardChargeOptions = {}) {
    const payload = parseRequest(cardChargeReq, input);
    const key = opts.encryptionKey ?? this.encryptionKey;
    if (!key) {
      throw new PayweaveConfigError(
        "Flutterwave card charge requires an Encryption Key. Set `encryptionKey` in the SDK config or pass it as the second argument.",
        { provider: "flutterwave" },
      );
    }
    // Encrypt in-process; only the ciphertext leaves here → plaintext is never logged.
    const client = encryptCharge(key, payload);
    return this.http.request({
      method: "POST",
      path: "/charges",
      query: { type: "card" },
      body: { client },
      schema: chargeRes,
    });
  }

  /**
   * Initiate a bank-transfer (pay-with-transfer) charge. `amount` is MAJOR units.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/initiate-a-bank-transfer-charge
   *
   * @example
   * const res = await fw.flutterwave.charges.bankTransfer({
   *   tx_ref: "pwv_tx_002", amount: 5000, email: "buyer@example.com", currency: "NGN",
   * });
   */
  async bankTransfer(input: BankTransferChargeReq) {
    const body = parseRequest(bankTransferChargeReq, input);
    return this.http.request({
      method: "POST",
      path: "/charges",
      query: { type: "bank_transfer" },
      body,
      schema: chargeRes,
    });
  }

  /**
   * Initiate a USSD charge. `amount` is MAJOR units.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/initiate-a-ussd-charge
   *
   * @example
   * const res = await fw.flutterwave.charges.ussd({
   *   tx_ref: "pwv_tx_003", account_bank: "057", amount: 1000,
   *   email: "buyer@example.com", currency: "NGN",
   * });
   */
  async ussd(input: UssdChargeReq) {
    const body = parseRequest(ussdChargeReq, input);
    return this.http.request({
      method: "POST",
      path: "/charges",
      query: { type: "ussd" },
      body,
      schema: chargeRes,
    });
  }

  /**
   * Initiate a Nigeria bank-account debit charge. `amount` is MAJOR units.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/initiate-a-nigeria-bank-account-charge
   *
   * @example
   * const res = await fw.flutterwave.charges.ngAccount({
   *   tx_ref: "pwv_tx_004", account_bank: "044", account_number: "0690000031",
   *   amount: 1000, email: "buyer@example.com", currency: "NGN",
   * });
   */
  async ngAccount(input: NgAccountChargeReq) {
    const body = parseRequest(ngAccountChargeReq, input);
    return this.http.request({
      method: "POST",
      path: "/charges",
      query: { type: "debit_ng_account" },
      body,
      schema: chargeRes,
    });
  }

  /**
   * Validate a charge with the OTP/PIN the customer received.
   *
   * Docs: https://developer.flutterwave.com/v3.0.0/reference/validate-a-charge
   *
   * @example
   * const res = await fw.flutterwave.charges.validate({
   *   otp: "12345", flw_ref: "FLW-MOCK-abc", type: "card",
   * });
   */
  async validate(input: ValidateChargeReq) {
    const body = parseRequest(validateChargeReq, input);
    return this.http.request({
      method: "POST",
      path: "/validate-charge",
      body,
      schema: chargeRes,
    });
  }
}
