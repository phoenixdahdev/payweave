// unified/ — normalized layer. `mappings.ts` is the single source of truth for
// webhook event + transaction status normalization and is a PUBLIC contract
// (AGENTS.md §9): changing its semantics needs a changeset. Re-exported here so
// it is reachable on the `payweave/unified` subpath.
export {
  toUnifiedEventType,
  toUnifiedStatus,
  PAYSTACK_EVENT_MAP,
  FLUTTERWAVE_EVENT_MAP,
  FLUTTERWAVE_STATUS_SPLIT_MAP,
  PAYSTACK_STATUS_MAP,
  FLUTTERWAVE_V3_STATUS_MAP,
  FLUTTERWAVE_V4_STATUS_MAP,
  type UnifiedEventType,
  type UnifiedStatus,
  type MappingProvider,
  type MappingVersion,
} from "./mappings";

// Surface B (unified layer, PRD §6.2) — per-provider op factories + the shared
// operation types. The facade's `createUnified` picks the impl by provider.
export { createPaystackUnified } from "./paystack";
export { createFlutterwaveUnified } from "./flutterwave";
export { generateReference } from "./reference";
export type {
  UnifiedNamespace,
  UnifiedAmount,
  UnifiedCustomerInput,
  UnifiedCustomer,
  CheckoutCreateInput,
  CheckoutCreateResult,
  VerifyInput,
  VerifyResult,
  RefundCreateInput,
  RefundCreateResult,
  TransferRecipient,
  TransferCreateInput,
  TransferCreateResult,
  BanksListInput,
  UnifiedBank,
  ResolveAccountInput,
  ResolvedAccountResult,
} from "./types";
