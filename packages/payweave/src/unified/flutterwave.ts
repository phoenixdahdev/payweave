/**
 * Flutterwave (v3) unified-layer implementation (Surface B, PRD §6.2). Routes
 * the six unified ops to Flutterwave v3 REST endpoints via `http.request`
 * directly, keeping `unified/` decoupled from the Surface A resource classes.
 *
 * Amount contract: the unified layer speaks MINOR units but Flutterwave v3 uses
 * MAJOR units (provider-reference §1), so this adapter converts on the way out
 * (`toMajor`) and back on the way in (`toMinor`) using core Money — integer-safe,
 * never float math. Status is normalized via `toUnifiedStatus("flutterwave", …)`.
 *
 * NOTE(verify): the endpoints/paths here are Flutterwave **v3**. v4 is a
 * different generation (OAuth, restructured payloads, `succeeded` status vocab)
 * and would need its own unified impl; the `version` is threaded through only so
 * status normalization uses the right vocabulary if a v4 client reaches here.
 */
import type { HttpClient } from "../core/http";
import { PayweaveNotFoundError } from "../core/errors";
import { money, toMajor, toMinor } from "../core/money";
import { toUnifiedStatus, type MappingVersion } from "./mappings";
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

/** Build the Flutterwave unified namespace over a shared {@link HttpClient}. */
export function createFlutterwaveUnified(
  http: HttpClient,
  version: MappingVersion,
): UnifiedNamespace {
  return {
    checkout: {
      async create(input: CheckoutCreateInput): Promise<CheckoutCreateResult> {
        const reference = input.reference ?? generateReference();
        // Unified minor units → Flutterwave major units (e.g. 500000 kobo → 5000).
        const amountMajor = toMajor(money(input.amount.value, input.amount.currency));
        const customer: Record<string, unknown> = { email: input.customer.email };
        if (input.customer.name !== undefined) customer.name = input.customer.name;
        if (input.customer.phone !== undefined) customer.phonenumber = input.customer.phone;

        const body: Record<string, unknown> = {
          tx_ref: reference,
          amount: amountMajor,
          currency: input.amount.currency,
          customer,
        };
        if (input.redirectUrl !== undefined) body.redirect_url = input.redirectUrl;
        if (input.metadata !== undefined) body.meta = input.metadata;

        const raw = await http.request<unknown>({
          method: "POST",
          path: "/payments",
          body,
        });
        const data = envelopeData(raw);
        return {
          checkoutUrl: readString(data, "link") ?? "",
          reference,
          // The create response is tx_ref-based (no flw_ref yet); fall back to it.
          providerRef: readString(data, "flw_ref") ?? reference,
          raw,
        };
      },
    },

    async verify(input: VerifyInput): Promise<VerifyResult> {
      // Flutterwave verifies by tx_ref via a dedicated endpoint (the by-id verify
      // needs the numeric id). A 404 surfaces as PayweaveNotFoundError.
      const raw = await http.request<unknown>({
        method: "GET",
        path: "/transactions/verify_by_reference",
        query: { tx_ref: input.reference },
      });
      const data = envelopeData(raw);
      const currency = readString(data, "currency") ?? "NGN";
      // Flutterwave amount is MAJOR units — convert back to minor units (Money).
      const amountMajor = readNumber(data, "amount") ?? 0;
      const customer = asRecord(data?.customer);
      return {
        status: toUnifiedStatus("flutterwave", version, readString(data, "status")),
        amount: toMinor(amountMajor, currency),
        customer: {
          email: readString(customer, "email"),
          name: readString(customer, "name"),
        },
        // v3 has no explicit paid_at on the txn — fall back to created_at.
        paidAt: readString(data, "paid_at") ?? readString(data, "created_at"),
        channel: readString(data, "payment_type"),
        raw,
      };
    },

    refunds: {
      async create(input: RefundCreateInput): Promise<RefundCreateResult> {
        // Flutterwave refunds are keyed by the numeric transaction id, not the
        // reference. Two-step: resolve the tx_ref to an id via verify_by_reference,
        // then POST /transactions/:id/refund (amount converted to major units).
        const verifyRaw = await http.request<unknown>({
          method: "GET",
          path: "/transactions/verify_by_reference",
          query: { tx_ref: input.reference },
        });
        const txId = readNumber(envelopeData(verifyRaw), "id");
        if (txId === undefined) {
          // Guard: an unresolved reference would otherwise POST to
          // /transactions/undefined/refund and yield a misleading 4xx.
          throw new PayweaveNotFoundError(
            `Could not resolve a Flutterwave transaction id for reference "${input.reference}".`,
            { provider: "flutterwave", raw: verifyRaw },
          );
        }

        const body: Record<string, unknown> = {};
        if (input.amount !== undefined) {
          body.amount = toMajor(money(input.amount.value, input.amount.currency));
        }
        const raw = await http.request<unknown>({
          method: "POST",
          path: `/transactions/${String(txId)}/refund`,
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
        // Flutterwave takes raw account details on the transfer itself (no
        // separate recipient object like Paystack). NOTE(verify): recipient
        // `type` is Paystack-only and is ignored here.
        const amountMajor = toMajor(money(input.amount, input.currency));
        const body: Record<string, unknown> = {
          account_bank: input.recipient.bankCode,
          account_number: input.recipient.accountNumber,
          amount: amountMajor,
          currency: input.currency,
          reference,
        };
        if (input.reason !== undefined) body.narration = input.reason;
        if (input.recipient.name !== undefined) body.beneficiary_name = input.recipient.name;

        const raw = await http.request<unknown>({
          method: "POST",
          path: "/transfers",
          body,
        });
        const data = envelopeData(raw);
        const id = readNumber(data, "id");
        return {
          reference,
          providerRef: id !== undefined ? String(id) : undefined,
          status: toUnifiedStatus("flutterwave", version, readString(data, "status")),
          raw,
        };
      },
    },

    banks: {
      async list(input: BanksListInput): Promise<UnifiedBank[]> {
        const raw = await http.request<unknown>({
          method: "GET",
          path: `/banks/${encodeURIComponent(input.country)}`,
        });
        return envelopeDataArray(raw).map((bank) => ({
          name: readString(bank, "name"),
          code: readString(bank, "code"),
          raw: bank,
        }));
      },

      async resolveAccount(input: ResolveAccountInput): Promise<ResolvedAccountResult> {
        const raw = await http.request<unknown>({
          method: "POST",
          path: "/accounts/resolve",
          body: { account_number: input.accountNumber, account_bank: input.bankCode },
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
