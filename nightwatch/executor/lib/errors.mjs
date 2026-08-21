/**
 * NightWatch WP-05 — Error envelopes (C09 Executor Gateway + C10 Fixture Coordinator)
 *
 * Every error envelope is produced through the WP-03 public error factory
 * (nightwatch/state/index.mjs → makeError), which enforces that ONLY codes
 * registered in the FROZEN WP-00 registry (nightwatch/schemas/errors.json)
 * can ever be emitted. This package never invents error codes.
 *
 * Code selection for C09/C10 runtime conditions (all registered at WP-00):
 *   - EXE_TIMEOUT              execution exceeded its timeout budget; partial
 *                              results preserved as an independent outcome
 *   - EXE_CANCELLED            execution cancelled: steps stopped → worker
 *                              terminated → bounded cleanup (§22.5.4)
 *   - EXE_WORKER_FAILED        worker failed abnormally (crash/signal)
 *   - EXE_TOOL_VERSION_MISMATCH pinned executor version mismatch
 *   - FIX_SETUP_FAILED         fixture setup through public APIs failed
 *   - FIX_CLEANUP_FAILED       cleanup failed/timed out; residual resources
 *                              recorded as an independent result
 *   - FIX_RESOURCE_LOCKED      shared resource held under an explicit lock
 *   - CTL_VALIDATION_FAILED    request/artifact failed contract validation
 *   - POL_DENIED / POL_BUDGET_EXCEEDED / CRED_MISSING / CRED_LEASE_EXPIRED
 *                              surfaced verbatim from the WP-04 integration
 */
import { makeError as stateMakeError, isRegisteredCode } from "../../state/index.mjs";

export const ERROR_CODES = {
  EXE_TIMEOUT: "EXE_TIMEOUT",
  EXE_CANCELLED: "EXE_CANCELLED",
  EXE_TOOL_VERSION_MISMATCH: "EXE_TOOL_VERSION_MISMATCH",
  EXE_WORKER_FAILED: "EXE_WORKER_FAILED",
  FIX_SETUP_FAILED: "FIX_SETUP_FAILED",
  FIX_CLEANUP_FAILED: "FIX_CLEANUP_FAILED",
  FIX_RESOURCE_LOCKED: "FIX_RESOURCE_LOCKED",
  CTL_VALIDATION_FAILED: "CTL_VALIDATION_FAILED",
  POL_DENIED: "POL_DENIED",
  POL_BUDGET_EXCEEDED: "POL_BUDGET_EXCEEDED",
  CRED_MISSING: "CRED_MISSING",
  CRED_LEASE_EXPIRED: "CRED_LEASE_EXPIRED",
};

export const makeError = stateMakeError;
export { isRegisteredCode };

/** Validation-failed envelope (request/artifact contract violation). */
export const validationFailed = (message, details) => makeError(ERROR_CODES.CTL_VALIDATION_FAILED, message, details);
