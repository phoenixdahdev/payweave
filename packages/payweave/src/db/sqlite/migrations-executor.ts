/**
 * Bridges the sqlite adapter's {@link Runner} to PW-703's driver-agnostic
 * {@link MigrationExecutor} (docs/v1/database.md §4). The sqlite dialect
 * already emits `?` placeholders and expects epoch-millisecond binds for
 * timestamp columns (`src/db/migrations/ledger.ts`), so this bridge is a thin
 * pass-through — no dialect translation needed here.
 */
import type { MigrationExecutor, MigrationQueryResult } from "../migrations/index";
import type { Runner } from "./runner";

export class SqliteMigrationExecutor implements MigrationExecutor {
  readonly #runner: Runner;

  constructor(runner: Runner) {
    this.#runner = runner;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<MigrationQueryResult> {
    const { rows } = await this.#runner.execute(sql, params);
    return { rows };
  }

  async transaction<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
    return this.#runner.transaction((tx) => fn(new SqliteMigrationExecutor(tx)));
  }
}
