/**
 * three of the six `payweave/db/<adapter>` subpaths are still
 * placeholder entries until their tickets ship the real adapters. Each
 * factory must fail fast with a PayweaveConfigError that names its subpath
 * and the ticket that ships the real implementation, and must not drag any
 * driver code into the graph.
 *
 * `payweave/db/sqlite` graduated out of this list with PW-706 (the real
 * `better-sqlite3`/`@libsql/client` adapter) — its own coverage lives in
 * `test/db/sqlite.test.ts`. `payweave/db/drizzle` graduated out with PW-708
 * (the real `drizzle-orm` adapter) — its own coverage lives in
 * `test/db/drizzle.test.ts`. `payweave/db/postgres` and
 * `payweave/db/mongodb` also graduated out to real adapters — their
 * coverage lives in `test/db/postgres.test.ts` / `test/db/mongodb.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { PayweaveConfigError } from "../../src/core/errors";
import { prismaAdapter } from "../../src/db/prisma/index";
import { mysqlAdapter } from "../../src/db/mysql/index";

const stubs = [
  { subpath: "payweave/db/prisma", factory: prismaAdapter },
  { subpath: "payweave/db/mysql", factory: mysqlAdapter },
] as const;

describe("db adapter stub subpaths", () => {
  for (const { subpath, factory } of stubs) {
    describe(subpath, () => {
      it("throws PayweaveConfigError naming the subpath and the DatabaseAdapter escape hatch", () => {
        expect(() => factory()).toThrowError(PayweaveConfigError);
        try {
          factory();
          expect.unreachable("stub factory must throw");
        } catch (error) {
          const err = error as PayweaveConfigError;
          expect(err.name).toBe("PayweaveConfigError");
          expect(err.message).toContain(subpath);
          expect(err.message).toContain('"payweave/db"');
          expect(err.isRetryable).toBe(false);
        }
      });

      it("throws even when called with a client/options argument", () => {
        expect(() => factory({})).toThrowError(PayweaveConfigError);
      });
    });
  }
});
