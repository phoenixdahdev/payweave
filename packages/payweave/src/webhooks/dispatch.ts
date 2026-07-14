/**
 * webhooks/dispatch.ts — multi-provider header dispatch for `createPayweave`
 * clients. One endpoint serves every configured
 * provider: the provider is detected from the signature header NAME ONLY (the
 * body is NEVER parsed before verification succeeds), then the request is
 * handed to that provider's existing timing-safe verifier and the untouched
 * verify→parse→normalize pipeline in `webhooks/index.ts`.
 *
 * Fail-closed rejections, all {@link PayweaveWebhookVerificationError}, never
 * falling through to another provider's verifier:
 *
 * - a signature header for a provider NOT configured on this client;
 * - more than one known signature header on one request (ambiguous, likely
 *   forged — rejected even if one of the signatures would verify);
 * - no known signature header at all;
 * - a Flutterwave header for the WRONG configured `version` — a client
 *   verifies only with its own version's scheme (AGENTS.md rule 11).
 *
 * A configured provider whose webhook secret is missing at verify time throws
 * {@link PayweaveConfigError} (same conventions as the single-provider
 * namespace: Paystack falls back to its API secret key; Flutterwave and Stripe
 * require `webhookSecret`).
 */
import { PayweaveConfigError, PayweaveWebhookVerificationError } from "../core/errors";
import type { ResolvedPayweaveConfig, ResolvedProviderConfig } from "../core/config";
import { readHeader, type HeaderLookup } from "../core/provider";
import type { BillingApplyContext } from "../products/apply";
import { verifyPaystack } from "./paystack";
import { verifyFlutterwaveV3 } from "./flutterwave";
import { verifyFlutterwaveV4 } from "./flutterwave-v4";
import { verifyStripe } from "./stripe";
import { constructEvent, type WebhookEvent } from "./index";

/** Raw-body + headers input accepted by every dispatch operation. */
export interface WebhookDispatchInput {
  /** Exact received bytes — never a re-serialized object. */
  rawBody: string | Uint8Array;
  /** `Headers` or a plain/array header map; looked up case-insensitively. */
  headers: HeaderLookup;
}

/**
 * The multi-provider `payweave.webhooks` surface. `verify` returns the
 * signature verdict as a boolean but still THROWS for the detection
 * rejections above (they are structural failures, not signature mismatches)
 * and for missing-secret config errors — matching the single-provider
 * namespace, whose `verify` also throws {@link PayweaveConfigError}.
 */
export interface WebhookDispatchNamespace {
  /** Detect the provider from the signature header, then verify (timing-safe, fails closed). */
  verify(input: WebhookDispatchInput): boolean;
  /** {@link verify}, but a signature mismatch throws {@link PayweaveWebhookVerificationError}. */
  verifyOrThrow(input: WebhookDispatchInput): void;
  /** Detect + verify + parse + normalize into a typed {@link WebhookEvent}. */
  constructEvent(input: WebhookDispatchInput): WebhookEvent;
}

/**
 * One row of the header→provider table below. Flutterwave rows carry the version
 * their header belongs to (v3/v4 never share a scheme — AGENTS.md rule 11).
 * `headerName` is canonical lower-case and matched case-insensitively.
 */
type SignatureHeaderSpec =
  | { readonly headerName: string; readonly provider: "paystack" | "stripe" }
  | {
      readonly headerName: string;
      readonly provider: "flutterwave";
      readonly flutterwaveVersion: "v3" | "v4";
    };

/**
 * The header→provider table. Detection is on header NAMES only; the two
 * Flutterwave rows are distinct because the version is decided by which header
 * arrives — and must then match the configured version.
 */
const SIGNATURE_HEADER_TABLE: readonly SignatureHeaderSpec[] = [
  { headerName: "x-paystack-signature", provider: "paystack" },
  { headerName: "verif-hash", provider: "flutterwave", flutterwaveVersion: "v3" },
  { headerName: "flutterwave-signature", provider: "flutterwave", flutterwaveVersion: "v4" },
  { headerName: "stripe-signature", provider: "stripe" },
];

const KNOWN_HEADER_NAMES = SIGNATURE_HEADER_TABLE.map((spec) => spec.headerName).join(", ");

/** A detected signature header: its table row plus the received value. */
interface DetectedSignature {
  readonly spec: SignatureHeaderSpec;
  readonly value: string;
}

/**
 * Detect the provider from the signature-header NAMES present on the request.
 * Exactly one known header must be present: zero and more-than-one both
 * throw {@link PayweaveWebhookVerificationError} — an ambiguous request is
 * rejected even when one of its signatures would verify.
 */
function detectSignatureHeader(headers: HeaderLookup): DetectedSignature {
  const found: DetectedSignature[] = [];
  for (const spec of SIGNATURE_HEADER_TABLE) {
    const value = readHeader(headers, spec.headerName);
    if (value !== undefined) found.push({ spec, value });
  }
  const [only, ...rest] = found;
  if (only === undefined) {
    throw new PayweaveWebhookVerificationError(
      `No known webhook signature header on the request — expected exactly one of: ${KNOWN_HEADER_NAMES}.`,
      { provider: "unknown", isRetryable: false },
    );
  }
  if (rest.length > 0) {
    const names = found.map((f) => f.spec.headerName).join(", ");
    throw new PayweaveWebhookVerificationError(
      `Multiple known webhook signature headers on one request (${names}) — ambiguous and likely forged; rejecting.`,
      { provider: "unknown", isRetryable: false },
    );
  }
  return only;
}

/**
 * Resolve the detected provider's config entry, failing closed when the header
 * belongs to a provider this client does not have configured or to the
 * wrong Flutterwave version (AGENTS.md rule 11) — never falling through to
 * another provider's verifier.
 */
