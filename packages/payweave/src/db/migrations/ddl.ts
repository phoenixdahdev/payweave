/**
 * Embedded DDL for migration `0001_init` — the full docs/v1/database.md §2
 * logical schema, per dialect (PW-703). These string constants ARE the
 * migration content: they are hashed byte-for-byte into the `pw_migrations`
 * checksum, so **once `0001_init` has been applied anywhere it is immutable
 * forever** — even a whitespace edit is mutated history and makes every
 * existing database fail loudly (database.md §4). Schema changes ship as
 * `0002_...`, never as edits here. Forward-only: no down migrations exist.
 *
 * Per-dialect storage mapping (build-time resolutions, recorded in
 * database.md §4):
 *
 * | logical            | postgres      | mysql                      | sqlite            |
 * |--------------------|---------------|----------------------------|-------------------|
 * | timestamp (UTC)    | `TIMESTAMPTZ` | `DATETIME(3)` (UTC session)| `INTEGER` epoch ms|
 * | JSON               | `JSONB`       | `JSON`                     | `TEXT`            |
 * | boolean            | `BOOLEAN`     | `TINYINT(1)`               | `INTEGER` 0|1     |
 * | money/usage int    | `BIGINT`      | `BIGINT`                   | `INTEGER` (64-bit)|
 * | id / key string    | `TEXT`        | `VARCHAR(255)`             | `TEXT`            |
 *
 * - NO float/decimal column exists anywhere — money is integer minor units +
 *   currency code (golden rule 7 applies to storage; database.md §2).
 * - MySQL sessions must run in UTC (`time_zone = '+00:00'`) — PW-705 forces
 *   this in the pool config; `DATETIME` has no zone of its own.
 * - MySQL tables are `utf8mb4` with BINARY collation (`utf8mb4_bin`) so key
 *   comparisons stay case-sensitive, matching postgres/sqlite semantics.
 * - `group` and `limit` are reserved words: quoted `"..."` on
 *   postgres/sqlite, `` `...` `` on mysql. Adapters must match this quoting.
 * - sqlite booleans carry `CHECK (col IN (0, 1))` because sqlite is otherwise
 *   dynamically typed; no other CHECK constraints exist (row validity is
 *   enforced by the zod row schemas at the adapter boundary).
 *
 * THE PARTIAL-UNIQUE ACTIVE-SUBSCRIPTION RULE (database.md §2): at most one
 * `pw_subscriptions` row per (`customer_id`, `group`) with `status` in
 * ('active', 'past_due', 'trialing').
 *
 * - postgres + sqlite: native partial unique index
 *   (`CREATE UNIQUE INDEX ... WHERE status IN (...)`).
 * - mysql: NO partial indexes exist, so the rule is emulated with a STORED
 *   generated column `active_slot` — `'x'` when `status` is in the active
 *   set, `NULL` otherwise — plus a composite unique index on
 *   (`customer_id`, `group`, `active_slot`). MySQL unique indexes never
 *   treat NULLs as equal, so inactive rows can pile up freely while a second
 *   active-set row collides. `active_slot` is generated storage: adapters
 *   must NEVER write it (an INSERT that names it errors — that is the DDL
 *   working). Recorded in database.md §4 (PW-703 build-time resolution).
 */
import { PW_ACTIVE_SUBSCRIPTION_STATUSES, PW_TABLES } from "../schema";
import { ledgerEnsureSql } from "./ledger";

/**
 * The active-status set of the partial-unique rule, as a SQL `IN (...)` list.
 * Derived from {@link PW_ACTIVE_SUBSCRIPTION_STATUSES} so the DDL can never
 * drift from the contract constant.
 */
const ACTIVE_STATUS_SQL_LIST = PW_ACTIVE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(", ");

const freezeSql = (statements: readonly string[]): readonly string[] =>
  Object.freeze([...statements]);

// ── postgres ─────────────────────────────────────────────────────────────────

/** `0001_init` statements, postgres dialect. IMMUTABLE — see module header. */
export const POSTGRES_INIT_STATEMENTS: readonly string[] = freezeSql([
  ledgerEnsureSql("postgres"),
  `CREATE TABLE ${PW_TABLES.customers} (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  provider_ids JSONB NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pw_customers_external_id_uq UNIQUE (external_id)
)`,
  `CREATE TABLE ${PW_TABLES.plans} (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  "group" TEXT NOT NULL,
  is_default BOOLEAN NOT NULL,
  name TEXT,
  price_minor BIGINT,
  price_currency TEXT,
  price_interval TEXT,
  features JSONB NOT NULL,
  provider_refs JSONB NOT NULL,
  pushed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pw_plans_plan_id_version_uq UNIQUE (plan_id, version)
)`,
  `CREATE TABLE ${PW_TABLES.subscriptions} (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  "group" TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_subscription_ref TEXT,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pw_subscriptions_customer_id_fk FOREIGN KEY (customer_id) REFERENCES ${PW_TABLES.customers} (id)
)`,
  `CREATE UNIQUE INDEX pw_subscriptions_active_uq
  ON ${PW_TABLES.subscriptions} (customer_id, "group")
  WHERE status IN (${ACTIVE_STATUS_SQL_LIST})`,
  `CREATE TABLE ${PW_TABLES.featureBalances} (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  "group" TEXT NOT NULL,
  used BIGINT NOT NULL,
  "limit" BIGINT NOT NULL,
  reset_interval TEXT NOT NULL,
  anchor TIMESTAMPTZ NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pw_feature_balances_customer_id_fk FOREIGN KEY (customer_id) REFERENCES ${PW_TABLES.customers} (id),
  CONSTRAINT pw_feature_balances_customer_feature_group_uq UNIQUE (customer_id, feature_id, "group")
)`,
  `CREATE TABLE ${PW_TABLES.webhookEvents} (
  dedupe_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ
)`,
]);

