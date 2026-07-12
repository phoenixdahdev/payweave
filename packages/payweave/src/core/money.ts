/**
 * Money — integer minor units, always (TDD §6.4, PRD §6.2). No floating-point
 * amounts ever cross a provider boundary. `value` is an integer count of the
 * currency's minor unit (kobo, cents, …); `currency` is an ISO-4217 code.
 */
import { PayweaveValidationError } from "./errors";

/** A monetary amount. `value` is ALWAYS an integer in the currency's minor units. */
export type Money = { value: number; currency: string };

/**
 * ISO-4217 minor-unit exponents that are NOT the default of 2. Zero-exponent
 * currencies have no minor unit (₦-style kobo does not exist for them), so a
 * "major" amount already equals the "minor" amount. Three-exponent currencies
 * (Gulf dinars) use thousandths. Anything absent defaults to 2.
 */
export const CURRENCY_EXPONENTS: Record<string, 0 | 2 | 3> = {
  // 0-exponent (no minor unit) — includes the West/Central African CFA francs
  // relevant to Paystack/Flutterwave coverage.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // 3-exponent (thousandths)
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** Default minor-unit exponent for any currency not in {@link CURRENCY_EXPONENTS}. */
export const DEFAULT_EXPONENT = 2;

/**
 * Minor-unit exponent for a currency code (case-insensitive). Unknown codes
 * fall back to {@link DEFAULT_EXPONENT} (2) — the adapter layer logs a warning
 * for unknown currencies; this pure function does not.
 */
export function exponentFor(currency: string): number {
  return CURRENCY_EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/**
 * Construct a validated {@link Money} from a MINOR-unit value. Rejects
 * non-integers (a float here almost always means the caller passed major units)
 * with a fix-it message pointing at {@link toMinor}.
 *
 * @example money(500000, "NGN") // ₦5,000 as { value: 500000, currency: "NGN" }
 */
export function money(value: number, currency: string): Money {
  if (!Number.isSafeInteger(value)) {
    throw new PayweaveValidationError(
      `amount must be integer minor units — got ${value}; did you mean toMinor(${value}, '${currency}')?`,
    );
  }
  return { value, currency: currency.toUpperCase() };
}

/**
 * Assert an existing {@link Money} carries an integer minor-unit value. Returns
 * the same object for convenient chaining; throws {@link PayweaveValidationError}
 * on a non-integer.
 */
export function assertMoney(m: Money): Money {
  if (!Number.isSafeInteger(m.value)) {
    throw new PayweaveValidationError(
      `amount must be integer minor units — got ${m.value}; did you mean toMinor(${m.value}, '${m.currency}')?`,
    );
  }
  return m;
}

/**
 * Convert a MINOR-unit {@link Money} to a major-unit number (for display or for
 * providers that expect major units, e.g. Flutterwave v3). Validates the source
 * value is an integer first.
 *
 * @example toMajor({ value: 500000, currency: "NGN" }) // 5000
 */
export function toMajor(m: Money): number {
  assertMoney(m);
  const exp = exponentFor(m.currency);
  if (exp === 0) return m.value;
  return m.value / 10 ** exp;
}

/**
 * Convert a MAJOR-unit amount to a minor-unit {@link Money} using integer-safe
 * math (never `value / 100`). A rounding guard rejects amounts with more
 * fractional precision than the currency permits (e.g. `50.555` for a
 * 2-exponent currency) rather than silently truncating.
 *
 * @example toMinor(5000, "NGN")   // { value: 500000, currency: "NGN" }
 * @example toMinor(50.5, "NGN")   // { value: 5050, currency: "NGN" }
 * @example toMinor(1000, "XOF")   // { value: 1000, currency: "XOF" } (0-exponent)
 */
export function toMinor(major: number, currency: string): Money {
  if (typeof major !== "number" || !Number.isFinite(major)) {
    throw new PayweaveValidationError(
      `amount must be a finite number — got ${String(major)}`,
    );
  }
  const exp = exponentFor(currency);
  const factor = 10 ** exp;
  // Scale then round; the guard below catches any precision the currency can't
  // represent, so the rounding only ever absorbs floating-point noise.
  const scaled = major * factor;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new PayweaveValidationError(
      `amount ${major} has more precision than ${currency.toUpperCase()} allows (${exp} minor-unit digits)`,
    );
  }
  if (!Number.isSafeInteger(rounded)) {
    throw new PayweaveValidationError(
      `amount ${major} ${currency.toUpperCase()} exceeds the safe integer range in minor units`,
    );
  }
  return { value: rounded, currency: currency.toUpperCase() };
}
