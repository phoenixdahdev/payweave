/**
 * Shared `plans.pushVersion` content-comparison helper (docs/v1/database.md
 * §2/§3, PW-708) — dialect-agnostic pure JS, reused by all three Drizzle
 * dialect stores so the append-only/no-op-on-unchanged-content rule can never
 * drift between them.
 */
import type { PwPlanVersion, PwPlanVersionInput } from "../schema";

/** Stable (sorted-key) JSON for order-independent structural comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The `pw_plans` fields that define plan "content" — everything except id/version/pushedAt. */
interface PlanContent {
  group: string;
  isDefault: boolean;
  name: string | null;
  priceMinor: number | null;
  priceCurrency: string | null;
  priceInterval: string | null;
  features: unknown;
  providerRefs: unknown;
}

const planContent = (p: PwPlanVersion | PwPlanVersionInput): PlanContent => ({
  group: p.group,
  isDefault: p.isDefault,
  name: p.name,
  priceMinor: p.priceMinor,
  priceCurrency: p.priceCurrency,
  priceInterval: p.priceInterval,
  features: p.features,
  providerRefs: p.providerRefs,
});

/** Whether `input`'s comparable fields match `active`'s — the pushVersion no-op gate. */
export function planContentEquals(active: PwPlanVersion, input: PwPlanVersionInput): boolean {
  return stableStringify(planContent(active)) === stableStringify(planContent(input));
}
