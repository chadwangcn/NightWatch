/**
 * NightWatch WP-04 — Error envelopes (C04 Policy and Approval Gate + C08 Credential Broker)
 *
 * Every error envelope is produced through the WP-03 public error factory
 * (nightwatch/state/index.mjs → makeError), which enforces that ONLY codes
 * registered in the FROZEN WP-00 registry (nightwatch/schemas/errors.json)
 * can ever be emitted. This package never invents error codes.
 *
 * Code selection for C04/C08 runtime conditions (all registered at WP-00):
 *   - POL_DENIED               policy denial: production × forbidden capability,
 *                              production read-only smoke without explicit
 *                              allowance, missing/denied approval, capability
 *                              not granted by the environment definition,
 *                              lease misuse (unknown/revoked/consumed), and the
 *                              FORBIDDEN credential-enumeration surface (§13.1.1)
 *   - POL_APPROVAL_EXPIRED     required approval record expired (never auto-extended, §22.5.4)
 *   - POL_BUDGET_EXCEEDED      request/duration/parallelism budget exceeded (§12.3)
 *   - CRED_MISSING             referenced credential not configured — reference NAME only (§13.1.1)
 *   - CRED_LEASE_EXPIRED       injection lease expired (never auto-extended, §22.5.4)
 *   - CTL_IDEMPOTENCY_CONFLICT same decision_id replayed with a different payload
 *   - CTL_VALIDATION_FAILED    input failed schema/contract validation
 */
import { makeError as stateMakeError, isRegisteredCode } from "../../state/index.mjs";

export const ERROR_CODES = {
  POL_DENIED: "POL_DENIED",
  POL_APPROVAL_EXPIRED: "POL_APPROVAL_EXPIRED",
  POL_BUDGET_EXCEEDED: "POL_BUDGET_EXCEEDED",
  CRED_MISSING: "CRED_MISSING",
  CRED_LEASE_EXPIRED: "CRED_LEASE_EXPIRED",
  CTL_IDEMPOTENCY_CONFLICT: "CTL_IDEMPOTENCY_CONFLICT",
  CTL_VALIDATION_FAILED: "CTL_VALIDATION_FAILED",
};

export const makeError = stateMakeError;
export { isRegisteredCode };
