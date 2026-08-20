/**
 * NightWatch WP-03 — Error envelope factory (C14 Audit, Checkpoint and Catalog Index)
 *
 * Produces WP-00 error envelopes (schemas/error/v1.json) using ONLY codes
 * registered in nightwatch/schemas/errors.json (read-only source of truth).
 * No new codes are ever invented here; `makeError` throws if asked for an
 * unregistered code (defense in depth — an unregistered code would break the
 * WP-00 error-registry invariants).
 *
 * Code selection for C14 runtime conditions (all registered at WP-00):
 *   - AUD_REPLAY_MISMATCH    audit idempotency replay with mismatched payload
 *   - AUD_CHECKPOINT_INVALID checkpoint corrupt / fails validation
 *   - CTL_LOCK_EXPIRED       expired lock rejected, never auto-extended (§22.5.4)
 *   - FIX_RESOURCE_LOCKED    resource held by another owner under a valid lock
 *   - CTL_UNAUTHORIZED       caller not authorized (e.g. non-holder release)
 *   - CTL_VALIDATION_FAILED  request payload failed schema/contract validation
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/state
const SCHEMAS_DIR = join(STATE_ROOT, "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const registry = JSON.parse(readFileSync(join(SCHEMAS_DIR, "errors.json"), "utf8"));
const registeredCodes = new Set(Object.keys(registry.codes));

/** All error codes used by this component (every one registered in WP-00 errors.json). */
export const ERROR_CODES = {
  AUDIT_REPLAY_MISMATCH: "AUD_REPLAY_MISMATCH",
  CHECKPOINT_INVALID: "AUD_CHECKPOINT_INVALID",
  LOCK_EXPIRED: "CTL_LOCK_EXPIRED",
  RESOURCE_LOCKED: "FIX_RESOURCE_LOCKED",
  UNAUTHORIZED: "CTL_UNAUTHORIZED",
  VALIDATION_FAILED: "CTL_VALIDATION_FAILED",
};

export const isRegisteredCode = (code) => registeredCodes.has(code);

/**
 * Build a WP-00 error envelope.
 * `retryable` comes from the registry default (never invented locally).
 */
export function makeError(code, message, details = undefined) {
  if (!registeredCodes.has(code)) {
    throw new Error(`unregistered error code "${code}" — WP-03 may not invent codes (see schemas/errors.json)`);
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("error message must be a non-empty string");
  }
  const envelope = {
    code,
    message,
    retryable: registry.codes[code].retryable,
    idempotent_replay: false,
  };
  if (details !== undefined) {
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      throw new TypeError("error details must be an object");
    }
    envelope.details = details;
  }
  return envelope;
}

/** True when `x` is a WP-00 error envelope produced by this factory shape. */
export const isErrorEnvelope = (x) =>
  x !== null && typeof x === "object" && typeof x.code === "string" && registeredCodes.has(x.code);
