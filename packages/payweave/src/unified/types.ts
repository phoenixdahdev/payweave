/**
 * Unified layer (Surface B) — shared operation input/result types.
 * These signatures are IDENTICAL across providers; each provider implementation
 * (`unified/paystack.ts`, `unified/flutterwave.ts`) satisfies {@link UnifiedNamespace}.
 *
 * Unified-layer rules baked into these types (PRD §6.2, P0):
 * - Amounts are ALWAYS minor units — `{ value, currency }` where `value` is an
 *   integer count of the currency's minor unit. Adapters convert (Paystack
 *   passes kobo through; Flutterwave v3 converts to major units).
 * - Every result carries `raw` — the untouched provider response envelope, so
 *   the abstraction never hides data.
 * - Status is normalized via `unified/mappings.ts` (`toUnifiedStatus`).
 */
import type { Money } from "../core/money";
import type { UnifiedStatus } from "./mappings";

/** A minor-units amount on the way IN to a unified op. `value` is an integer. */
export interface UnifiedAmount {
  /** Integer count of the currency's minor unit (kobo, cents, …). */
  value: number;
  /** ISO-4217 currency code, e.g. `"NGN"`. */
  currency: string;
}

/** Customer block accepted by unified ops. Only `email` is required. */
export interface UnifiedCustomerInput {
  email: string;
  name?: string;
  phone?: string;
}

// ── checkout.create ──────────────────────────────────────────────────────────
/** Input to {@link UnifiedNamespace.checkout}.`create`. */
export interface CheckoutCreateInput {
  /** ALWAYS minor units — Paystack receives it as kobo, Flutterwave as major. */
  amount: UnifiedAmount;
  customer: UnifiedCustomerInput;
  /** Consumer reference → Paystack `reference` / Flutterwave `tx_ref`. Generated if omitted. */
  reference?: string;
  /** Post-payment redirect → Paystack `callback_url` / Flutterwave `redirect_url`. */
  redirectUrl?: string;
  metadata?: Record<string, unknown>;
}

/** Result of `checkout.create`. */
export interface CheckoutCreateResult {
  /** Hosted checkout URL to redirect the customer to. */
  checkoutUrl: string;
  /** The reference used (echoes the caller's, or the generated `pwv_<ulid>`). */
  reference: string;
  /** Provider-side reference/access-code, when the response carries one. */
  providerRef: string | undefined;
  /** Untouched provider response envelope. */
  raw: unknown;
}

// ── verify ───────────────────────────────────────────────────────────────────
/** Input to {@link UnifiedNamespace.verify}. */
export interface VerifyInput {
  /** The consumer reference (Paystack `reference` / Flutterwave `tx_ref`). */
  reference: string;
}

/** Normalized customer on a verify result. */
export interface UnifiedCustomer {
  email: string | undefined;
  name: string | undefined;
}

/** Result of `verify`. `amount` is returned in MINOR units. */
export interface VerifyResult {
  status: UnifiedStatus;
  /** Amount in MINOR units (Paystack passes through; Flutterwave major→minor). */
  amount: Money;
  customer: UnifiedCustomer;
  /** ISO timestamp the payment settled, when available. */
  paidAt: string | undefined;
  /** Payment channel/method, when available. */
  channel: string | undefined;
  raw: unknown;
}

// ── refunds.create ───────────────────────────────────────────────────────────
/** Input to {@link UnifiedNamespace.refunds}.`create`. */
export interface RefundCreateInput {
  /** The transaction reference to refund. */
  reference: string;
  /** Partial refund amount in MINOR units. Omit for a full refund. */
  amount?: UnifiedAmount;
}

/** Result of `refunds.create`. */
export interface RefundCreateResult {
  /** Provider-side refund id, when present. */
  providerRef: string | undefined;
  /** Provider-native refund status string (refund vocab is provider-specific). */
  status: string | undefined;
  raw: unknown;
}

// ── transfers.create ─────────────────────────────────────────────────────────
/**
 * Payout destination. NOTE(verify): the provider-native recipient shapes differ
 * (Paystack needs a `transferrecipient` created first to get an `RCP_…` code;
 * Flutterwave takes raw account details on the transfer itself). This is a
 * conservative common mapping — `type` defaults to Paystack's `"nuban"`.
 */
export interface TransferRecipient {
  accountNumber: string;
  bankCode: string;
  name?: string;
  /** Paystack recipient type (`"nuban"`, `"mobile_money"`, …). Ignored by FLW. */
  type?: string;
}

/** Input to {@link UnifiedNamespace.transfers}.`create`. */
export interface TransferCreateInput {
  /** Amount in MINOR units. */
  amount: number;
  currency: string;
  recipient: TransferRecipient;
  reason?: string;
  reference?: string;
}

/** Result of `transfers.create`. */
export interface TransferCreateResult {
  /** The transfer reference used (echoed / generated). */
  reference: string;
  /** Provider-side transfer id/code, when present. */
  providerRef: string | undefined;
  /** Normalized status via `toUnifiedStatus` (transfers share the status vocab). */
  status: UnifiedStatus;
  raw: unknown;
}

// ── banks.list ───────────────────────────────────────────────────────────────
/** Input to {@link UnifiedNamespace.banks}.`list`. */
export interface BanksListInput {
  /** Country selector — Paystack `?country=nigeria`; Flutterwave `/banks/NG`. */
  country: string;
}

/** A normalized bank entry. */
export interface UnifiedBank {
  name: string | undefined;
  code: string | undefined;
  raw: unknown;
}

// ── banks.resolveAccount ─────────────────────────────────────────────────────
/** Input to {@link UnifiedNamespace.banks}.`resolveAccount`. */
export interface ResolveAccountInput {
  accountNumber: string;
  bankCode: string;
}

/** Result of `banks.resolveAccount`. */
export interface ResolvedAccountResult {
  accountNumber: string | undefined;
  accountName: string | undefined;
  raw: unknown;
}

// ── the namespace ────────────────────────────────────────────────────────────
/**
 * The `sdk.unified` surface (Surface B) — six high-traffic ops with identical
 * signatures across providers. Built per-provider by `createUnified` in the
 * facade; each provider implementation converts amounts and normalizes status
 * per PRD §6.2.
 */
export interface UnifiedNamespace {
  checkout: { create(input: CheckoutCreateInput): Promise<CheckoutCreateResult> };
  verify(input: VerifyInput): Promise<VerifyResult>;
  refunds: { create(input: RefundCreateInput): Promise<RefundCreateResult> };
  transfers: { create(input: TransferCreateInput): Promise<TransferCreateResult> };
  banks: {
    list(input: BanksListInput): Promise<UnifiedBank[]>;
    resolveAccount(input: ResolveAccountInput): Promise<ResolvedAccountResult>;
  };
}
