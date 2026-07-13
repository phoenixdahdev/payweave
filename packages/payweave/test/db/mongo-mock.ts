/**
 * Test-only MongoDB fakes for `test/db/mongodb.test.ts` (PW-709). NOT a
 * conformant `mongodb` driver replacement and NEVER exported from `src/` —
 * mirrors `test/db/stub-adapter.ts`/`fixture-adapter.ts`'s "helper file that
 * doesn't match the `*.test.ts` glob" convention.
 *
 * Two things live here:
 *
 * 1. {@link MockCollection}/{@link MockDb} — an in-memory `MongoCollectionLike`/
 *    `MongoDbLike` (`src/db/mongodb/types.ts`) that RECORDS every call
 *    (structural assertions: "is `consume`/`claim` exactly one
 *    `findOneAndUpdate` call, with a pipeline array, never a plain object").
 * 2. A minimal aggregation-EXPRESSION evaluator ({@link runPipeline}) that
 *    actually INTERPRETS the `$set`/`$unset` stages and the handful of
 *    operators (`$ifNull`, `$cond`, `$switch`, `$let`, comparisons,
 *    arithmetic, `$dateAdd`, `$dateToParts`) the real adapter's pipelines use
 *    — so pipeline-backed methods (`consume`, `claim`, `customers.upsert`,
 *    `balances.resetTo`) can be exercised BEHAVIORALLY in-process, not just
 *    structurally. This is deliberately narrow (only the operators actually
 *    used) and its `$dateAdd`/month-clamping behavior is an ASSUMPTION about
 *    real MongoDB semantics — see `src/db/mongodb/period-pipeline.ts`'s
 *    module header and PW-709's report: this evaluator can prove the
 *    adapter's ALGORITHM self-consistent, never that a real `mongod` executes
 *    the same pipeline identically. Only real MongoDB (PW-710's CI conformance
 *    legs) proves that.
 */
import type {
  MongoCollectionLike,
  MongoCursorLike,
  MongoDbLike,
  MongoUpdateResultLike,
} from "../../src/db/mongodb/types";

// ── A minimal, narrow aggregation-expression evaluator ──────────────────────

type Vars = Record<string, unknown>;
type Doc = Record<string, unknown>;

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(root: Doc, path: string[], value: unknown): void {
  let cur: Doc = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (next === null || typeof next !== "object") cur[key] = {};
    cur = cur[key] as Doc;
  }
  cur[path[path.length - 1]!] = value;
}

