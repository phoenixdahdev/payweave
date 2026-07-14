/**
 * MSW network-edge mocking helpers. Resource tests mock at
 * the network layer (never stub `HttpClient`/`fetch`). `msw` is an OPTIONAL peer
 * dependency, so it is loaded via dynamic `import()` — importing `payweave/testing`
 * for `signWebhook`/`loadFixture` alone never requires msw to be installed.
 */
import type { RequestHandler } from "msw";
import type { SetupServer } from "msw/node";

/** HTTP methods a {@link MockRoute} can match. */
export type MockMethod = "get" | "post" | "put" | "patch" | "delete" | "all";

/** Declarative mock route → compiled into an msw handler. */
export interface MockRoute {
  method: MockMethod;
  /** Absolute URL or path pattern (msw path syntax, e.g. `*\/transaction/*`). */
  url: string;
  /** Response status (default 200). */
  status?: number;
  /** JSON body to respond with. */
  json?: unknown;
  /** Response headers. */
  headers?: Record<string, string>;
}

async function loadMsw(): Promise<typeof import("msw")> {
  return import("msw");
}

/**
 * Compile declarative {@link MockRoute}s into msw request handlers. Async
 * because it lazily loads `msw`.
 */
export async function createHandlers(routes: MockRoute[]): Promise<RequestHandler[]> {
  const { http, HttpResponse } = await loadMsw();
  return routes.map((route) => {
    const resolver = (): Response =>
      HttpResponse.json((route.json ?? null) as Record<string, unknown> | null, {
        status: route.status ?? 200,
        ...(route.headers ? { headers: route.headers } : {}),
      });
    return http[route.method](route.url, resolver);
  });
}

/**
 * Create (but do not start) an msw `setupServer` seeded with the given routes.
 * Callers own the lifecycle: `server.listen()` / `server.resetHandlers()` /
 * `server.close()`. Async because it lazily loads `msw/node`.
 *
 * @example
 * const server = await createMswServer([
 *   { method: "post", url: "*\/transaction/initialize", json: fixture },
 * ]);
 * server.listen();
 */
export async function createMswServer(routes: MockRoute[] = []): Promise<SetupServer> {
  const { setupServer } = await import("msw/node");
  const handlers = await createHandlers(routes);
  return setupServer(...handlers);
}
