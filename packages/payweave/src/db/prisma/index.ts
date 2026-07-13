/**
 * `payweave/db/prisma` — Prisma adapter (docs/v1/database.md; ships with PW-707).
 *
 * PW-505 wires this subpath into the exports map ahead of the implementation so
 * the import path is stable. Placeholder only: no driver code is imported here
 * — `@prisma/client` becomes an optional peerDependency in PW-707, not now
 * (database.md §7 dependency policy).
 */
import { PayweaveConfigError } from "../../core/errors";
import type { DatabaseAdapter } from "../index";

/**
 * Placeholder for the Prisma-backed adapter factory. The real factory
 * (PW-707) accepts your existing `PrismaClient` and returns a
 * {@link DatabaseAdapter}.
 *
 * @throws {PayweaveConfigError} always — the Prisma adapter lands with PW-707.
 */
export const prismaAdapter: (prismaClient?: unknown) => DatabaseAdapter = () => {
  throw new PayweaveConfigError(
    'payweave/db/prisma is a placeholder subpath (PW-505) — the Prisma adapter ("@prisma/client") ' +
      'lands with PW-707. Until it ships, pass your own implementation of the DatabaseAdapter ' +
      'contract from "payweave/db" (docs/v1/database.md §3) as `database`, or track EPIC 7 in ' +
      "docs/v1/backlog.md.",
  );
};