// ── mysql ────────────────────────────────────────────────────────────────────

/** `0001_init` statements, mysql dialect. IMMUTABLE — see module header. */
export const MYSQL_INIT_STATEMENTS: readonly string[] = freezeSql([
  ledgerEnsureSql("mysql"),
  `CREATE TABLE ${PW_TABLES.customers} (
  id VARCHAR(255) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  provider_ids JSON NOT NULL,
  email VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT pw_customers_external_id_uq UNIQUE (external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${PW_TABLES.plans} (
  id VARCHAR(255) NOT NULL,
  plan_id VARCHAR(255) NOT NULL,
  version INT NOT NULL,
  \`group\` VARCHAR(255) NOT NULL,
  is_default TINYINT(1) NOT NULL,
  name VARCHAR(255) NULL,
  price_minor BIGINT NULL,
  price_currency VARCHAR(255) NULL,
  price_interval VARCHAR(255) NULL,
  features JSON NOT NULL,
  provider_refs JSON NOT NULL,
  pushed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT pw_plans_plan_id_version_uq UNIQUE (plan_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${PW_TABLES.subscriptions} (
  id VARCHAR(255) NOT NULL,
  customer_id VARCHAR(255) NOT NULL,
  plan_id VARCHAR(255) NOT NULL,
  plan_version INT NOT NULL,
  \`group\` VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NULL,
  provider_subscription_ref VARCHAR(255) NULL,
  current_period_start DATETIME(3) NOT NULL,
  current_period_end DATETIME(3) NOT NULL,
  cancel_at_period_end TINYINT(1) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  active_slot CHAR(1) GENERATED ALWAYS AS (
    CASE WHEN status IN (${ACTIVE_STATUS_SQL_LIST}) THEN 'x' ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT pw_subscriptions_customer_id_fk FOREIGN KEY (customer_id) REFERENCES ${PW_TABLES.customers} (id),
  CONSTRAINT pw_subscriptions_active_uq UNIQUE (customer_id, \`group\`, active_slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${PW_TABLES.featureBalances} (
  id VARCHAR(255) NOT NULL,
  customer_id VARCHAR(255) NOT NULL,
  feature_id VARCHAR(255) NOT NULL,
  \`group\` VARCHAR(255) NOT NULL,
  used BIGINT NOT NULL,
  \`limit\` BIGINT NOT NULL,
  reset_interval VARCHAR(255) NOT NULL,
  anchor DATETIME(3) NOT NULL,
  period_start DATETIME(3) NOT NULL,
  period_end DATETIME(3) NOT NULL,
  plan_id VARCHAR(255) NOT NULL,
  plan_version INT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT pw_feature_balances_customer_id_fk FOREIGN KEY (customer_id) REFERENCES ${PW_TABLES.customers} (id),
  CONSTRAINT pw_feature_balances_customer_feature_group_uq UNIQUE (customer_id, feature_id, \`group\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${PW_TABLES.webhookEvents} (
  dedupe_key VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL,
  type VARCHAR(255) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  claimed_at DATETIME(3) NULL,
  applied_at DATETIME(3) NULL,
  PRIMARY KEY (dedupe_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
]);

// ── sqlite ───────────────────────────────────────────────────────────────────

/** `0001_init` statements, sqlite dialect. IMMUTABLE — see module header. */
export const SQLITE_INIT_STATEMENTS: readonly string[] = freezeSql([
  ledgerEnsureSql("sqlite"),
  `CREATE TABLE ${PW_TABLES.customers} (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  provider_ids TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT pw_customers_external_id_uq UNIQUE (external_id)
)`,
  `CREATE TABLE ${PW_TABLES.plans} (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  "group" TEXT NOT NULL,
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  name TEXT,
  price_minor INTEGER,
  price_currency TEXT,
  price_interval TEXT,
  features TEXT NOT NULL,
  provider_refs TEXT NOT NULL,
  pushed_at INTEGER NOT NULL,
  CONSTRAINT pw_plans_plan_id_version_uq UNIQUE (plan_id, version)
)`,
  `CREATE TABLE ${PW_TABLES.subscriptions} (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  "group" TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_subscription_ref TEXT,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT pw_subscriptions_customer_id_fk FOREIGN KEY (customer_id) REFERENCES ${PW_TABLES.customers} (id)
)`,
  `CREATE UNIQUE INDEX pw_subscriptions_active_uq
  ON ${PW_TABLES.subscriptions} (customer_id, "group")
  WHERE status IN (${ACTIVE_STATUS_SQL_LIST})`,
  `CREATE TABLE ${PW_TABLES.featureBalances} (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  "group" TEXT NOT NULL,
  used INTEGER NOT NULL,
  "limit" INTEGER NOT NULL,
  reset_interval TEXT NOT NULL,
  anchor INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT pw_feature_balances_customer_id_fk FOREIGN KEY (customer_id) REFERENCES ${PW_TABLES.customers} (id),
  CONSTRAINT pw_feature_balances_customer_feature_group_uq UNIQUE (customer_id, feature_id, "group")
)`,
  `CREATE TABLE ${PW_TABLES.webhookEvents} (
  dedupe_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  claimed_at INTEGER,
  applied_at INTEGER
)`,
]);
