/**
 * `payweave/db/prisma` — Prisma adapter. Not implemented yet.
 *
 * This subpath is wired into the exports map ahead of the implementation so
 * the import path is stable. Placeholder only: no driver code is imported here
 * — `@prisma/client` becomes an optional peerDependency once the real
 * adapter ships, not now.
 */
import { PayweaveConfigError } from "../../core/errors";
import type { DatabaseAdapter } from "../index";

/**
 * Placeholder for the Prisma-backed adapter factory. The real factory
 * accepts your existing `PrismaClient` and returns a
 * {@link DatabaseAdapter}.
 *
 * @throws {PayweaveConfigError} always — the Prisma adapter is not implemented yet.
 */
export const prismaAdapter: (prismaClient?: unknown) => DatabaseAdapter = () => {
  throw new PayweaveConfigError(
    'payweave/db/prisma is a placeholder subpath — the Prisma adapter ("@prisma/client") is not ' +
      'implemented yet. Until it ships, pass your own implementation of the DatabaseAdapter ' +
      'contract from "payweave/db" as `database`.',
  );
};
