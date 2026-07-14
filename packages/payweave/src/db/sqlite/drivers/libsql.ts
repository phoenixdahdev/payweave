/**
 * `@libsql/client` backend for the sqlite adapter (docs/v1/database.md §4,
 * PW-706). This module is the ONLY place that touches an `@libsql/client`
 * `Client` instance; `../index.ts` dynamically imports the driver package and
 * passes the resulting instance in here, so core/`payweave` never pulls
 * `@libsql/client` into its module graph.
 */
import type { RawDriver, RawResult } from "../runner";
import type { LibsqlClientLike } from "../url";

export class LibsqlRaw implements RawDriver {
  readonly #client: LibsqlClientLike;

  constructor(client: LibsqlClientLike) {
    this.#client = client;
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<RawResult> {
    const result = await this.#client.execute({ sql, args: params });
    return { rows: result.rows };
  }
}
