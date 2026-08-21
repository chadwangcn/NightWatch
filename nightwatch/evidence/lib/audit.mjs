/**
 * NightWatch WP-06 — Audit sink over the WP-03 public API (C11/C12 → C14)
 *
 * Key evidence-chain actions (bundle seal, finding classification/aggregation)
 * are recorded as audit events in the SHARED WP-03 store via its public API
 * (openState().audit.record) with deterministic idempotency keys
 * (`<object_id>:<action>`), per WorkRequest §5.5.
 *
 * If the shared store is unavailable (e.g. schema/store failure), the event
 * falls back to a LOCAL append-only log under nightwatch/evidence/.state/ and
 * the fallback is reported to the caller (deviation path, hard constraints §).
 */
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openState } from "../../state/index.mjs";
import { validateAuditEvent } from "./schemas.mjs";

const EVIDENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/evidence
export const LOCAL_FALLBACK_DIR = join(EVIDENCE_ROOT, ".state", "audit-fallback");

/**
 * Create an audit sink bound to a WP-03 store (default: the shared store at
 * nightwatch/state/.store).
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
     * @returns {{ok: boolean, idempotent_replay?: boolean, fallback?: boolean, audit_id?: string, error?: object}}
     */
    record({ actor, action, objectType, objectId, timestamp, idempotencyKey }) {
      const event = {
        actor,
        action,
        target: { object_type: objectType, object_id: objectId },
        timestamp,
        idempotency_key: idempotencyKey,
      };
      const schemaCheck = validateAuditEvent({ audit_id: "audit_00000000000000000000000000", ...event });
      if (!schemaCheck.ok) {
        // Malformed audit payload: do NOT write anywhere; surface the error.
        return { ok: false, error: { code: "AUD_SCHEMA", message: schemaCheck.errors.join("; ") } };
      }
      try {
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
