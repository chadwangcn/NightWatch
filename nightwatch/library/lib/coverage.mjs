/**
 * NightWatch WP-02 — Coverage matrix (architecture §5.4 item 5, WorkRequest §5.4).
 *
 * Machine-readable endpoint × case-type matrix:
 *   - one row per endpoint in the CURRENT API inventory (sorted);
 *   - one cell per baseline case type (functional/schema/negative/boundary/auth
 *     + business for agent-fixture cases), listing the case ids in that cell;
 *   - uncovered_endpoints: endpoints with zero generated cases, with the
 *     reason (e.g. paused for human confirmation — §5.4 destructive-side-effect
 *     rule) — these are the coverage gaps requiring a decision;
 *   - empty_cells: per-endpoint missing case types (informational gaps such as
 *     $ref-only bodies where field-level schema rules are unavailable).
 */
const MATRIX_CASE_TYPES = ["functional", "schema", "negative", "boundary", "auth", "business"];

/**
 * @param {object} understanding output of understandApi()
 * @param {Array<{case: object, meta: object}>} acceptedCases reviewer-accepted cases
 * @param {Array<{method: string, path: string, reason: string}>} exclusions agent-fixture exclusions
 */
export function buildCoverageMatrix(understanding, acceptedCases, exclusions) {
  const excludedKeys = new Set(exclusions.map((e) => `${e.method} ${e.path}`));
  const rows = [];
  const uncovered = [];

  // Index cases by endpoint key.
  const byEndpoint = new Map();
  for (const cand of acceptedCases) {
    const key = cand.meta.endpoint && cand.meta.endpoint.key;
    if (!key) continue;
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push(cand);
  }

  for (const ep of understanding.endpoints) {
    const endpointCases = byEndpoint.get(ep.key) || [];
    const cells = {};
    let total = 0;
    for (const type of MATRIX_CASE_TYPES) {
      const ids = endpointCases.filter((c) => c.case.type === type).map((c) => c.case.case_id).sort();
      cells[type] = ids;
      total += ids.length;
    }
    rows.push({
      endpoint_key: ep.key,
      method: ep.method,
      path: ep.path,
      risk: ep.risk,
      cells,
      total_cases: total,
    });
    if (total === 0) {
      const exclusion = exclusions.find((e) => `${e.method} ${e.path}` === ep.key);
      uncovered.push({
        method: ep.method,
        path: ep.path,
        reason: exclusion
          ? `excluded by the Test Library Generator: ${exclusion.reason}`
          : "no cases generated (endpoint not compilable from the inventory)",
      });
    }
  }

  const emptyCells = [];
  for (const row of rows) {
    for (const type of MATRIX_CASE_TYPES) {
      if (row.cells[type].length === 0 && row.total_cases > 0) {
        emptyCells.push({ endpoint_key: row.endpoint_key, case_type: type });
      }
    }
  }

  return {
    api_id: understanding.api_id,
    source_revision: understanding.source_revision,
    case_types: MATRIX_CASE_TYPES,
    rows,
    uncovered_endpoints: uncovered,
    empty_cells: emptyCells,
    summary: {
      endpoints: rows.length,
      covered: rows.length - uncovered.length,
      uncovered: uncovered.length,
      cases_total: acceptedCases.length,
    },
  };
}
