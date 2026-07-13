/**
 * Minimal structural shapes of the `mongodb` driver's `Db`/`Collection`
 * surface this adapter relies on (docs/v1/database.md §7 — no real driver
 * types in the public/internal surface, mirroring `src/db/sqlite/url.ts`'s
 * precedent; see `./index.ts`'s module header for why). Every method here is
 * a documented, stable part of the driver's public API across the
 * `>=6.0.0 <8.0.0` peer range this package declares.
 */

/** Chained cursor shape (`.sort().limit().toArray()`). */
export interface MongoCursorLike<T> {
  sort(spec: Record<string, 1 | -1>): MongoCursorLike<T>;
  limit(n: number): MongoCursorLike<T>;
  toArray(): Promise<T[]>;
}

export interface MongoUpdateResultLike {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
}

export interface MongoCollectionLike<T> {
  findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): MongoCursorLike<T>;
  aggregate(
    pipeline: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): { toArray(): Promise<T[]> };
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options: Record<string, unknown>,
  ): Promise<T | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<MongoUpdateResultLike>;
  insertOne(doc: T, options?: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  createIndex(indexSpec: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<string>;
  indexes(): Promise<ReadonlyArray<{ name?: string }>>;
}

export interface MongoDbLike {
  collection<T = Record<string, unknown>>(name: string): MongoCollectionLike<T>;
}

/** Minimal structural shape of a `mongodb` `ClientSession` this adapter relies on. */
export interface MongoSessionLike {
  withTransaction<T>(fn: () => Promise<T>, options?: unknown): Promise<unknown>;
  endSession(): Promise<void>;
}

/**
 * The single canonical structural shape of a CONNECTED `mongodb` `MongoClient`
 * used internally once `./index.ts`'s `connect()` has bridged the real driver
 * object in — one consistent `startSession` signature everywhere avoids the
 * conflicting-member-merge pitfall of intersecting two independently-declared
 * client interfaces (`./url.ts`'s looser `MongoClientLike`, used only to
 * validate the `{ client }` INPUT shape before a real connection exists, is
 * deliberately a separate, decoupled type).
 */
export interface MongoConnectedClientLike {
  close(force?: boolean): Promise<void>;
  db(name?: string): MongoDbLike;
  startSession(options?: unknown): MongoSessionLike;
}
