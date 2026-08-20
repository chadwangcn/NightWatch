/**
 * NightWatch WP-04 — Audit sink (C04/C08 → C14 via WP-03 public API)
 *
 * All policy decisions and credential-lease lifecycle events are recorded as
 * WP-00 audit_event records through the WP-03 public API (openState().audit),
 * proving real integration with the shared append-only audit JSONL.
 *
 * SECURITY: an audit event only ever carries actor / action / target
 * {object_type, object_id} / timestamp / idempotency_key. Reference NAMES and
 * object IDs are auditable; credential VALUES never are (§13.1).
 *
 * Idempotency: policy decisions use decision_id as the audit idempotency key;
 * lease lifecycle events use `<lease_id>:<action>` (WorkRequest §5.2/§5.4).
 */
import { openState } from "../../state/index.mjs";

export const C04_ACTOR = "c04-policy-engine";
export const C08_ACTOR = "c08-credential-broker";

export const POLICY_DECISION_ACTION = "policy.decide";
export const LEASE_ACTIONS = {
  granted: "credential.lease.granted",
  revoked: "credential.lease.revoked",
  materialized: "credential.lease.materialized",
  expired: "credential.lease.expired",
};

export class PolicyAuditSink {
  /**
   * @param {object} [options] {state?} — defaults to the shared WP-03 store
   *        (nightwatch/state/.store); pass openState({storeDir}) for an
   *        isolated store (used by `verify.mjs --store=isolated`).
   */
  constructor(options = {}) {
    this.state = options.state ?? openState();
  }

  /**
   * Append one audit event (idempotent by key; identical payload replays).
   * @returns {{ok:true, idempotent_replay:boolean, audit_id:string} | {ok:false, error:object}}
   */
  append({ actor, action, object_type, object_id, timestamp, idempotency_key }) {
    return this.state.audit.append({
      actor,
      action,
      target: { object_type, object_id },
      timestamp,
      idempotency_key,
    });
  }

  /** All audit events recorded by C04/C08 (reference names / IDs only, never values). */
  queryPolicyEvents() {
    const actors = new Set([C04_ACTOR, C08_ACTOR]);
    return this.state.audit.list().filter((e) => actors.has(e.actor));
  }
}
