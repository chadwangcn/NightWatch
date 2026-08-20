/**
 * NightWatch WP-02 — Error envelope factory (LIB_* and CMP_* namespaces only).
 *
 * Mirrors the WP-01 pattern: wraps the FROZEN WP-00 error registry
 * (nightwatch/schemas/errors.json) and the error envelope contract
 * (nightwatch/schemas/error/v1.json). No new codes are invented here —
 * only already-registered LIB_/CMP_ codes may be emitted; anything else
 * is a programming error and throws.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // .../nightwatch
const ERRORS_REGISTRY = JSON.parse(readFileSync(join(NW_ROOT, "schemas", "errors.json"), "utf8"));

const ALLOWED_NAMESPACES = new Set(["LIB_", "CMP_"]);

/**
 * Build a NightWatch error envelope.
 * @param {string} code registered error code (must live in errors.json)
 * @param {string} message human-readable, secret-free message
 * @param {object} [details] optional structured details
 */
export function makeError(code, message, details = {}) {
  const def = ERRORS_REGISTRY.codes[code];
  if (!def) {
    throw new Error(`unregistered error code used: ${code} (only codes from nightwatch/schemas/errors.json are allowed)`);
  }
  const ns = code.split("_")[0] + "_";
  if (!ALLOWED_NAMESPACES.has(ns)) {
    throw new Error(`non-LIB_/CMP_ code used by the library component: ${code}`);
  }
  const envelope = {
    code,
    message,
    retryable: def.retryable,
    idempotent_replay: false,
  };
  if (details && Object.keys(details).length > 0) envelope.details = details;
  return envelope;
}

/** LIB_CASE_INVALID — case violates the case model constraints (e.g. DB-read assertion). */
export const caseInvalid = (message, details) => makeError("LIB_CASE_INVALID", message, details);

/** LIB_CASE_NOT_FOUND — referenced case does not exist in the library. */
export const caseNotFound = (message, details) => makeError("LIB_CASE_NOT_FOUND", message, details);

/** LIB_DUPLICATE_CASE — a case with the same identity already exists. */
export const duplicateCase = (message, details) => makeError("LIB_DUPLICATE_CASE", message, details);

/** CMP_COMPILE_FAILED — deterministic compilation failed. */
export const compileFailed = (message, details) => makeError("CMP_COMPILE_FAILED", message, details);

/** CMP_STATIC_CHECK_FAILED — compiled asset failed static validation. */
export const staticCheckFailed = (message, details) => makeError("CMP_STATIC_CHECK_FAILED", message, details);