function requireConfigured(
  resolved: ResolvedPayweaveConfig,
  spec: SignatureHeaderSpec,
): ResolvedProviderConfig {
  const entry = resolved.providerConfigs[spec.provider];
  if (entry === undefined) {
    throw new PayweaveWebhookVerificationError(
      `Received a "${spec.headerName}" header but ${spec.provider} is not configured on this ` +
        `client (configured: ${resolved.providers.join(", ")}) — failing closed.`,
      { provider: spec.provider, isRetryable: false },
    );
  }
  if (spec.provider === "flutterwave") {
    const configuredVersion = entry.version === "v4" ? "v4" : "v3";
    if (spec.flutterwaveVersion !== configuredVersion) {
      throw new PayweaveWebhookVerificationError(
        `Received the Flutterwave ${spec.flutterwaveVersion} signature header ` +
          `("${spec.headerName}") but this client is configured for Flutterwave ${configuredVersion} — ` +
          "a client verifies webhooks only with its own version's scheme; failing closed.",
        { provider: "flutterwave", isRetryable: false },
      );
    }
  }
  return entry;
}

/**
 * Verify with the DETECTED provider's own scheme and secret, mirroring the
 * single-provider namespace's secret conventions exactly: Paystack keys the
 * HMAC with `webhookSecret ?? secretKey`; Flutterwave (both versions) and
 * Stripe require `webhookSecret` and throw {@link PayweaveConfigError} without
 * it (fail closed — Stripe's HMAC key is the endpoint signing secret
 * `whsec_*`, never the API secret key). Verification itself stays in the
 * timing-safe primitives; `verifyStripe` never throws, so a `false` becomes a
 * {@link PayweaveWebhookVerificationError} in the callers above.
 */
function verifyDetected(
  entry: ResolvedProviderConfig,
  spec: SignatureHeaderSpec,
  input: WebhookDispatchInput,
): boolean {
  if (spec.provider === "paystack") {
    // Paystack: webhookSecret is unsupported; the API secret key is the HMAC key.
    const secret = entry.webhookSecret ?? entry.secretKey;
    if (!secret) {
      throw new PayweaveConfigError("Missing Paystack secret key for webhook verification.", {
        provider: "paystack",
      });
    }
    return verifyPaystack(input.rawBody, readHeader(input.headers, spec.headerName), secret);
  }
  if (spec.provider === "flutterwave") {
    // Flutterwave (v3 + v4): the dashboard secret hash is REQUIRED — fail closed.
    if (!entry.webhookSecret) {
      throw new PayweaveConfigError(
        "Flutterwave webhook verification requires `webhookSecret` (the dashboard secret hash).",
        { provider: "flutterwave" },
      );
    }
    if (spec.flutterwaveVersion === "v4") {
      return verifyFlutterwaveV4(
        input.rawBody,
        readHeader(input.headers, spec.headerName),
        entry.webhookSecret,
      );
    }
    return verifyFlutterwaveV3(readHeader(input.headers, spec.headerName), entry.webhookSecret);
  }
  // Stripe: the endpoint signing secret (`whsec_*`) is REQUIRED — the API
  // secret key is NEVER a fallback HMAC key (fail closed).
  if (!entry.webhookSecret) {
    throw new PayweaveConfigError(
      "Stripe webhook verification requires `webhookSecret` (the endpoint signing secret, `whsec_*`).",
      { provider: "stripe" },
    );
  }
  return verifyStripe(input.rawBody, readHeader(input.headers, spec.headerName), entry.webhookSecret);
}

/**
 * Build the multi-provider `payweave.webhooks` namespace for a resolved keyed
 * config. Detection runs IN FRONT of the existing
 * verifiers on header names only; verification and normalization are the
 * pre-existing pipeline, unchanged — a single-provider client behaves
 * byte-identically for its own header, with the same rejection rules on top.
 *
 * `billing` is the `database`/`products` slice every constructed
 * event's `.apply()` runs against — `src/index.ts` passes the SAME
 * `billingContext` object it already builds for `subscribe`/
 * `check`/`report`. Omitted (or database-less), `.apply()` still exists on
 * every returned event but throws `PayweaveConfigError` when called.
 */
export function createWebhookDispatch(
  resolved: ResolvedPayweaveConfig,
  billing?: BillingApplyContext,
): WebhookDispatchNamespace {
  /** Detect → enforce configured-provider/version → hand back the bound entry. */
  function dispatch(headers: HeaderLookup): {
    spec: SignatureHeaderSpec;
    entry: ResolvedProviderConfig;
  } {
    const { spec } = detectSignatureHeader(headers);
    return { spec, entry: requireConfigured(resolved, spec) };
  }

  function verify(input: WebhookDispatchInput): boolean {
    const { spec, entry } = dispatch(input.headers);
    return verifyDetected(entry, spec, input);
  }

  return {
    verify,
    verifyOrThrow(input) {
      const { spec, entry } = dispatch(input.headers);
      if (!verifyDetected(entry, spec, input)) {
        throw new PayweaveWebhookVerificationError("Webhook signature verification failed.", {
          provider: spec.provider,
          isRetryable: false,
        });
      }
    },
    constructEvent(input) {
      const { spec, entry } = dispatch(input.headers);
      const version =
        spec.provider === "flutterwave" ? (entry.version === "v4" ? "v4" : "v3") : undefined;
      // Hand off to the untouched verify→parse→normalize pipeline with the
      // DETECTED provider bound; raw bytes pass through unmodified.
      return constructEvent({
        rawBody: input.rawBody,
        headers: input.headers,
        provider: spec.provider,
        version,
        verify: (i) => verifyDetected(entry, spec, i),
        logger: entry.logger,
        billing,
      });
    },
  };
}
