/**
 * NightWatch WP-01 — Error envelope factory (REG_* namespace only).
 *
 * Wraps the WP-00 frozen error registry (nightwatch/schemas/errors.json) and the
 * error envelope contract (nightwatch/schemas/error/v1.json). New codes are NOT
 * invented here: only already-registered codes may be emitted; anything else is a
 * programming error and throws.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // .../nightwatch
const ERRORS_REGISTRY = JSON.parse(readFileSync(join(NW_ROOT, "schemas", "errors.json"), "utf8"));

/**
 * Build a NightWatch error envelope.
 * @param {string} code registered error code (must live in errors.json)
 * @param {string} message human-readable, secret-free message
 * @param {object} [details] optional structured details
 * @param {{idempotentReplay?: boolean}} [opts]
 */
export function makeError(code, message, details = {}, opts = {}) {
  const def = ERRORS_REGISTRY.codes[code];
  if (!def) {
    throw new Error(`unregistered error code used: ${code} (only codes from nightwatch/schemas/errors.json are allowed)`);
  }
  if (!code.startsWith("REG_")) {
    throw new Error(`non-REG_ code used by the registry component: ${code}`);
  }
  const envelope = {
    code,
    message,
    retryable: def.retryable,
    idempotent_replay: opts.idempotentReplay === true,
  };
  if (details && Object.keys(details).length > 0) envelope.details = details;
  return envelope;
}

/** REG_SPEC_INVALID — parse/normalize/validate failure; last valid version is kept. */
export const specInvalid = (message, details, opts) => makeError("REG_SPEC_INVALID", message, details, opts);

/** REG_SOURCE_UNAVAILABLE — contract source could not be fetched. */
export const sourceUnavailable = (message, details) => makeError("REG_SOURCE_UNAVAILABLE", message, details);

/** REG_CHECKSUM_MISMATCH — fetched checksum does not match the pinned expectation. */
export const checksumMismatch = (message, details) => makeError("REG_CHECKSUM_MISMATCH", message, details);
