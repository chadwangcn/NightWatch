/**
 * NightWatch WP-01 — Impact analysis for a diff between two valid spec versions.
 *
 * Maps every changed endpoint to its associated test plans / scenarios / cases
 * (Registry-internal associations; P0 consumes the synthetic impact-links fixture,
 * real associations are established by WP-02) and derives the required reviews:
 *   - regression-review when the diff is destructive (§9.1 rule 6);
 *   - auth-review when security schemes changed (§9.1 rule 7).
 * Newly added endpoints surface as uncovered (§9.1 rule 5).
 */

const linkIndex = (links) => {
  const idx = new Map();
  for (const l of links || []) {
    idx.set(`${l.api_id} ${l.method} ${l.path}`, {
      plans: [...(l.plans || [])],
      scenarios: [...(l.scenarios || [])],
      cases: [...(l.cases || [])],
    });
  }
  return idx;
};

/**
 * @param {{apiId: string, diff: object, links: Array}} input
 * @returns {object} machine-readable impact receipt
 */
export function analyzeImpact({ apiId, diff, links }) {
  const idx = linkIndex(links);
  const lookup = (method, path) => idx.get(`${apiId} ${method} ${path}`) || { plans: [], scenarios: [], cases: [] };

  const parseKey = (key) => {
    const space = key.indexOf(" ");
    return { method: key.slice(0, space), path: key.slice(space + 1) };
  };

  const impacted = [];
  for (const key of diff.endpoints.added) {
    const { method, path } = parseKey(key);
    const assoc = lookup(method, path);
    impacted.push({ method, path, change: "added", ...assoc, associated: assoc.plans.length + assoc.scenarios.length + assoc.cases.length > 0 });
  }
  for (const key of diff.endpoints.removed) {
    const { method, path } = parseKey(key);
    const assoc = lookup(method, path);
    impacted.push({ method, path, change: "removed", ...assoc, associated: assoc.plans.length + assoc.scenarios.length + assoc.cases.length > 0 });
  }
  for (const m of diff.endpoints.modified) {
    const { method, path } = parseKey(m.key);
    const assoc = lookup(method, path);
    impacted.push({
      method,
      path,
      change: "modified",
      changes: m.changes,
      ...assoc,
      associated: assoc.plans.length + assoc.scenarios.length + assoc.cases.length > 0,
    });
  }
  impacted.sort((a, b) => (a.method + a.path < b.method + b.path ? -1 : a.method + a.path > b.method + b.path ? 1 : a.change < b.change ? -1 : 1));

  const reviews = [];
  if (diff.destructive) {
    reviews.push(`regression-review: destructive changes detected (${diff.destructive_reasons.length} reason(s))`);
  }
  if (diff.security_changed) {
    const schemeBits = [
      diff.security_schemes.added.length > 0 ? `schemes added: [${diff.security_schemes.added.join(", ")}]` : null,
      diff.security_schemes.removed.length > 0 ? `schemes removed: [${diff.security_schemes.removed.join(", ")}]` : null,
      diff.security_changed_endpoints.length > 0 ? `endpoints: [${diff.security_changed_endpoints.join(", ")}]` : null,
    ].filter(Boolean);
    reviews.push(`auth-review: security scheme changes detected (${schemeBits.join("; ")})`);
  }

  return {
    api_id: apiId,
    base_revision: diff.base_revision,
    target_revision: diff.target_revision,
    impacted,
    uncovered_new_endpoints: diff.endpoints.added.map((key) => parseKey(key)),
    reviews_required: reviews,
    destructive: diff.destructive,
    security_changed: diff.security_changed,
  };
}
