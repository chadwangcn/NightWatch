/**
 * NightWatch WP-02 — Generation pipeline orchestration (architecture §5.4).
 *
 *   API Intake → API Understanding → Capability/Resource Graph
 *   → Risk & Coverage Model → Test Plan → Case Generation
 *   → Reviewer (static) → Dry Run placeholder (cases stay draft)
 *   → Library Update (incremental preservation + coverage matrix)
 *
 * Inputs are WP-01 products (inventory + normalized IR) plus the Agent
 * Output Fixture (fixed synthetic stand-in for the real Agent reasoning —
 * WorkRequest §5.2). The pipeline is fully deterministic: no wall clock,
 * no randomness, sorted traversals everywhere.
 */
import { deriveId, contentChecksum } from "./ids.mjs";
import { understandApi } from "./understand.mjs";
import { generateLibraryAssets } from "./generate.mjs";
import { reviewCases } from "./review.mjs";
import { applyIncremental } from "./incremental.mjs";
import { buildCoverageMatrix } from "./coverage.mjs";

/**
 * Normalize a manual-case fixture into a pipeline candidate.
 * The deterministic id keeps manual cases stable across regenerations
 * (same content ⇒ same id ⇒ retained, never re-derived differently).
 */
function manualCandidate(fixture, understanding) {
  const oneCase = JSON.parse(JSON.stringify(fixture.case));
  const meta = JSON.parse(JSON.stringify(fixture.meta));
  meta.api_id = understanding.api_id;
  if (oneCase.provenance.source_revision === "assigned-at-intake") {
    oneCase.provenance.source_revision = understanding.source_revision;
  }
  const slot = {
    api_id: understanding.api_id,
    endpoint_key: meta.endpoint.key,
    case_type: meta.case_type,
    variant: meta.variant,
  };
  const signature = contentChecksum({
    title: oneCase.title,
    steps: oneCase.steps,
    assertions: oneCase.assertions,
    risk: oneCase.risk,
    dataset: null, // manual fixtures carry no pipeline dataset
  });
  oneCase.case_id = deriveId("case", { ...slot, signature });
  meta.case_id = oneCase.case_id;
  meta.slot = slot;
  return { case: oneCase, meta, slot, dataset: null };
}

/**
 * Run the full library pipeline for one API.
 *
 * @param {import("./store.mjs").LibraryStore} store
 * @param {{apiId: string, inventory: object, normalized: object,
 *          agentOutput?: object|null, agentDatasets?: object,
 *          manualCases?: Array<object>}} input
 * @returns {{ok: true, steps: Array, understanding: object, plan: object,
 *            scenarios: Array, review: object, report: object, coverage: object}
 *          | {ok: false, error: object, steps: Array}}
 */
