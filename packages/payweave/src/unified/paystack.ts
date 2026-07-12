/**
 * Paystack unified-layer implementation (Surface B, PRD §6.2). Routes the six
 * unified ops to Paystack REST endpoints via `http.request` directly — this
 * keeps `unified/` decoupled from the Surface A resource classes while reusing
 * the same shared {@link HttpClient} (auth, retries, error mapping, redaction).
 *
 * Amount contract: the unified layer speaks MINOR units and Paystack ALSO uses
 * minor units (kobo), so amounts pass through unchanged (provider-reference §1).
 * Status is normalized through `toUnifiedStatus("paystack", …)`.
 */
import type { HttpClient } from "../core/http";
import { money } from "../core/money";
import { toUnifiedStatus } from "./mappings";
import { generateReference } from "./reference";
import {
  asRecord,
  envelopeData,
  envelopeDataArray,
  readNumber,
  readString,
} from "./internal";
import type {
  BanksListInput,
  CheckoutCreateInput,
  CheckoutCreateResult,
  RefundCreateInput,
  RefundCreateResult,
  ResolveAccountInput,
  ResolvedAccountResult,
  TransferCreateInput,
  TransferCreateResult,
  UnifiedBank,
  UnifiedNamespace,
  VerifyInput,
  VerifyResult,
} from "./types";

/** Build the Paystack unified namespace over a shared {@link HttpClient}. */
export function createPaystackUnified(http: HttpClient): UnifiedNamespace {
  return {
    checkout: {
      async create(input: CheckoutCreateInput): Promise<CheckoutCreateResult> {
        const reference = input.reference ?? generateReference();
        // Paystack amounts are kobo (minor) — the unified `value` passes through.
        const body: Record<string, unknown> = {
          email: input.customer.email,
          amount: input.amount.value,
          currency: input.amount.currency,
          reference,
        };
        if (input.redirectUrl !== undefined) body.callback_url = input.redirectUrl;
        if (input.metadata !== undefined) body.metadata = input.metadata;

        const raw = await http.request<unknown>({
          method: "POST",
          path: "/transaction/initialize",
          body,
        });
        const data = envelopeData(raw);
        return {
          checkoutUrl: readString(data, "authorization_url") ?? "",
          reference,
          providerRef: readString(data, "reference") ?? readString(data, "access_code"),
          raw,
        };
      },
    },

    async verify(input: VerifyInput): Promise<VerifyResult> {
      // Paystack verifies by reference (provider-reference §5.2). A 404 surfaces
      // as PayweaveNotFoundError from http.request's error map — never swallowed.
      const raw = await http.request<unknown>({
        method: "GET",
        path: `/transaction/verify/${encodeURIComponent(input.reference)}`,
      });
      const data = envelopeData(raw);
      const currency = readString(data, "currency") ?? "NGN";
      // Paystack amount is already MINOR units (kobo) — wrap as Money directly.
      const amountValue = readNumber(data, "amount") ?? 0;
      const customer = asRecord(data?.customer);
      return {
        status: toUnifiedStatus("paystack", undefined, readString(data, "status")),
        amount: money(amountValue, currency),
        customer: {
          email: readString(customer, "email"),
          name: readString(customer, "name"),
        },
        paidAt: readString(data, "paid_at"),
        channel: readString(data, "channel"),
        raw,
      };
    },

    refunds: {
      async create(input: RefundCreateInput): Promise<RefundCreateResult> {
        // POST /refund — `transaction` accepts the reference; amount in kobo.
        const body: Record<string, unknown> = { transaction: input.reference };
        if (input.amount !== undefined) {
          body.amount = input.amount.value; // already minor units
          body.currency = input.amount.currency;
        }
        const raw = await http.request<unknown>({
          method: "POST",
          path: "/refund",
          body,
        });
        const data = envelopeData(raw);
        const id = readNumber(data, "id");
        return {
          providerRef: id !== undefined ? String(id) : undefined,
          status: readString(data, "status"),
          raw,
        };
      },
    },

    transfers: {
      async create(input: TransferCreateInput): Promise<TransferCreateResult> {
        const reference = input.reference ?? generateReference();
        // Two-step (Paystack has no single "transfer to account" call): create a
        // transfer recipient to obtain an RCP_… code, then initiate the transfer.
        // NOTE(verify): the recipient `type` defaults to "nuban"; other rails
        // (mobile_money/basa) need the caller to pass `recipient.type`.
        const recipientRaw = await http.request<unknown>({
          method: "POST",
          path: "/transferrecipient",
          body: {
            type: input.recipient.type ?? "nuban",
            name: input.recipient.name ?? input.recipient.accountNumber,
            account_number: input.recipient.accountNumber,
            bank_code: input.recipient.bankCode,
            currency: input.currency,
          },
        });
        const recipientCode = readString(envelopeData(recipientRaw), "recipient_code");

        const body: Record<string, unknown> = {
          source: "balance",
          amount: input.amount, // minor units pass through
          recipient: recipientCode,
          currency: input.currency,
          reference,
        };
        if (input.reason !== undefined) body.reason = input.reason;
        const raw = await http.request<unknown>({
          method: "POST",
          path: "/transfer",
          body,
        });
        const data = envelopeData(raw);
        return {
          reference,
          providerRef: readString(data, "transfer_code"),
          status: toUnifiedStatus("paystack", undefined, readString(data, "status")),
          raw,
        };
      },
    },

    banks: {
      async list(input: BanksListInput): Promise<UnifiedBank[]> {
        const raw = await http.request<unknown>({
          method: "GET",
          path: "/bank",
          query: { country: input.country },
        });
        return envelopeDataArray(raw).map((bank) => ({
          name: readString(bank, "name"),
          code: readString(bank, "code"),
          raw: bank,
        }));
      },

      async resolveAccount(input: ResolveAccountInput): Promise<ResolvedAccountResult> {
        const raw = await http.request<unknown>({
          method: "GET",
          path: "/bank/resolve",
          query: { account_number: input.accountNumber, bank_code: input.bankCode },
        });
        const data = envelopeData(raw);
        return {
          accountNumber: readString(data, "account_number"),
          accountName: readString(data, "account_name"),
          raw,
        };
      },
    },
  };
}
