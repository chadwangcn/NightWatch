/**
 * NightWatch WP-06 — Retention policy (C11, §5.5)
 *
 * P0 scope per WorkRequest: a configurable policy object + a recorded default
 * policy per store. Background cleanup/rotation is explicitly NOT implemented
 * (Non-goal); only the policy evaluation (retain vs delete-eligible) is pure
 * and testable.
 */
export const DEFAULT_RETENTION_POLICY = {
  policy_version: "nw-retention-p0-v1",
  retain_days: 90,
  deletion_strategy: "local-delete",
  applies_to: "sealed-bundles-only",
  cleanup_backend: "none (P0: policy recorded, background cleanup not implemented)",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const toMs = (iso) => Date.parse(iso);

/**
 * Evaluate a retention policy for a sealed bundle.
 * @param {string} sealedAtIso when the bundle was sealed
 * @param {string} nowIso evaluation time
 * @returns {{action: "retain"|"delete-eligible", delete_after_iso: string, retain_days: number, policy_version: string}}
 */
export function evaluateRetention(sealedAtIso, nowIso, policy = DEFAULT_RETENTION_POLICY) {
  const deleteAfterMs = toMs(sealedAtIso) + policy.retain_days * DAY_MS;
  const action = toMs(nowIso) < deleteAfterMs ? "retain" : "delete-eligible";
  return {
    action,
    delete_after_iso: new Date(deleteAfterMs).toISOString().replace(/\.\d+Z$/, "Z"),
    retain_days: policy.retain_days,
    policy_version: policy.policy_version,
  };
}

/** Serialize the recorded policy for a store (deterministic field order). */
export function retentionPolicyRecord(policy = DEFAULT_RETENTION_POLICY) {
  return {
    policy_version: policy.policy_version,
    retain_days: policy.retain_days,
    deletion_strategy: policy.deletion_strategy,
    applies_to: policy.applies_to,
    cleanup_backend: policy.cleanup_backend,
    note: "P0: policy recorded only; deletion is not executed automatically",
  };
}
