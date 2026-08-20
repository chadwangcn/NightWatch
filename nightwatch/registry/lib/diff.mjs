/**
 * NightWatch WP-01 — Endpoint-level diff between two normalized specs.
 *
 * Compares the CURRENT valid IR against the PREVIOUS valid IR and emits a
 * machine-readable change receipt (architecture §9 / §9.1 rules 6 & 7):
 *   - endpoints added / removed / modified (with per-field change kinds);
 *   - destructive flag: removed endpoints, removed response statuses, or newly
 *     mandatory request fields (breaking changes trigger regression impact);
 *   - security_changed flag: security scheme set changes or per-endpoint security
 *     requirement changes (trigger auth test review).
 *
 * UNTRUSTED fields (description / example payloads) are deliberately NOT diffed:
 * spec text is untrusted data and must never drive test-asset regeneration.
 */

/** Copy a parameter without its untrusted example payload. */
const stripUntrustedParam = (p) => {
  if (!p) return p;
  const { example, ...rest } = p;
  return rest;
};

const stableString = (v) => JSON.stringify(v);

function diffParameters(prev, next) {
  const a = (prev || []).map(stripUntrustedParam).map(stableString);
  const b = (next || []).map(stripUntrustedParam).map(stableString);
  return !(a.length === b.length && a.every((x, i) => x === b[i]));
}

function diffRequestBody(prev, next, out) {
  if (stableString(prev || null) === stableString(next || null)) return;
  const prevRequired = (prev && prev.required_fields) || [];
  const nextRequired = (next && next.required_fields) || [];
  const addedFields = nextRequired.filter((f) => !prevRequired.includes(f));
  if (next && addedFields.length > 0) {
    out.push("request_body_required_field_added");
  }
  out.push("request_body");
}

function diffResponses(prev, next, out) {
  const a = prev || {};
  const b = next || {};
  const removedStatuses = Object.keys(a).filter((s) => !(s in b));
  if (removedStatuses.length > 0) out.push("response_removed");
  for (const s of Object.keys(a)) {
    if (s in b && stableString(a[s]) !== stableString(b[s])) out.push("response_schema");
  }
  if (Object.keys(b).some((s) => !(s in a))) out.push("response_added");
}

/**
 * @param {object} prevIR previous VALID normalized spec (null for the initial import)
 * @param {object} nextIR current normalized spec
 * @returns {object} machine-readable diff receipt
 */
export function diffNormalized(prevIR, nextIR) {
  const targetRevision = nextIR.source_pin.revision;
  if (!prevIR) {
    return {
      initial: true,
      base_revision: null,
      target_revision: targetRevision,
      endpoints: {
        added: nextIR.endpoints.map((e) => e.key),
        removed: [],
        modified: [],
      },
      security_schemes: { added: Object.keys(nextIR.security_schemes), removed: [], changed: [] },
      security_changed: false,
      security_changed_endpoints: [],
      destructive: false,
      destructive_reasons: [],
      untrusted_fields_not_diffed: true,
    };
  }

  const prevByKey = new Map(prevIR.endpoints.map((e) => [e.key, e]));
  const nextByKey = new Map(nextIR.endpoints.map((e) => [e.key, e]));
  const allKeys = [...new Set([...prevByKey.keys(), ...nextByKey.keys()])].sort();

  const added = [];
  const removed = [];
  const modified = [];
  const destructiveReasons = [];
  const securityChangedEndpoints = [];

  for (const key of allKeys) {
    const prev = prevByKey.get(key);
    const next = nextByKey.get(key);
    if (prev && !next) {
      removed.push(key);
      destructiveReasons.push(`endpoints_removed: ${key}`);
      continue;
    }
    if (!prev && next) {
      added.push(key);
      continue;
    }
    const changes = [];
    if (stableString(prev.security) !== stableString(next.security)) {
      changes.push("security");
      securityChangedEndpoints.push(key);
    }
    if (prev.operation_id !== next.operation_id) changes.push("operation_id");
    if (diffParameters(prev.parameters, next.parameters)) changes.push("parameters");
    diffRequestBody(prev.request_body, next.request_body, changes);
    diffResponses(prev.responses, next.responses, changes);
    if (changes.length > 0) {
      modified.push({ key, changes: [...new Set(changes)].sort() });
    }
  }

  // Per-change destructive detail extraction.
  for (const m of modified) {
    const prev = prevByKey.get(m.key);
    const next = nextByKey.get(m.key);
    if (m.changes.includes("response_removed")) {
      const lost = Object.keys(prev.responses).filter((s) => !(s in next.responses)).sort();
      destructiveReasons.push(`response_status_removed: ${m.key} lost [${lost.join(", ")}]`);
    }
    if (m.changes.includes("request_body_required_field_added")) {
      const prevRequired = (prev.request_body && prev.request_body.required_fields) || [];
      const nextRequired = (next.request_body && next.request_body.required_fields) || [];
      const addedFields = nextRequired.filter((f) => !prevRequired.includes(f));
      destructiveReasons.push(`request_required_field_added: ${m.key} now requires [${addedFields.join(", ")}]`);
    }
  }

  // Security scheme set comparison.
  const prevSchemes = prevIR.security_schemes || {};
  const nextSchemes = nextIR.security_schemes || {};
  const schemeAdded = Object.keys(nextSchemes).filter((s) => !(s in prevSchemes)).sort();
  const schemeRemoved = Object.keys(prevSchemes).filter((s) => !(s in nextSchemes)).sort();
  const schemeChanged = Object.keys(nextSchemes)
    .filter((s) => s in prevSchemes && stableString(prevSchemes[s]) !== stableString(nextSchemes[s]))
    .sort();

  const securityChanged = schemeAdded.length > 0 || schemeRemoved.length > 0 || schemeChanged.length > 0 || securityChangedEndpoints.length > 0;

  return {
    initial: false,
    base_revision: prevIR.source_pin.revision,
    target_revision: targetRevision,
    endpoints: { added, removed, modified },
    security_schemes: { added: schemeAdded, removed: schemeRemoved, changed: schemeChanged },
    security_changed: securityChanged,
    security_changed_endpoints: securityChangedEndpoints.sort(),
    destructive: removed.length > 0 || destructiveReasons.length > 0,
    destructive_reasons: destructiveReasons.sort(),
    untrusted_fields_not_diffed: true,
  };
}
