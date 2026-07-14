/**
 * Unified-layer reference generator. When a consumer omits
 * `reference` on a unified op, the SDK generates one and returns it in the
 * result. The `pwv_` prefix is mandated by the naming rules and is
 * deliberately NOT `pk_` (that collides with Paystack's public-key prefix).
 *
 * No existing generator lives in `core/` (checked: `core/` has no ulid/reference
 * helper), so this implements one with `node:crypto`'s `randomUUID` — the
 * dashes are stripped to give a compact, opaque, ULID-shaped token. `uuidv7`
 * (ordered) is only worth pulling in if lexical ordering is needed; it is not
 * here, and `zod`+`node:crypto`+`fetch` is the only-runtime-deps rule.
 */
import { randomUUID } from "node:crypto";

/** Generate a fresh unified reference, e.g. `pwv_9f8c1e2a...`. */
export function generateReference(): string {
  return `pwv_${randomUUID().replace(/-/g, "")}`;
}
