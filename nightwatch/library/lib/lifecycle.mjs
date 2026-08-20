/**
 * NightWatch WP-02 — Case lifecycle state machine (architecture §5.5, WorkRequest §5.3).
 *
 *   draft → reviewed → validated → active → deprecated
 *
 * Legal transitions (the forward path plus deprecation from any live state —
 * spec changes may retire a case at ANY stage, which is a recorded, non-silent
 * action, never a deletion):
 *
 *   draft     → reviewed | deprecated
 *   reviewed  → validated | deprecated
 *   validated → active | deprecated
 *   active    → deprecated
 *   deprecated→ (terminal)
 *
 * Illegal transitions (skipping or rewinding) are rejected with
 * LIB_CASE_INVALID; unknown cases with LIB_CASE_NOT_FOUND.
 */
import { caseInvalid, caseNotFound } from "./errors.mjs";

export const CASE_STATUSES = ["draft", "reviewed", "validated", "active", "deprecated"];

export const LEGAL_TRANSITIONS = {
  draft: ["reviewed", "deprecated"],
  reviewed: ["validated", "deprecated"],
  validated: ["active", "deprecated"],
  active: ["deprecated"],
  deprecated: [],
};

export const isLegalTransition = (from, to) =>
  Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, from) && LEGAL_TRANSITIONS[from].includes(to);

/**
 * Transition one case to a new lifecycle status.
 * @param {import("./store.mjs").LibraryStore} store
 * @param {string} caseId
 * @param {"reviewed"|"validated"|"active"|"deprecated"} to
 * @param {{reason?: string, superseded_by?: string|null, actor?: string,
 *          last_validated_run?: string|null}} [opts]
 * @returns {{ok: true, case: object} | {ok: false, error: object}}
 */
export function transitionCase(store, caseId, to, opts = {}) {
  const oneCase = store.getCase(caseId);
  if (!oneCase) {
    return { ok: false, error: caseNotFound(`case not found in the library: ${caseId}`, { case_id: caseId }) };
  }
  const from = oneCase.status;
  if (from === to) {
    return { ok: false, error: caseInvalid(`case is already ${from}`, { case_id: caseId, from, to }) };
  }
  if (!CASE_STATUSES.includes(to)) {
    return { ok: false, error: caseInvalid(`unknown target status: ${to}`, { case_id: caseId, from, to }) };
  }
  if (!isLegalTransition(from, to)) {
    return { ok: false, error: caseInvalid(`illegal lifecycle transition ${from} → ${to}`, { case_id: caseId, from, to }) };
  }
  if (to === "deprecated" && (!opts.reason || opts.reason.length === 0)) {
    return { ok: false, error: caseInvalid("deprecating a case requires a reason (no silent retirement)", { case_id: caseId }) };
  }

  oneCase.status = to;
  if (to === "validated" && opts.last_validated_run !== undefined) {
    oneCase.provenance.last_validated_run = opts.last_validated_run;
  }
  store.saveCase(oneCase);

  const meta = store.getMeta(caseId) || { case_id: caseId, flags: [], transitions: [] };
  meta.transitions = meta.transitions || [];
  meta.transitions.push({
    from,
    to,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.superseded_by ? { superseded_by: opts.superseded_by } : {}),
    ...(opts.actor ? { actor: opts.actor } : {}),
  });
  if (to === "deprecated") {
    meta.deprecated = {
      reason: opts.reason,
      superseded_by: opts.superseded_by || null,
      at_revision: oneCase.provenance.source_revision,
    };
  }
  store.saveMeta(meta);
  return { ok: true, case: oneCase };
}

/**
 * Flag a case (e.g. "spec-ambiguity" — WorkRequest §5.3). Flags live in the
 * sidecar meta, NOT in the frozen test_case schema.
 * @param {import("./store.mjs").LibraryStore} store
 * @param {string} caseId
 * @param {string} flag
 * @param {string} [note]
 */
export function flagCase(store, caseId, flag, note) {
  const meta = store.getMeta(caseId);
  if (!meta) {
    return { ok: false, error: caseNotFound(`case not found in the library: ${caseId}`, { case_id: caseId }) };
  }
  meta.flags = meta.flags || [];
  if (!meta.flags.some((f) => f.flag === flag)) {
    meta.flags.push({ flag, ...(note ? { note } : {}) });
  }
  store.saveMeta(meta);
  return { ok: true };
}
