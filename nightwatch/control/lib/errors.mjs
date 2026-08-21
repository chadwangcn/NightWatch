/**
 * NightWatch WP-08 — Error envelope factory (C02 Control API)
 *
 * Produces WP-00 error envelopes (schemas/error/v1.json) using ONLY codes
 * registered in nightwatch/schemas/errors.json (read-only source of truth).
 * No new codes are invented here; `makeError` throws for unregistered codes.
 *
 * Codes used by C02/C03 (all registered at WP-00):
 *   - CTL_VALIDATION_FAILED     command envelope / payload failed schema
 *   - CTL_IDEMPOTENCY_CONFLICT  same command_id replayed with a different payload
 *   - CTL_COMMAND_TIMEOUT       deadline exceeded before execution
 *   - CTL_COMMAND_CANCELLED     command-level cancellation semantics
 *   - CTL_UNAUTHORIZED          caller not authorized for the operation
 *
 * Component errors (EXE_*, EVD_*, ISS_*, POL_*, REG_*, LIB_*, FND_*) are
 * passed through UNCHANGED (§5.5 fault isolation: the orchestrator never
 * swallows or rewrites component verdicts).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS_DIR = join(CONTROL_ROOT, "..", "schemas");

const registry = JSON.parse(readFileSync(join(SCHEMAS_DIR, "errors.json"), "utf8"));
const registeredCodes = new Set(Object.keys(registry.codes));

export const ERROR_CODES = {
  IDEMPOTENCY_CONFLICT: "CTL_IDEMPOTENCY_CONFLICT",
  VALIDATION_FAILED: "CTL_VALIDATION_FAILED",
  UNAUTHORIZED: "CTL_UNAUTHORIZED",
  COMMAND_TIMEOUT: "CTL_COMMAND_TIMEOUT",
  COMMAND_CANCELLED: "CTL_COMMAND_CANCELLED",
  LOCK_EXPIRED: "CTL_LOCK_EXPIRED",
};

export const isRegisteredCode = (code) => registeredCodes.has(code);

export function makeError(code, message, details = undefined, { idempotentReplay = false } = {}) {
  if (!registeredCodes.has(code)) {
    throw new Error(`unregistered error code "${code}" — WP-08 may not invent codes (see schemas/errors.json)`);
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("error message must be a non-empty string");
  }
  const envelope = {
    code,
    message,
    retryable: registry.codes[code].retryable,
    idempotent_replay: idempotentReplay,
  };
  if (details !== undefined) {
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      throw new TypeError("error details must be an object");
    }
    envelope.details = details;
  }
  return envelope;
}

export const isErrorEnvelope = (x) =>
  x !== null && typeof x === "object" && typeof x.code === "string" && registeredCodes.has(x.code);
