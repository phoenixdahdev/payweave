// paystack/ — Surface A client shell + resources.
// Public subpath: `payweave/paystack`.

export { PaystackClient } from "./client";

// ── Resource classes ─────────────────────────────────────────────────────────
export { Transactions } from "./resources/transactions";
export { Refunds } from "./resources/refunds";
export { Customers } from "./resources/customers";
export { Misc } from "./resources/misc";
export { TransferRecipients } from "./resources/transfer-recipients";
export { Transfers } from "./resources/transfers";
export { Plans } from "./resources/plans";
export { Subscriptions } from "./resources/subscriptions";

// ── Request/response types ───────────────────────────────────────────────────
export type {
  InitializeReq,
  ChargeAuthorizationReq,
  PartialDebitReq,
  ListQuery as TransactionListQuery,
  TotalsQuery,
} from "./schemas/transactions";

export type {
  CreateRefundReq,
  ListRefundsQuery,
} from "./schemas/refunds";

export type {
  CreateCustomerReq,
  UpdateCustomerReq,
  ListCustomersQuery,
  ValidateCustomerReq,
  SetRiskActionReq,
} from "./schemas/customers";

export type {
  ListBanksQuery,
  ResolveAccountQuery,
  ListStatesQuery,
} from "./schemas/misc";

export type {
  CreateRecipientReq,
  ListRecipientsQuery,
  InitiateTransferReq,
  ListTransfersQuery,
} from "./schemas/transfers";

export type {
  CreatePlanReq,
  ListPlansQuery,
  CreateSubscriptionReq,
  ListSubscriptionsQuery,
  ToggleSubscriptionReq,
} from "./schemas/plans";