/** Mirrors `period.ts`'s `addUtcMonthsClamped` — the ASSUMPTION this evaluator makes about real `$dateAdd`. */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
function dateAddMonthsClamped(anchorMs: number, months: number): number {
  const anchor = new Date(anchorMs);
  const totalMonths = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(totalMonths / 12);
  const monthIndex = ((totalMonths % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthIndex));
  return Date.UTC(
    year,
    monthIndex,
    day,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function toComparable(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return v as number;
}

export function evalExpr(expr: unknown, doc: Doc, vars: Vars): unknown {
  if (typeof expr === "string") {
    if (expr.startsWith("$$")) {
      const [head, ...rest] = expr.slice(2).split(".");
      return getPath(vars[head!], rest);
    }
    if (expr.startsWith("$")) {
      const [head, ...rest] = expr.slice(1).split(".");
      return getPath(doc[head!], rest) ?? (rest.length === 0 ? doc[head!] : undefined);
    }
    return expr;
  }
  if (expr === null || expr === undefined || expr instanceof Date || typeof expr !== "object") {
    return expr;
  }
  if (Array.isArray(expr)) return expr;

  const obj = expr as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || !keys[0]!.startsWith("$")) {
    // A plain object — e.g. `$let`'s `in: { index: "$$idx", start: ..., end: ... }`.
    // Real MongoDB recursively evaluates EVERY field of such an object as its
    // own expression (exactly like a $set/$project stage would) unless
    // wrapped in `$literal` — so this evaluator must too.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = evalExpr(v, doc, vars);
    return out;
  }
  const op = keys[0]!;
  const arg = obj[op];

  switch (op) {
    case "$literal":
      return arg;
    case "$ifNull": {
      const [a, b] = arg as [unknown, unknown];
      const v = evalExpr(a, doc, vars);
      return v === null || v === undefined ? evalExpr(b, doc, vars) : v;
    }
    case "$cond": {
      const [c, t, f] = arg as [unknown, unknown, unknown];
      return evalExpr(c, doc, vars) ? evalExpr(t, doc, vars) : evalExpr(f, doc, vars);
    }
    case "$switch": {
      const { branches, default: def } = arg as {
        branches: { case: unknown; then: unknown }[];
        default: unknown;
      };
      for (const b of branches) {
        if (evalExpr(b.case, doc, vars)) return evalExpr(b.then, doc, vars);
      }
      return evalExpr(def, doc, vars);
    }
    case "$let": {
      const { vars: varExprs, in: inExpr } = arg as { vars: Record<string, unknown>; in: unknown };
      const newVars: Vars = { ...vars };
      // Siblings within ONE `vars` block evaluate against the OUTER vars only
      // (documented MongoDB `$let` semantics) — never each other.
      for (const [k, v] of Object.entries(varExprs)) newVars[k] = evalExpr(v, doc, vars);
      return evalExpr(inExpr, doc, newVars);
    }
    case "$eq": {
      const [a, b] = (arg as unknown[]).map((e) => evalExpr(e, doc, vars)) as [unknown, unknown];
      return deepEqual(a, b);
    }
    case "$ne": {
      const [a, b] = (arg as unknown[]).map((e) => evalExpr(e, doc, vars)) as [unknown, unknown];
      return !deepEqual(a, b);
    }
    case "$gte":
    case "$gt":
    case "$lt":
    case "$lte": {
      const [a, b] = (arg as unknown[]).map((e) => toComparable(evalExpr(e, doc, vars))) as [
        number,
        number,
      ];
      if (op === "$gte") return a >= b;
      if (op === "$gt") return a > b;
      if (op === "$lt") return a < b;
      return a <= b;
    }
    case "$and":
      return (arg as unknown[]).every((e) => evalExpr(e, doc, vars));
    case "$or":
      return (arg as unknown[]).some((e) => evalExpr(e, doc, vars));
    case "$in": {
      const [needle, list] = (arg as unknown[]).map((e) => evalExpr(e, doc, vars)) as [unknown, unknown[]];
      return list.some((item) => deepEqual(item, needle));
    }
    case "$add": {
      const [a, b] = (arg as unknown[]).map((e) => evalExpr(e, doc, vars)) as [unknown, unknown];
      if (a instanceof Date) return new Date(a.getTime() + (b as number));
      if (b instanceof Date) return new Date(b.getTime() + (a as number));
      return (a as number) + (b as number);
    }
    case "$subtract": {
      const [a, b] = (arg as unknown[]).map((e) => evalExpr(e, doc, vars)) as [unknown, unknown];
      if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
      if (a instanceof Date) return new Date(a.getTime() - (b as number));
      return (a as number) - (b as number);
    }
    case "$multiply":
      return (arg as unknown[])
        .map((e) => evalExpr(e, doc, vars) as number)
        .reduce((acc, v) => acc * v, 1);
    case "$divide": {
      const [a, b] = (arg as unknown[]).map((e) => evalExpr(e, doc, vars) as number) as [number, number];
      return a / b;
    }
    case "$floor":
      return Math.floor(evalExpr(arg, doc, vars) as number);
    case "$max":
      return Math.max(...(arg as unknown[]).map((e) => evalExpr(e, doc, vars) as number));
    case "$dateAdd": {
      const { startDate, unit, amount } = arg as {
        startDate: unknown;
        unit: string;
        amount: unknown;
      };
      const start = evalExpr(startDate, doc, vars) as Date;
      const amt = evalExpr(amount, doc, vars) as number;
      if (unit !== "month") throw new Error(`mongo-mock: unsupported $dateAdd unit "${unit}"`);
      return new Date(dateAddMonthsClamped(start.getTime(), amt));
    }
    case "$dateToParts": {
      const { date } = arg as { date: unknown };
      const d = evalExpr(date, doc, vars) as Date;
      return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
        millisecond: d.getUTCMilliseconds(),
      };
    }
    default:
      throw new Error(`mongo-mock: unsupported operator "${op}" — extend the evaluator if needed`);
  }
}

