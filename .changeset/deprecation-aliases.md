---
"payweave": minor
---

`createPaystack`, `createFlutterwave`, and `PaymentSDK` (callable or `new`-able) are now deprecated thin aliases that delegate to `createPayweave` (unified-config.md §6) and will be removed at v1.0.0.

- Behavior is unchanged (§9 criterion 5): alias-built SDKs issue byte-identical requests and produce identical webhook verdicts to `createPayweave`-built clients. `sdk.paystack.*` / `sdk.flutterwave.*`, `sdk.unified.*`, `sdk.webhooks.*`, and the legacy `provider` / `environment` / `version` root props all keep working — plus the wrappers now additionally expose the full `PayweaveClient` root (unified ops, `providers`, `defaultProvider`).
- The first alias call per process emits ONE deprecation event (`type: "warn"`, naming the alias and its `createPayweave` replacement) through the injected `logger` — one event total across all aliases, never `console.*`, silent when no logger is configured.
- `PaystackSDK` / `FlutterwaveV3SDK` / `FlutterwaveV4SDK` remain exported (and `instanceof`-compatible) but are `@deprecated` wrappers whose type is the corresponding `PayweaveClient` shape plus the legacy root props; their constructors now take the delegated client instead of a `ResolvedConfig`.
