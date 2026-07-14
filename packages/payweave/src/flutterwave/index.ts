// flutterwave/ — Surface A client shell + v3 resources.
// Public subpath: `payweave/flutterwave`. Version-isolated: only the
// v3 surface is exported here; v4 lands in a later wave and never shares schemas.

export { FlutterwaveClient } from "./client";

// ── v3 resource classes ──────────────────────────────────────────────────────
export { Payments } from "./v3/resources/payments";
export { Transactions } from "./v3/resources/transactions";
export { Banks } from "./v3/resources/banks";
export { Refunds } from "./v3/resources/refunds";
export { Charges, type CardChargeOptions } from "./v3/resources/charges";
export { Transfers } from "./v3/resources/transfers";
export { Beneficiaries } from "./v3/resources/beneficiaries";

// ── v3 encryption (isolated 3DES helper) ─────────────────────────────────────
export { encryptCharge, decryptCharge } from "./v3/encrypt";

// ── v3 request/response types ────────────────────────────────────────────────
export type { CreatePaymentReq } from "./v3/schemas/payments";
export type {
  ListQuery as TransactionListQuery,
  FeesQuery as TransactionFeesQuery,
} from "./v3/schemas/transactions";
export type { ResolveAccountReq } from "./v3/schemas/banks";
export type { CreateRefundReq, ListRefundsQuery } from "./v3/schemas/refunds";
export type {
  CardChargeReq,
  BankTransferChargeReq,
  UssdChargeReq,
  NgAccountChargeReq,
  ValidateChargeReq,
} from "./v3/schemas/charges";
export type {
  CreateTransferReq,
  ListTransfersQuery,
  TransferFeeQuery,
  CreateBeneficiaryReq,
  ListBeneficiariesQuery,
} from "./v3/schemas/transfers";