/** Run a `$set`/`$unset`-stage pipeline against `seedDoc`, stage by stage. */
export function runPipeline(pipeline: Record<string, unknown>[], seedDoc: Doc): Doc {
  let doc: Doc = { ...seedDoc };
  for (const stage of pipeline) {
    if ("$set" in stage) {
      const fields = stage.$set as Record<string, unknown>;
      const next: Doc = { ...doc };
      for (const [key, expr] of Object.entries(fields)) {
        setPath(next, key.split("."), evalExpr(expr, doc, {}));
      }
      doc = next;
    } else if ("$unset" in stage) {
      const next: Doc = { ...doc };
      for (const name of stage.$unset as string[]) delete next[name];
      doc = next;
    } else {
      throw new Error(`mongo-mock: unsupported pipeline stage ${JSON.stringify(Object.keys(stage))}`);
    }
  }
  return doc;
}

// ── Filter matching (simple equality + $in) ─────────────────────────────────

function matchesFilter(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected !== null && typeof expected === "object" && "$in" in (expected as object)) {
      const list = (expected as { $in: unknown[] }).$in;
      return list.some((v) => deepEqual(v, actual));
    }
    return deepEqual(actual, expected);
  });
}

// ── Recorded call log ────────────────────────────────────────────────────────

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface MockIndexInfo {
  name: string;
  key: Record<string, 1 | -1>;
  options: Record<string, unknown>;
}

/** An in-memory `MongoCollectionLike` that both RECORDS calls and (partially) EXECUTES them. */
export class MockCollection<T extends Record<string, unknown>> implements MongoCollectionLike<T> {
  readonly docs = new Map<string, T>();
  readonly calls: RecordedCall[] = [];
  readonly indexInfos: MockIndexInfo[] = [];
  /** Composite-unique-key selectors this collection enforces (mirrors a real unique index). */
  uniqueKeys: Array<(doc: T) => string> = [];

  private checkUnique(doc: T, excludeId?: string): void {
    for (const keyFn of this.uniqueKeys) {
      const key = keyFn(doc);
      if (key === "") continue; // partial-index-style: empty key means "not indexed"
      for (const [id, existing] of this.docs) {
        if (id === excludeId) continue;
        if (keyFn(existing) === key) {
          const error = new Error("E11000 duplicate key error (mock)");
          (error as unknown as { code: number }).code = 11000;
          throw error;
        }
      }
    }
  }

