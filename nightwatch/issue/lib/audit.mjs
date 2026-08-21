/**
 * NightWatch WP-07 — Audit sink (C13 → C14 via WP-03 public API)
 *
 * Issue-domain state changes (issue publish, dedup comment append, retest
 * comment append) are recorded as WP-00 audit_event records through the
 * WP-03 public API (openState().audit.append / record), per WorkRequest §5.3.
 *
 * SECURITY: an audit event only ever carries actor / action / target
 * {object_type, object_id} / timestamp / idempotency_key. Object IDs and
 * external issue references are auditable; issue bodies / draft contents /
 * credential-shaped material never are (§13.1).
 *
 * Idempotency: the publish idempotency key is the audit idempotency key
 * ("幂等键=审计自身键"); comment appends use `<draft_id>:<action>`-shaped keys.
 *
 * If the shared store is unavailable, the event falls back to a LOCAL
 * append-only log under nightwatch/issue/.state/ and the fallback is
 * reported to the caller (same deviation path as WP-06).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openState } from "../../state/index.mjs";

const ISSUE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/issue
export const LOCAL_FALLBACK_DIR = join(ISSUE_ROOT, ".state", "audit-fallback");

export const C13_ACTOR = "C13-issue-gateway";

export const ISSUE_ACTIONS = {
  publish: "issue.publish",
  dedupComment: "issue.comment.appended.dedup",
  retestComment: "issue.comment.appended.retest",
};

/**
 * Create an audit sink bound to a WP-03 store.
 * @param {object} [options] {storeDir?} — defaults to the shared store at
 *        nightwatch/state/.store; pass an isolated dir for verify runs.
 */
export function makeAuditSink({ storeDir, localFallbackDir = LOCAL_FALLBACK_DIR } = {}) {
  const state = openState(storeDir ? { storeDir } : {});
  const fallback = (event, error) => {
    mkdirSync(localFallbackDir, { recursive: true });
    const path = join(localFallbackDir, "events.jsonl");
    if (!existsSync(path)) writeFileSync(path, "", { flag: "wx" });
    const current = readFileSync(path, "utf8");
    if (current.length > 0 && !current.endsWith("\n")) appendFileSync(path, "\n", "utf8");
    appendFileSync(path, `${JSON.stringify({ ...event, fallback_error: error })}\n`, "utf8");
    return { ok: true, fallback: true, error };
  };
  return {
    storeDir: state.storeDir,
    localFallbackDir,
    /**
     * Record one audit event (idempotent by key).
     * @param {object} event {actor, action, objectType, objectId, timestamp, idempotencyKey}
     * @returns {{ok: boolean, idempotent_replay?: boolean, fallback?: boolean, audit_id?: string, error?: object}}
     */
    record({ actor, action, objectType, objectId, timestamp, idempotencyKey }) {
      const event = {
        actor: actor ?? C13_ACTOR,
        action,
        target: { object_type: objectType, object_id: objectId },
        timestamp,
        idempotency_key: idempotencyKey,
      };
      try {
        // WP-03 append() validates against audit_event/v1.json and is
        // idempotent by key (identical payload → replay, no second line).
        const result = state.audit.record(event);
        if (result.ok) {
          return { ok: true, idempotent_replay: result.idempotent_replay, audit_id: result.audit_id };
        }
        return fallback(event, result.error);
      } catch (err) {
        return fallback(event, { code: "AUD_STORE_UNAVAILABLE", message: String(err && err.message ? err.message : err) });
      }
    },
  };
}
