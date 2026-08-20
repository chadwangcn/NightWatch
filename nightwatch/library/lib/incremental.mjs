/**
 * NightWatch WP-02 — Incremental preservation engine (WorkRequest §5.3, hard requirement).
 *
 * Regeneration after a spec change is ADD-ONLY at the physical level:
 *   - a case whose deterministic id already exists is RETAINED — its stored
 *     object (and its reviewed/validated/active status) is never touched;
 *   - a NEW case that lands on an existing SLOT (api + endpoint + case type +
 *     variant) with a different content signature marks the old case
 *     `deprecated` with a reason and a supersede link (recorded, not silent);
 *   - generated cases whose endpoint disappeared are deprecated
 *     ("endpoint-removed") but never deleted;
 *   - manual/protected cases are never auto-deprecated and never removed;
 *   - every regeneration emits a machine-readable change report
 *     (added / deprecated / retained counts).
 */
import { contentChecksum } from "./ids.mjs";

const slotKey = (slot) => `${slot.api_id}|${slot.endpoint_key}|${slot.case_type}|${slot.variant}`;

/**
 * @param {import("./store.mjs").LibraryStore} store
 * @param {{apiId: string, toRevision: string, newCases: Array<{case: object, meta: object, dataset: object|null}>,
 *          currentEndpointKeys: string[]}} input
 * @returns {object} change report (machine-readable)
 */
export function applyIncremental(store, { apiId, toRevision, newCases, currentEndpointKeys }) {
  const apiIndex = store.getApiIndex(apiId);
  const existingIds = apiIndex ? apiIndex.case_ids || [] : [];

  const existing = existingIds.map((id) => ({ case: store.getCase(id), meta: store.getMeta(id) })).filter((e) => e.case && e.meta);
  const existingById = new Map(existing.map((e) => [e.case.case_id, e]));
  const existingBySlot = new Map();
  for (const e of existing) {
    if (e.meta.slot) existingBySlot.set(slotKey(e.meta.slot), e);
  }
  const currentEndpoints = new Set(currentEndpointKeys);

  const added = [];
  const deprecated = [];
  const retained = [];
  const supersededOldIds = new Set();

  const persistDataset = (cand) => {
    if (!cand.dataset || cand.dataset.content === undefined) return;
    for (const step of cand.case.steps || []) {
      if (!step.request.body_ref) continue;
      const ref = step.request.body_ref === "__SELF__" ? `${cand.case.case_id}.json` : step.request.body_ref;
      store.saveDataset(apiId, ref, cand.dataset.content);
    }
  };

  for (const cand of newCases) {
    const id = cand.case.case_id;
    const prior = existingById.get(id);
    if (prior) {
      // Same deterministic id ⇒ same content signature ⇒ retain untouched
      // (preserves reviewed/validated/active status and manual edits).
      retained.push({ case_id: id, status: prior.case.status, origin: prior.meta.origin });
      persistDataset(cand); // byte-identical rewrite
      continue;
    }
    // New id: does it supersede an old case on the same slot?
    const slotPrev = cand.meta.slot ? existingBySlot.get(slotKey(cand.meta.slot)) : null;
    const signature = contentChecksum({
      title: cand.case.title,
      steps: cand.case.steps,
      assertions: cand.case.assertions,
      risk: cand.case.risk,
    });
    added.push({
      case_id: id,
      slot: cand.meta.slot,
      signature,
      ...(slotPrev ? { supersedes: slotPrev.case.case_id } : {}),
    });
    store.saveCase(cand.case);
    store.saveMeta(cand.meta);
    persistDataset(cand);
    if (slotPrev && slotPrev.meta.origin !== "manual") {
      // Retire the old case on this slot (recorded supersede, never deleted).
      const dep = deprecate(store, slotPrev.case.case_id, "spec-changed: the generated contract for this slot changed", id);
      if (dep) {
        deprecated.push(dep);
        supersededOldIds.add(slotPrev.case.case_id);
      }
    }
  }

  // Generated cases no longer produced: deprecate (endpoint removed / dropped),
  // unless already superseded above. Manual cases are protected.
  const newIds = new Set(newCases.map((c) => c.case.case_id));
  for (const e of existing) {
    if (newIds.has(e.case.case_id) || supersededOldIds.has(e.case.case_id)) continue;
    if (e.meta.origin === "manual") {
      retained.push({ case_id: e.case.case_id, status: e.case.status, origin: "manual" });
      continue;
    }
    const reason = currentEndpoints.has(e.meta.endpoint && e.meta.endpoint.key)
      ? "no-longer-generated: the generation rules no longer produce this variant"
      : "endpoint-removed: the endpoint is no longer part of the API inventory";
    const dep = deprecate(store, e.case.case_id, reason, null);
    if (dep) deprecated.push(dep);
  }

  const report = {
    api_id: apiId,
    from_revision: apiIndex ? apiIndex.revision || null : null,
    to_revision: toRevision,
    added: added.map((a) => ({ case_id: a.case_id, ...(a.supersedes ? { supersedes: a.supersedes } : {}) })),
    deprecated: deprecated.sort((a, b) => (a.case_id < b.case_id ? -1 : 1)),
    retained: retained.sort((a, b) => (a.case_id < b.case_id ? -1 : 1)),
    counts: {
      added: added.length,
      deprecated: deprecated.length,
      retained: retained.length,
      retained_manual: retained.filter((r) => r.origin === "manual").length,
    },
    policy: "add-only: no case file is ever deleted by regeneration",
  };
  return report;
}

/** Mark one stored case deprecated (lifecycle transition with recorded reason). */
function deprecate(store, caseId, reason, supersededBy) {
  const oneCase = store.getCase(caseId);
  if (!oneCase || oneCase.status === "deprecated") return null;
  const from = oneCase.status;
  oneCase.status = "deprecated";
  store.saveCase(oneCase);
  const meta = store.getMeta(caseId);
  meta.transitions = meta.transitions || [];
  meta.transitions.push({
    from,
    to: "deprecated",
    reason,
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    actor: "incremental-regeneration",
  });
  meta.deprecated = { reason, superseded_by: supersededBy || null, at_revision: oneCase.provenance.source_revision };
  store.saveMeta(meta);
  return { case_id: caseId, reason, superseded_by: supersededBy || null };
}
