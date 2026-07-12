import type { FetchLike, FetchResponse } from "../src/core/http";

/** Build a structural FetchResponse for tests (real Headers under the hood). */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    json: async () => body,
  };
}

/** A fetch stub that returns queued responses (or throws queued errors) in order. */
export function queuedFetch(
  steps: Array<FetchResponse | Error | (() => FetchResponse | Promise<FetchResponse>)>,
): FetchLike & { calls: Array<{ url: string; init?: unknown }> } {
  let i = 0;
  const fn = (async (url: string, init?: unknown) => {
    fn.calls.push({ url, init });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step();
    return step as FetchResponse;
  }) as FetchLike & { calls: Array<{ url: string; init?: unknown }> };
  fn.calls = [];
  return fn;
}
