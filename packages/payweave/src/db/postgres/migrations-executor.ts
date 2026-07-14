/**
 * Bridges the postgres adapter's {@link Runner} to the driver-agnostic
 * {@link MigrationExecutor}. The postgres dialect
 * already emits `$1…` placeholders and expects `Date` binds for timestamp
 * columns (`src/db/migrations/ledger.ts`), so this bridge is a thin
 * pass-through — no dialect translation needed here.
 */
import type { MigrationExecutor, MigrationQueryResult } from "../migrations/index";
import type { Runner } from "./runner";

export class PostgresMigrationExecutor implements MigrationExecutor {
  readonly #runner: Runner;

  constructor(runner: Runner) {
    this.#runner = runner;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<MigrationQueryResult> {
    const { rows } = await this.#runner.query(sql, params);
    return { rows };
  }

  async transaction<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
    return this.#runner.transaction((tx) => fn(new PostgresMigrationExecutor(tx)));
  }
}
