/**
 * NightWatch WP-08 — Session state machine + store (C03, §7.2)
 *
 * The transition matrix mirrors the WP-00 sessionStateChanged/v1.json
 * if/then matrix EXACTLY (frozen contract — do not widen it here):
 *
 *   discovery → library_draft → library_review → environment_ready → running
 *   running → {analyzing, blocked};  blocked → running
 *   analyzing → issue_review;  issue_review → {published, inconclusive}
 *   published → retest_pending;  inconclusive → retest_pending
 *   retest_pending → closed;  closed is terminal (no outgoing transitions)
 *
 * Semantics:
 *   - legal transition → session updated (updated_at) + sessionStateChanged
 *     event emitted through the bus;
 *   - illegal transition → CTL_VALIDATION_FAILED, session state UNCHANGED;
 *   - state=blocked REQUIRES a non-empty blocked_reason (WP-00 session
 *     schema enforces it; entering/leaving blocked manages the field);
 *   - session objects are schema-validated on every persist.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSession } from "./schemas.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";

export const LEGAL_TRANSITIONS = Object.freeze({
  discovery: ["library_draft"],
  library_draft: ["library_review"],
  library_review: ["environment_ready"],
  environment_ready: ["running"],
  running: ["analyzing", "blocked"],
  blocked: ["running"],
  analyzing: ["issue_review"],
  issue_review: ["published", "inconclusive"],
  published: ["retest_pending"],
  inconclusive: ["retest_pending"],
  retest_pending: ["closed"],
  closed: [],
});

export const isLegalTransition = (fromState, toState) =>
  (LEGAL_TRANSITIONS[fromState] ?? []).includes(toState);

export class SessionStore {
  /**
   * @param {object} options
   *   dir    — persistence directory (one JSON file per session)
   *   events — EventBus (sessionStateChanged emission)
   *   clock  — () => ISO string
   */
  constructor({ dir, events, clock }) {
    this.dir = dir;
    this.events = events;
    this.clock = clock;
    mkdirSync(dir, { recursive: true });
  }

  #path(sessionId) {
    return join(this.dir, `${sessionId}.json`);
  }

  /** Persist a session (schema-validated; atomic tmp+rename). */
  save(session) {
    const check = validateSession(session);
    if (!check.ok) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, "session failed the WP-00 schema", {
          reason: "session_schema",
          errors: check.errors,
        }),
      };
    }
    const target = this.#path(session.session_id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
    return { ok: true, session };
  }

  load(sessionId) {
    const p = this.#path(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  }

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(this.dir, n), "utf8")))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }

  /**
   * Apply ONE legal transition to a session.
   * @returns {{ok: true, session: object} | {ok: false, error: object}}
   *   Illegal transitions leave the persisted session unchanged.
   */
  transition(session, toState, reason = "") {
    if (!isLegalTransition(session.state, toState)) {
      return {
        ok: false,
        error: makeError(
          ERROR_CODES.VALIDATION_FAILED,
          `illegal session state transition ${session.state} → ${toState} (rejected; session state unchanged)`,
          { reason: "illegal_transition", from_state: session.state, to_state: toState },
        ),
      };
    }
    const next = {
      ...session,
      state: toState,
      updated_at: this.clock(),
    };
    if (toState === "blocked") {
      if (typeof reason !== "string" || reason.length === 0) {
        return {
          ok: false,
          error: makeError(ERROR_CODES.VALIDATION_FAILED, "entering blocked requires a non-empty blocked_reason", {
            reason: "blocked_reason_required",
          }),
        };
      }
      next.blocked_reason = reason;
    } else {
      delete next.blocked_reason;
    }
    const emitted = this.events.emit("sessionStateChanged", {
      object_id: session.session_id,
      object_type: "session",
      payload: { from_state: session.state, to_state: toState, ...(reason ? { reason } : {}) },
    });
    if (!emitted.ok) return emitted;
    const saved = this.save(next);
    if (!saved.ok) return saved;
    return { ok: true, session: next };
  }
}