  async findOne(filter: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<T | null> {
    this.calls.push({ method: "findOne", args: [filter, options] });
    let candidates = [...this.docs.values()].filter((d) => matchesFilter(d, filter));
    const sort = options.sort as Record<string, 1 | -1> | undefined;
    const sortEntry = sort ? Object.entries(sort)[0] : undefined;
    if (sortEntry) {
      const [field, dir] = sortEntry;
      candidates = candidates.sort((a, b) => {
        const av = a[field] as number;
        const bv = b[field] as number;
        return dir === -1 ? bv - av : av - bv;
      });
    }
    return candidates[0] ?? null;
  }

  find(filter: Record<string, unknown>, options: Record<string, unknown> = {}): MongoCursorLike<T> {
    this.calls.push({ method: "find", args: [filter, options] });
    const items = [...this.docs.values()].filter((d) => matchesFilter(d, filter));
    return makeCursor(items);
  }

  aggregate(pipeline: Record<string, unknown>[]): { toArray(): Promise<T[]> } {
    this.calls.push({ method: "aggregate", args: [pipeline] });
    // Special-cased for `plansListActive`'s exact shape: sort desc by version,
    // group by planId keeping the first (highest version), replaceRoot.
    const items = [...this.docs.values()];
    const byGroup = new Map<string, T>();
    const sorted = [...items].sort((a, b) => (b.version as number) - (a.version as number));
    for (const item of sorted) {
      const groupKey = item.planId as string;
      if (!byGroup.has(groupKey)) byGroup.set(groupKey, item);
    }
    return { toArray: async () => [...byGroup.values()] };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options: Record<string, unknown> = {},
  ): Promise<T | null> {
    this.calls.push({ method: "findOneAndUpdate", args: [filter, update, options] });
    const existing = [...this.docs.values()].find((d) => matchesFilter(d, filter));
    if (!existing && options.upsert !== true) return null;

    const seed: Doc = existing ? { ...existing } : { ...filter };
    let result: Doc;
    if (Array.isArray(update)) {
      result = runPipeline(update, seed);
    } else if ("$set" in update) {
      result = { ...seed };
      for (const [key, value] of Object.entries(update.$set as Record<string, unknown>)) {
        setPath(result, key.split("."), value);
      }
    } else {
      result = { ...seed, ...update };
    }

    const id = result._id as string;
    this.checkUnique(result as T, existing ? id : undefined);
    this.docs.set(id, result as T);
    return options.returnDocument === "before" ? (existing ?? null) : (result as T);
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResultLike> {
    this.calls.push({ method: "updateOne", args: [filter, update, options] });
    const existing = [...this.docs.values()].find((d) => matchesFilter(d, filter));
    if (!existing) {
      if (options.upsert !== true) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const seed: Doc = { ...filter };
      const result = Array.isArray(update)
        ? runPipeline(update, seed)
        : { ...seed, ...((update as { $set?: Record<string, unknown> }).$set ?? {}) };
      this.docs.set(result._id as string, result as T);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    const next = { ...existing };
    if (!Array.isArray(update) && "$set" in update) {
      for (const [key, value] of Object.entries(update.$set as Record<string, unknown>)) {
        setPath(next, key.split("."), value);
      }
    }
    this.docs.set(next._id as string, next as T);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  async insertOne(doc: T): Promise<{ insertedId: unknown }> {
    this.calls.push({ method: "insertOne", args: [doc] });
    this.checkUnique(doc);
    if (this.docs.has(doc._id as string)) {
      const error = new Error("E11000 duplicate key error (mock, _id)");
      (error as unknown as { code: number }).code = 11000;
      throw error;
    }
    this.docs.set(doc._id as string, doc);
    return { insertedId: doc._id };
  }

  async createIndex(indexSpec: Record<string, 1 | -1>, options: Record<string, unknown> = {}): Promise<string> {
    this.calls.push({ method: "createIndex", args: [indexSpec, options] });
    const name = (options.name as string) ?? Object.keys(indexSpec).join("_");
    if (!this.indexInfos.some((i) => i.name === name)) {
      this.indexInfos.push({ name, key: indexSpec, options });
    }
    return name;
  }

  async indexes(): Promise<ReadonlyArray<{ name?: string }>> {
    this.calls.push({ method: "indexes", args: [] });
    return [{ name: "_id_" }, ...this.indexInfos.map((i) => ({ name: i.name }))];
  }
}

function makeCursor<T>(items: T[]): MongoCursorLike<T> {
  let arr = items;
  const cursor: MongoCursorLike<T> = {
    sort(spec) {
      const entry = Object.entries(spec)[0];
      if (entry) {
        const [field, dir] = entry;
        arr = [...arr].sort((a, b) => {
          const av = (a as Record<string, unknown>)[field] as number;
          const bv = (b as Record<string, unknown>)[field] as number;
          return dir === -1 ? bv - av : av - bv;
        });
      }
      return cursor;
    },
    limit(n) {
      arr = arr.slice(0, n);
      return cursor;
    },
    toArray: async () => arr,
  };
  return cursor;
}

/** An in-memory `MongoDbLike` — one `MockCollection` per name, created on first access. */
export class MockDb implements MongoDbLike {
  private readonly collections = new Map<string, MockCollection<Record<string, unknown>>>();

  collection<T = Record<string, unknown>>(name: string): MongoCollectionLike<T> {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = new MockCollection<Record<string, unknown>>();
      this.collections.set(name, existing);
    }
    return existing as unknown as MongoCollectionLike<T>;
  }

  /** Test-only accessor — the concrete `MockCollection` for structural assertions. */
  rawCollection(name: string): MockCollection<Record<string, unknown>> {
    return this.collection(name) as unknown as MockCollection<Record<string, unknown>>;
  }
}

// ── Session / client fakes for topology tests ───────────────────────────────

export class MockSession {
  ended = false;
  constructor(private readonly mode: "replica-set" | "standalone") {}

  async withTransaction<T>(fn: () => Promise<T>): Promise<unknown> {
    if (this.mode === "standalone") {
      const error = new Error(
        "Transaction numbers are only allowed on a replica set member or mongos",
      );
      (error as unknown as { code: number }).code = 20;
      throw error;
    }
    return fn();
  }

  async endSession(): Promise<void> {
    this.ended = true;
  }
}

export class MockClient {
  sessions: MockSession[] = [];
  constructor(private readonly mode: "replica-set" | "standalone" = "replica-set") {}

  startSession(): MockSession {
    const session = new MockSession(this.mode);
    this.sessions.push(session);
    return session;
  }
}
