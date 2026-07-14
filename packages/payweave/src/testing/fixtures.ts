/**
 * Fixture loader. Reads sanitized JSON fixtures from
 * `test/fixtures/<provider>/<resource>/<name>.json`. Fixtures must never carry
 * live secrets (CI regex gate enforces). Used by resource unit tests and by
 * consumers writing tests against the SDK.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Options for {@link loadFixture}. */
export interface LoadFixtureOptions {
  /** Fixtures root. Defaults to `<cwd>/test/fixtures`. */
  root?: string;
}

/**
 * Load and JSON-parse a fixture.
 *
 * @param provider - e.g. `"paystack"` / `"flutterwave"`.
 * @param resource - e.g. `"transactions"`.
 * @param name - Fixture file basename without extension, e.g. `"initialize.success"`.
 * @returns The parsed JSON (typed as `unknown` — narrow at the call site).
 */
export function loadFixture(
  provider: string,
  resource: string,
  name: string,
  options: LoadFixtureOptions = {},
): unknown {
  const root = options.root ?? resolve(process.cwd(), "test", "fixtures");
  const path = resolve(root, provider, resource, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Typed variant of {@link loadFixture} — asserts the caller-supplied shape.
 * (No runtime validation; use a schema at the boundary for that.)
 */
export function loadFixtureAs<T>(
  provider: string,
  resource: string,
  name: string,
  options: LoadFixtureOptions = {},
): T {
  return loadFixture(provider, resource, name, options) as T;
}
