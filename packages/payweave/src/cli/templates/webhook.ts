/**
 * Webhook route handler renderer, one per detected framework EXCEPT NestJS —
 * Nest gets a full DI-wired module instead (`./nest.ts`'s
 * `renderNestWebhookController`, injecting `PayweaveService` rather than
 * constructing its own client), since a loose root-level handler function
 * isn't how Nest projects are structured. Every variant here follows golden
 * rule 6 (webhooks are security-critical): the RAW received bytes are passed
 * to `payweave.webhooks.constructEvent` untouched — never re-serialized,
 * never parsed as JSON first.
 *
 * The Next.js and plain-`node:http` variants use only Web-standard
 * (`Request`/`Response`) and `node:*` types respectively — no external
 * framework type package is assumed installed. The Express/Fastify variants
 * import their framework's own types, which the DETECTED project already has
 * installed (that's how framework detection found it) — see
 * `test/cli/init.test.ts` for how each variant's validity is actually
 * asserted.
 */
import type { FrameworkId, ScaffoldFile } from "./types";

const WEBHOOK_ROUTE_PATH: Readonly<Record<Exclude<FrameworkId, "nest">, string>> = {
  // App Router only, not Next.js generically; Pages Router scaffolding is
  // out of v1's scope.
  next: "app/api/webhooks/payweave/route.ts",
  express: "payweave-webhook.ts",
  fastify: "payweave-webhook-plugin.ts",
  node: "payweave-webhook-server.ts",
};

/** Relative import specifier from `relPath` back to the project-root `payweave.ts`. */
function importRootPayweave(relPath: string): string {
  const depth = relPath.split("/").length - 1;
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  return `${prefix}payweave`;
}

function renderNext(relPath: string): string {
  const payweaveImport = importRootPayweave(relPath);
  return [
    `import { payweave } from "${payweaveImport}";`,
    "",
    "// Next.js App Router Route Handler. Uses only the Web",
    "// Request/Response API — no `next/server` import needed.",
    "export async function POST(request: Request): Promise<Response> {",
    "  // Raw text FIRST — Payweave verifies the EXACT bytes the provider signed",
    "  // (golden rule 6); never JSON.parse before constructEvent.",
    "  const rawBody = await request.text();",
    "",
    "  let event;",
    "  try {",
    "    event = payweave.webhooks.constructEvent({ rawBody, headers: request.headers });",
    "  } catch {",
    '    return new Response("invalid webhook signature", { status: 400 });',
    "  }",
    "",
    "  await event.apply();",
    "  return new Response(null, { status: 200 });",
    "}",
    "",
  ].join("\n");
}

function renderExpress(relPath: string): string {
  const payweaveImport = importRootPayweave(relPath);
  return [
    `import type { Request, Response } from "express";`,
    `import { payweave } from "${payweaveImport}";`,
    "",
    "// Mount BEFORE any body-parsing middleware, with a raw body parser, e.g.:",
    '//   app.post("/api/webhooks/payweave", express.raw({ type: "*/*" }), payweaveWebhookHandler);',
    "// Payweave verifies the EXACT raw bytes the provider signed (golden rule 6) —",
    "// express.json()/express.urlencoded() would re-serialize the body first.",
    "export async function payweaveWebhookHandler(req: Request, res: Response): Promise<void> {",
    "  const rawBody = req.body as Buffer; // the Buffer express.raw() populates req.body with",
    "",
    "  let event;",
    "  try {",
    "    event = payweave.webhooks.constructEvent({ rawBody, headers: req.headers });",
    "  } catch {",
    '    res.status(400).send("invalid webhook signature");',
    "    return;",
    "  }",
    "",
    "  await event.apply();",
    "  res.status(200).end();",
    "}",
    "",
  ].join("\n");
}

function renderFastify(relPath: string): string {
  const payweaveImport = importRootPayweave(relPath);
  return [
    `import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";`,
    `import { payweave } from "${payweaveImport}";`,
    "",
    "// Requires a raw-body plugin (e.g. @fastify/raw-body) registered first —",
    "// Payweave verifies the EXACT raw bytes the provider signed (golden rule 6).",
    "export async function payweaveWebhookPlugin(app: FastifyInstance): Promise<void> {",
    '  app.post("/api/webhooks/payweave", async (request: FastifyRequest, reply: FastifyReply) => {',
    "    // `rawBody` is set by your raw-body plugin, not Fastify core — cast it in.",
    "    const rawBody = (request as unknown as { rawBody: string }).rawBody;",
    "",
    "    let event;",
    "    try {",
    "      event = payweave.webhooks.constructEvent({ rawBody, headers: request.headers });",
    "    } catch {",
    '      return reply.code(400).send("invalid webhook signature");',
    "    }",
    "",
    "    await event.apply();",
    "    return reply.code(200).send();",
    "  });",
    "}",
    "",
  ].join("\n");
}

function renderNode(relPath: string): string {
  const payweaveImport = importRootPayweave(relPath);
  return [
    `import { createServer } from "node:http";`,
    `import { payweave } from "${payweaveImport}";`,
    "",
    "// Plain node:http fallback — no framework detected.",
    "const server = createServer((req, res) => {",
    '  if (req.method !== "POST" || req.url !== "/api/webhooks/payweave") {',
    "    res.writeHead(404).end();",
    "    return;",
    "  }",
    "",
    "  const chunks: Buffer[] = [];",
    '  req.on("data", (chunk: Buffer) => chunks.push(chunk));',
    '  req.on("end", () => {',
    "    void (async () => {",
    "      // Concatenate the raw bytes — Payweave verifies EXACTLY what the",
    "      // provider signed (golden rule 6); never re-encode before this.",
    "      const rawBody = Buffer.concat(chunks);",
    "",
    "      let event;",
    "      try {",
    "        event = payweave.webhooks.constructEvent({ rawBody, headers: req.headers });",
    "      } catch {",
    '        res.writeHead(400).end("invalid webhook signature");',
    "        return;",
    "      }",
    "",
    "      await event.apply();",
    "      res.writeHead(200).end();",
    "    })();",
    "  });",
    "});",
    "",
    "server.listen(3000, () => {",
    '  console.log("Payweave webhook listener on http://localhost:3000/api/webhooks/payweave");',
    "});",
    "",
  ].join("\n");
}

/** Render the framework-specific webhook route file. NestJS isn't a valid input — see this module's doc comment. */
export function renderWebhookRoute(framework: Exclude<FrameworkId, "nest">): ScaffoldFile {
  const relPath = WEBHOOK_ROUTE_PATH[framework];
  switch (framework) {
    case "next":
      return { relPath, contents: renderNext(relPath) };
    case "express":
      return { relPath, contents: renderExpress(relPath) };
    case "fastify":
      return { relPath, contents: renderFastify(relPath) };
    case "node":
      return { relPath, contents: renderNode(relPath) };
  }
}
