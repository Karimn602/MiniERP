/**
 * Turn a Rust command's refusal into something a cashier can read.
 *
 * Gate 2A moved the master-data writes out of the renderer and into named Rust
 * commands (`src-tauri/src/admin.rs`). Those commands refuse bad input with a
 * stable UPPER_SNAKE code rather than prose, for the same reason the posting
 * commands do: a code can be translated, and a sentence composed in Rust
 * cannot. Anything that is not a known code is passed through unchanged, so an
 * unexpected fault still shows its real text instead of a shrug.
 *
 * The codes live in `locales/{en,ar}.ts` under `backendErrors`. Add a code in
 * three places or not at all: the command, both locales, and this map's type.
 */

/** Every refusal code the Gate 2A commands can return. */
export const BACKEND_ERROR_CODES = [
  "EXCHANGE_RATE_MUST_BE_POSITIVE",
  "EXCHANGE_RATE_OUT_OF_RANGE",
  "EXCHANGE_RATE_BAD_EFFECTIVE_DATE",
  "EXCHANGE_RATE_BAD_SOURCE",
  "EXCHANGE_RATE_MISSING_ID",
  "DRIVER_MISSING_ID",
  "DRIVER_NAME_REQUIRED",
  "DRIVER_NAME_TOO_LONG",
  "DRIVER_STORE_REQUIRED",
  "UNKNOWN_DRIVER",
  "SUPPLIER_MISSING_ID",
  "SUPPLIER_NAME_REQUIRED",
  "SUPPLIER_NAME_TOO_LONG",
  "SUPPLIER_STORE_REQUIRED",
  "UNKNOWN_SUPPLIER",
  "UNKNOWN_STORE",
] as const;

export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number];

const KNOWN = new Set<string>(BACKEND_ERROR_CODES);

/** Is this the whole message, and is it a code we have wording for? */
export function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return typeof value === "string" && KNOWN.has(value.trim());
}

/**
 * Translate a caught value into display text.
 *
 * `t` is `useTranslation()`'s translate function. A known code becomes
 * `backendErrors.<CODE>`; anything else is returned as its own message, because
 * hiding an unrecognised fault behind "something went wrong" is how a real
 * problem becomes unreportable.
 */
export function describeBackendError(
  e: unknown,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const raw = e instanceof Error ? e.message : String(e);
  const trimmed = raw.trim();
  if (isBackendErrorCode(trimmed)) {
    return t(`backendErrors.${trimmed}`);
  }
  return raw;
}