export function runLibraryPipeline(store, { apiId, inventory, normalized, agentOutput = null, agentDatasets = {}, manualCases = [] }) {
  const steps = [];
  const step = (name, data) => steps.push({ step: name, ...data });

  /* 1. API Intake — WP-01 products must agree on identity and revision. */
  if (!inventory || inventory.api_id !== apiId || !normalized || normalized.api_id !== apiId) {
    step("api_intake", { failed: true, reason: "inventory/normalized api_id mismatch" });
    return { ok: false, error: { code: "LIB_CASE_INVALID", message: `intake products do not match apiId ${apiId}` }, steps };
  }
  if (inventory.source.revision !== normalized.source_pin.revision) {
    step("api_intake", { failed: true, reason: "inventory/normalized revision mismatch" });
    return { ok: false, error: { code: "LIB_CASE_INVALID", message: "inventory and normalized IR revisions disagree" }, steps };
  }
  step("api_intake", { api_id: apiId, revision: inventory.source.revision, endpoints: inventory.summary.total });

  /* 2. API Understanding. */
  const understanding = understandApi(normalized);
  step("api_understanding", {
    endpoints: understanding.endpoints.length,
    security_schemes: Object.keys(understanding.security_schemes).sort(),
  });

  /* 3. Capability/Resource Graph (P0 placeholder layer — no Suite objects). */
  step("capability_graph", {
    capabilities: understanding.capabilities.map((c) => c.name),
    note: "P0: capability grouping is informational; Suite layer passes through to Scenario/Case",
  });

  /* 4. Risk & Coverage Model. */
  const riskCounts = { high: 0, medium: 0, low: 0 };
  for (const ep of understanding.endpoints) riskCounts[ep.risk] += 1;
  step("risk_coverage_model", { risk_counts: riskCounts, case_types: ["functional", "schema", "negative", "boundary", "auth"] });

  /* 5+6. Test Plan + Case Generation (plan references the generated case set). */
  const assets = generateLibraryAssets(understanding, agentOutput, agentDatasets);
  const byType = {};
  for (const g of assets.generated) byType[g.case.type] = (byType[g.case.type] || 0) + 1;
  step("test_plan", { plan_id: assets.plan.plan_id });
  step("case_generation", { generated: assets.generated.length, by_type: byType, agent_scenarios: assets.scenarios.length });

  /* 7. Reviewer — static checks (schema/DSL/duplicates/executability). */
  const manualCandidates = manualCases.map((f) => manualCandidate(f, understanding));
  const review = reviewCases([...assets.generated, ...manualCandidates]);
  step("reviewer", { accepted: review.accepted.length, rejected: review.rejected.length });

  // Scenario and plan assets may only reference cases the reviewer ACCEPTED:
  // content-duplicate candidates (e.g. the same method-not-allowed request
  // generated from two endpoints on one path) are rejected before persistence
  // and must not be referenced by stored scenarios/plans.
  const acceptedIds = new Set(review.accepted.map((c) => c.case.case_id));
  for (const s of assets.scenarios) {
    s.scenario.case_ids = s.scenario.case_ids.filter((id) => acceptedIds.has(id));
  }
  for (const row of assets.plan.coverage_matrix) {
    row.case_ids = row.case_ids.filter((id) => acceptedIds.has(id));
  }

  /* 8. Dry Run placeholder — execution is WP-05; generated cases stay draft. */
  step("dry_run", {
    executed: false,
    note: "Dry Run & Case Repair belong to WP-05; generated cases enter the library as draft",
  });

  /* 9. Library Update — incremental preservation + coverage + change report. */
  const acceptedGenerated = review.accepted.filter((c) => c.meta.origin !== "manual");
  const report = applyIncremental(store, {
    apiId,
    toRevision: understanding.source_revision,
    newCases: review.accepted,
    currentEndpointKeys: understanding.endpoints.map((e) => e.key),
  });

  store.savePlan(assets.plan);
  for (const s of assets.scenarios) store.saveScenario(s.scenario);

  const coverage = buildCoverageMatrix(understanding, acceptedGenerated, assets.exclusions);
  store.saveCoverage(apiId, coverage);

  const seq = store.nextChangeSeq(apiId);
  store.saveChangeReport(apiId, seq, report);

  store.updateApiIndex(apiId, {
    revision: understanding.source_revision,
    plan_id: assets.plan.plan_id,
    scenario_ids: assets.scenarios.map((s) => s.scenario.scenario_id),
    case_ids: store.listCaseIds().filter((id) => {
      const meta = store.getMeta(id);
      return meta && meta.api_id === apiId;
    }),
    change_reports: seq,
  });

  step("library_update", {
    added: report.counts.added,
    deprecated: report.counts.deprecated,
    retained: report.counts.retained,
    coverage: coverage.summary,
  });

  return {
    ok: true,
    steps,
    understanding,
    plan: assets.plan,
    scenarios: assets.scenarios.map((s) => s.scenario),
    review,
    report,
    coverage,
    exclusions: assets.exclusions,
  };
}
