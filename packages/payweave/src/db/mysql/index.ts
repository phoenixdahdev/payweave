/**
 * `payweave/db/mysql` — MySQL adapter. Not implemented yet.
 *
 * This subpath is wired into the exports map ahead of the implementation so
 * the import path is stable. Placeholder only: no driver code is imported here
 * — `mysql2` becomes an optional peerDependency once the real adapter
 * ships, not now.
 */
import { PayweaveConfigError } from "../../core/errors";
import type { DatabaseAdapter } from "../index";

/**
 * Placeholder for the `mysql2`-backed adapter factory. The real factory
 * accepts a `mysql2/promise` pool or `{ uri }` and returns a
 * {@link DatabaseAdapter}.
 *
 * @throws {PayweaveConfigError} always — the mysql adapter is not implemented yet.
 */
export const mysqlAdapter: (poolOrOptions?: unknown) => DatabaseAdapter = () => {
  throw new PayweaveConfigError(
    'payweave/db/mysql is a placeholder subpath — the MySQL adapter ("mysql2") is not ' +
      'implemented yet. Until it ships, pass your own implementation of the DatabaseAdapter ' +
      'contract from "payweave/db" as `database`.',
  );
};
