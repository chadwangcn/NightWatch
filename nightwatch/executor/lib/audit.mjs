/**
 * NightWatch WP-05 — Audit sink (C09 → C14 via the WP-03 public API)
 *
 * Execution lifecycle events (submission / start / finish / cancel) are
 * recorded as WP-00 audit_event records through openState().audit — the
 * shared append-only JSONL store (nightwatch/state/.store) — proving real
 * integration with WP-03 (WorkRequest §5.7). An isolated store can be
 * injected for deterministic two-pass verification (`--store=isolated`).
 *
 * SECURITY: an audit event only ever carries actor / action / target
 * {object_type, object_id} / timestamp / idempotency_key. Execution ids,
 * scenario refs and credential reference NAMES are auditable; credential
 * VALUES never are (§13.1).
 *
 * Idempotency (WorkRequest §5.7): the audit key is `<execution_id>:<action>`;
 * identical replays return the previously recorded event with no second write.
 */
import { openState } from "../../state/index.mjs";

export const C09_ACTOR = "c09-executor-gateway";

export const EXECUTION_ACTIONS = {
  submitted: "execution.submitted",
  started: "execution.started",
  finished: "execution.finished",
  cancelled: "execution.cancelled",
};

export class ExecutorAuditSink {
  /**
   * @param {object} [options] {state?} — defaults to the shared WP-03 store
   *        (nightwatch/state/.store); pass openState({storeDir}) for an
   *        isolated store (used by the verifier's deterministic second pass).
   */
  constructor(options = {}) {
    this.state = options.state ?? openState();
  }

  /**
   * Append one execution lifecycle audit event (idempotent by key).
   * @param {{execution_id: string, action: "submitted"|"started"|"finished"|"cancelled", timestamp: string}} input
   * @returns {{ok:true, idempotent_replay:boolean, audit_id:string} | {ok:false, error:object}}
   */
  append({ execution_id, action, timestamp }) {
    return this.state.audit.append({
      actor: C09_ACTOR,
      action: EXECUTION_ACTIONS[action],
      target: { object_type: "execution", object_id: execution_id },
      timestamp,
      idempotency_key: `${execution_id}:${action}`,
    });
  }

  /** All audit events recorded by C09 for one execution (ids only, never values). */
  queryExecutionEvents(executionId) {
    return this.state.audit.list().filter((e) => e.actor === C09_ACTOR && e.target.object_id === executionId);
  }

  /** Count of C09 events currently visible in this store (determinism checks). */
  countC09Events() {
    return this.state.audit.list().filter((e) => e.actor === C09_ACTOR).length;
  }
}
