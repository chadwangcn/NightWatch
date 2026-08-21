/**
 * NightWatch WP-07 — Error envelope factory (C13 Issue Gateway)
 *
 * Produces WP-00 error envelopes (schemas/error/v1.json) using ONLY codes
 * registered in nightwatch/schemas/errors.json (read-only source of truth).
 * No new codes are ever invented here; `makeError` throws if asked for an
 * unregistered code.
 *
 * Code selection for C13 runtime conditions (registered at WP-00):
 *   - ISS_GATE_FAILED           any of the six §5.9 publish gates rejected the
 *                              draft (evidence completeness / secret scan /
 *                              fingerprint dedup redirect handled separately /
 *                              minimal reproduction / environment scope /
 *                              reviewer) — always with zero GitHub writes
 *   - ISS_DUPLICATE             fingerprint matches an existing open issue;
 *                              new reproduction info is appended as a comment
 *                              instead of creating a new issue (§5.11)
 *   - ISS_IDEMPOTENCY_CONFLICT  publish already executed with this key and a
 *                              different payload, OR the draft was already
 *                              published under a different key (§5.11-8)
 *   - POL_DENIED                policy decision for the publish action is
 *                              denied / missing / expired / scope-mismatched
 *                              (registry semantics explicitly cover the
 *                              publish gate; zero GitHub writes)
 *   - CTL_VALIDATION_FAILED     input payload (draft / finding / comment
 *                              target) failed validation (no dedicated ISS_
 *                              payload-validation code is registered; the
 *                              generic validation-failed code is the closest)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ISSUE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/issue
const SCHEMAS_DIR = join(ISSUE_ROOT, "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const registry = JSON.parse(readFileSync(join(SCHEMAS_DIR, "errors.json"), "utf8"));
const registeredCodes = new Set(Object.keys(registry.codes));

/** All error codes used by this component (every one registered in WP-00 errors.json). */
export const ERROR_CODES = {
  GATE_FAILED: "ISS_GATE_FAILED",
  DUPLICATE: "ISS_DUPLICATE",
  IDEMPOTENCY_CONFLICT: "ISS_IDEMPOTENCY_CONFLICT",
  POLICY_DENIED: "POL_DENIED",
  VALIDATION_FAILED: "CTL_VALIDATION_FAILED",
};

export const isRegisteredCode = (code) => registeredCodes.has(code);

/**
 * Build a WP-00 error envelope.
 * `retryable` comes from the registry default (never invented locally).
 */
export function makeError(code, message, details = undefined, { idempotentReplay = false } = {}) {
  if (!registeredCodes.has(code)) {
    throw new Error(`unregistered error code "${code}" — WP-07 may not invent codes (see schemas/errors.json)`);
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("error message must be a non-empty string");
  }
  const envelope = {
    code,
    message,
    retryable: registry.codes[code].retryable,
    idempotent_replay: Boolean(idempotentReplay),
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
