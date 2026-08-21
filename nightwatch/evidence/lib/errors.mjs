/**
 * NightWatch WP-06 — Error envelope factory (C11 Evidence Pipeline / C12 Finding Service)
 *
 * Produces WP-00 error envelopes (schemas/error/v1.json) using ONLY codes
 * registered in nightwatch/schemas/errors.json (read-only source of truth).
 * No new codes are ever invented here; `makeError` throws if asked for an
 * unregistered code.
 *
 * Code selection for C11/C12 runtime conditions (registered at WP-00):
 *   - EVD_NOT_SEALED           downstream consumer referenced an unsealed bundle
 *   - EVD_SECRET_DETECTED      secret scan hit blocks seal/publish (exact §5.3 semantics)
 *   - EVD_MANIFEST_INVALID     seal preconditions unmet, manifest invalid, or a write
 *                              that would break sealed manifest/checksum integrity
 *                              (DEVIATION: no dedicated "EVD_SEALED_IMMUTABLE" code is
 *                              registered in errors.json; the closest integrity-protection
 *                              code is reused — see DeliveryNotice §4)
 *   - FND_INSUFFICIENT_EVIDENCE  evidence insufficient to classify (exact §5.4 semantics)
 *   - FND_CLASSIFICATION_INVALID illegal classification for the collected evidence
 *   - CTL_VALIDATION_FAILED    input payload (execution event / observation) failed
 *                              schema validation (DEVIATION: no EVD_/FND_ payload-
 *                              validation code registered; the generic validation-failed
 *                              code is the closest — see DeliveryNotice §4)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EVIDENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/evidence
const SCHEMAS_DIR = join(EVIDENCE_ROOT, "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const registry = JSON.parse(readFileSync(join(SCHEMAS_DIR, "errors.json"), "utf8"));
const registeredCodes = new Set(Object.keys(registry.codes));

/** All error codes used by this component (every one registered in WP-00 errors.json). */
export const ERROR_CODES = {
  NOT_SEALED: "EVD_NOT_SEALED",
  SECRET_DETECTED: "EVD_SECRET_DETECTED",
  MANIFEST_INVALID: "EVD_MANIFEST_INVALID",
  INSUFFICIENT_EVIDENCE: "FND_INSUFFICIENT_EVIDENCE",
  CLASSIFICATION_INVALID: "FND_CLASSIFICATION_INVALID",
  VALIDATION_FAILED: "CTL_VALIDATION_FAILED",
};

export const isRegisteredCode = (code) => registeredCodes.has(code);

/**
 * Build a WP-00 error envelope.
 * `retryable` comes from the registry default (never invented locally).
 */
export function makeError(code, message, details = undefined) {
  if (!registeredCodes.has(code)) {
    throw new Error(`unregistered error code "${code}" — WP-06 may not invent codes (see schemas/errors.json)`);
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
