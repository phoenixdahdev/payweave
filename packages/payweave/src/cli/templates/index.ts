/** Barrel for `payweave init`'s string-template renderers. */
export type { DatabaseChoice, FrameworkId, ProviderId, ScaffoldFile, ScaffoldInput } from "./types";
export { renderPayweaveConfig, renderProducts } from "./config";
export { renderEnvExample } from "./env";
export { renderWebhookRoute } from "./webhook";
export { renderPrismaSchema, renderDrizzleSchema } from "./schema";
export { renderClientFile } from "./client";
