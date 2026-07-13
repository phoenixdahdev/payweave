/**
 * `payweave/db/mysql` — MySQL adapter (docs/v1/database.md; ships with PW-705).
 *
 * PW-505 wires this subpath into the exports map ahead of the implementation so
 * the import path is stable. Placeholder only: no driver code is imported here
 * — `mysql2` becomes an optional peerDependency in PW-705, not now
 * (database.md §7 dependency policy).
 */
import { PayweaveConfigError } from "../../core/errors";
import type { DatabaseAdapter } from "../index";

/**
 * Placeholder for the `mysql2`-backed adapter factory. The real factory
 * (PW-705) accepts a `mysql2/promise` pool or `{ uri }` and returns a
 * {@link DatabaseAdapter}.
 *
 * @throws {PayweaveConfigError} always — the mysql adapter lands with PW-705.
 */
export const mysqlAdapter: (poolOrOptions?: unknown) => DatabaseAdapter = () => {
  throw new PayweaveConfigError(
    'payweave/db/mysql is a placeholder subpath (PW-505) — the MySQL adapter ("mysql2") ' +
      'lands with PW-705. Until it ships, pass your own implementation of the DatabaseAdapter ' +
      'contract from "payweave/db" (docs/v1/database.md §3) as `database`, or track EPIC 7 in ' +
      "docs/v1/backlog.md.",
  );
};
