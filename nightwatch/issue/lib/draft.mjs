/**
 * NightWatch WP-07 — Issue Draft builder (C13, §14 / WorkRequest §5.1)
 *
 * Builds a WP-00 issue_draft/v1 object from a CONFIRMED finding plus its
 * sealed-run evidence. Thirteen fields are mandatory (schema-enforced);
 * `hypothesis` defaults to EMPTY — internal root-cause guesses may only
 * enter a draft through the explicit `overrides.hypothesis` channel and are
 * always rendered in a separated, clearly-disclaimed section (§14.1
 * hypothesis firewall; never stated as fact).
 *
 * `sanitized_evidence` carries Evidence Index references/summaries ONLY
 * (run id + evidence_ref + status/signature summary) — raw request/response
 * payloads are never embedded (they stay in the sealed bundle).
 */
import { validateFinding } from "../../evidence/lib/index.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validateIssueDraft } from "./schemas.mjs";

/** Publish-path classification gate: only confirmed findings may be drafted. */
export const PUBLISHABLE_CLASSIFICATION = "confirmed";

/** Derivation maps for human-readable template fields. */
const ASSERTION_EXPECTATION = {
  "status-code": "the pinned contract requires a 2xx success status for this request",
  "response-schema": "the response body must conform to the schema pinned in the contract revision",
  "error-code": "the documented error-code contract must be honored for invalid requests",
};

const expectationFor = (assertionClass, specRevision) =>
  `${ASSERTION_EXPECTATION[assertionClass] ?? `assertion class "${assertionClass}" must pass`} (spec revision ${specRevision})`;

/**
 * Build an issue draft from a confirmed finding and its run evidence.
 *
 * @param {object} input
 *   finding   — WP-00 finding/v1 object (classification must be `confirmed`)
 *   runs      — [{run_id, manifest(ctx-shaped: environment_name, contract_pin,
 *                scenario_id, deployment_ref, started_at, finished_at,
 *                duration_ms), observations: WP-00 observation[]}]
 *               (the gateway assembles this from the Evidence Index)
 *   ids       — {draftId()} from makeIssueIdFactory
 *   overrides — optional explicit field overrides (e.g. {hypothesis}); the
 *               ONLY channel through which a hypothesis may enter a draft
 * @returns {{ok: true, draft} | {ok: false, error}}
 */
export function buildDraft({ finding, runs, ids, overrides = {} }) {
  if (finding === null || typeof finding !== "object") {
    return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "finding must be an object", { reason: "invalid_finding" }) };
  }
  const schemaCheck = validateFinding(finding);
  if (!schemaCheck.ok) {
    return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "finding failed WP-00 schema validation", { reason: "finding_schema", errors: schemaCheck.errors }) };
  }
  if (finding.classification !== PUBLISHABLE_CLASSIFICATION) {
    return {
      ok: false,
      error: makeError(ERROR_CODES.GATE_FAILED, `only confirmed findings may enter the publish path (got "${finding.classification}")`, {
        gate: "evidence-completeness",
        reason: "finding_not_confirmed",
        finding_id: finding.finding_id,
        classification: finding.classification,
      }),
    };
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "draft generation requires at least one run with evidence for the finding", { reason: "no_run_evidence", finding_id: finding.finding_id }) };
  }
  for (const run of runs) {
    if (!run?.manifest?.environment_name || !run?.manifest?.contract_pin?.source_revision) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `run ${run?.run_id ?? "(unknown)"} lacks environment_name/contract_pin for draft generation`, { reason: "incomplete_run_context", run_id: run?.run_id }) };
    }
  }

  const fp = finding.fingerprint;
  const primary = runs[0];
  const environment = {
    api_id: fp.api_id,
    environment_name: primary.manifest.environment_name,
    spec_revision: primary.manifest.contract_pin.source_revision,
    first_observed_at: finding.first_observed_at,
  };

  // Sanitized evidence: Evidence Index references + one-line summaries only.
  const sanitized_evidence = [];
  for (const run of runs) {
    for (const obs of run.observations) {
      sanitized_evidence.push(
        `${run.run_id} ${obs.evidence_ref ?? "observations.jsonl"} — ${obs.fact.method} ${obs.fact.path} → ${obs.fact.status_or_error} (signature ${obs.fact.response_signature ?? "-"})`
      );
    }
  }

  const draft = {
    draft_id: ids.draftId(),
    finding_id: finding.finding_id,
    summary: `${fp.api_id}: ${fp.normalized_method_path} returns ${fp.normalized_status_or_error} (${fp.assertion_class} assertion failure) — reproduced ${finding.reproduction.failures}/${finding.reproduction.attempts} times.`,
    environment,
    preconditions: [
      `API ${fp.api_id} reachable in environment ${primary.manifest.environment_name}${primary.manifest.deployment_ref ? ` (deployment ${primary.manifest.deployment_ref})` : ""}`,
      ...(primary.manifest.scenario_id ? [`scenario ${primary.manifest.scenario_id} running at state "${fp.scenario_state}"`] : []),
      `contract pinned to spec revision ${primary.manifest.contract_pin.source_revision}`,
    ],
    minimal_reproduction: [
      `Send ${fp.normalized_method_path} to ${fp.api_id} in environment ${primary.manifest.environment_name}`,
      `drive the scenario to state "${fp.scenario_state}"`,
      `observe the response status and signature (expected signature family: ${fp.response_signature})`,
    ],
    expected: expectationFor(fp.assertion_class, environment.spec_revision),
    actual: `observed ${fp.normalized_status_or_error} with response signature ${fp.response_signature} across ${runs.length} sealed run(s)`,
    hypothesis: "",
    reproducibility: { attempts: finding.reproduction.attempts, failures: finding.reproduction.failures, rate: finding.reproduction.rate },
    timing: `first observed ${finding.first_observed_at}, last observed ${finding.last_observed_at}; primary run ${primary.run_id} took ${primary.manifest.duration_ms}ms (${primary.manifest.started_at} → ${primary.manifest.finished_at})`,
    sanitized_evidence,
    artifacts: runs.map((run) => ({ kind: "run", ref: run.run_id })),
    scope_boundary:
      "NightWatch observed this symptom from outside via black-box API testing and did not modify business code. The root cause is unknown; any suspected cause appears only under the 'Hypothesis' section and must not be read as a statement of fact (§14.1).",
    labels: ["nightwatch", "needs-fix", `finding:${finding.classification}`],
  };

  // Explicit overrides are the only channel for a hypothesis (§14.1 firewall).
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in draft)) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `unknown draft override "${key}"`, { reason: "unknown_override", key }) };
    }
    draft[key] = value;
  }

  const draftCheck = validateIssueDraft(draft);
  if (!draftCheck.ok) {
    return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "generated draft failed WP-00 issue_draft schema validation", { reason: "draft_schema", errors: draftCheck.errors }) };
  }
  return { ok: true, draft };
}
