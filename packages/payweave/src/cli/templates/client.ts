/**
 * Optional frontend client file renderer.
 *
 * The Payweave SDK itself is server-only — constructing it needs your
 * provider secret key(s), which must never reach a browser bundle. This file
 * is a thin `fetch` wrapper for client-side code: it calls a checkout API
 * route YOU implement server-side (next to the generated webhook route),
 * never the SDK directly. Always scaffolded (no extra
 * wizard prompt) — its role is "optional to use," not "optional to generate."
 */
import type { ScaffoldFile } from "./types";

export function renderClientFile(): ScaffoldFile {
  const contents = [
    "// lib/payweave-client.ts — optional helper for frontend code.",
    "// The Payweave SDK is server-only (it holds your secret keys); this just",
    "// wraps a fetch call to a checkout API route you implement server-side.",
    "export async function createCheckoutSession(input: { planId: string }): Promise<{ url: string }> {",
    '  const response = await fetch("/api/checkout", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/json" },',
    "    body: JSON.stringify(input),",
    "  });",
    "  if (!response.ok) {",
    "    throw new Error(`checkout request failed: ${response.status}`);",
    "  }",
    "  return (await response.json()) as { url: string };",
    "}",
    "",
  ].join("\n");
  return { relPath: "lib/payweave-client.ts", contents };
}
