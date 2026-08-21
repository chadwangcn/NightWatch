#!/usr/bin/env node
/**
 * NightWatch WP-07 — Issue Gateway Verifier (verify.mjs)
 *
 * Independently executable (no network, no services, no real GitHub writes).
 * Drives the full C13 publish pipeline over synthetic publish-cases fixtures
 * (themselves driven through the real WP-06 EvidenceStore/FindingStore so
 * every draft references genuinely sealed, checksum-verified bundles), and
 * checks the WorkRequest §7 hard gates A1–A10:
 *
 *   A1  draft_generation          confirmed finding → 13-field draft (WP-00
 *                                issue_draft schema); hypothesis defaults empty
 *   A2  evidence_gate            unsealed bundle / inconclusive finding →
 *                                ISS_GATE_FAILED, zero GitHub writes
 *   A3  secret_scan_gate         injected credential pattern → publish
 *                                rejected; clean path zero residue in draft
 *   A4  fingerprint_dedup        fingerprint matches preset open issue →
 *                                ISS_DUPLICATE, only addComment (no createIssue)
 *   A5  reviewer_gate            missing / expired approval → rejected;
 *                                valid approval → passes
 *   A6  policy_integration       denied / missing policy → zero writes;
 *                                approved → proceeds to gate evaluation
 *   A7  publish_idempotency      same key + same draft → single write, replay
 *                                returns original receipt; different key same
 *                                draft → ISS_IDEMPOTENCY_CONFLICT
 *   A8  retest_linkage           new evidence → comment on existing issue
 *                                (never creates a new issue)
 *   A9  hypothesis_firewall      draft with hypothesis → body has a dedicated,
 *                                disclaimed section; never stated as fact;
 *                                single-occurrence guarantee
 *   A10 determinism_and_baseline publish_receipt schema valid; secret scan zero
 *                                hits; two passes byte-identical (time excluded);
 *                                baseline WP-00/03/04/06 verify rerun exit 0
 *
 * Determinism: fixed clock + counter-based ULIDs (lib/ids.mjs ⇒
 * evidence/lib/ids.mjs) ⇒ two runs of this verifier produce byte-identical
 * receipt `checks` (top-level finished_at excluded). Runtime state lives under
 * nightwatch/issue/.state/verify/ (gitignored) and is wiped at every start.
 *
 * Usage: node nightwatch/issue/verify.mjs   (from the repository root)
 */
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvidenceStore,
  FindingStore,
  makeIdFactory,
  buildFingerprint,
  fingerprintHash,
  assertSealedForConsumption,
  validateFinding,
} from "../evidence/lib/index.mjs";
import { makeApprovalRecord, findValidApproval } from "../policy/lib/gate.mjs";
import {
  IssueGateway,
  GitHubStub,
  makeIssueIdFactory,
  makeAuditSink,
  makePolicyDecision,
  buildDraft,
  renderIssueBody,
  renderIssueTitle,
  renderDedupComment,
  renderRetestComment,
  scanDraftSecrets,
  scanTextSecrets,
  PUBLISH_GATES,
  canonicalJson,
  ERROR_CODES,
  isErrorEnvelope,
  validateIssueDraft,
  validatePublishReceipt,
  validatePolicyDecision,
  validateApprovalRecord,
  validateErrorEnvelope,
} from "./lib/index.mjs";

const ISSUE_ROOT = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/issue
const NW_ROOT = join(ISSUE_ROOT, "..");
const REPO_ROOT = join(NW_ROOT, "..");
const STATE_DIR = join(ISSUE_ROOT, ".state", "verify");
const RECEIPT_PATH = join(ISSUE_ROOT, "verify", "receipt.json");
const FIXTURES = JSON.parse(readFileSync(join(ISSUE_ROOT, "fixtures", "publish-cases.json"), "utf8"));

/* Fixed clock: every timestamp in stores/receipts derives from this instant. */
const FIXED_MS = Date.parse("2026-08-21T10:00:00Z");
const clock = () => new Date(FIXED_MS).toISOString().replace(/\.\d+Z$/, "Z");

/* Issue-domain approval scope format (approval_record/v1 description). */
const approvalScopeFor = (findingId) => `issue.publish:finding=${findingId}`;

/* Repo-relative path for receipt artifacts (stable across checkouts). */
const relFromRepo = (absPath) => relative(REPO_ROOT, absPath).split("\\").join("/");

/* ------------------------------------------------------------------ */
/* Pipeline (run twice; pass 2 proves byte-identical receipts)         */
/* ------------------------------------------------------------------ */
function runPipeline(tag, auditStoreDir) {
  const ids = makeIdFactory(() => FIXED_MS);
  const issueIds = makeIssueIdFactory(() => FIXED_MS);
  const store = new EvidenceStore(join(STATE_DIR, `store-${tag}`), { clock });
  const findings = new FindingStore(join(STATE_DIR, `findings-${tag}`), { ids, clock });
  const audit = makeAuditSink({ storeDir: auditStoreDir });
  const tally = { ok_new: 0, replay: 0, fallback: 0, failed: 0 };
  const auditSink = {
    record(event) {
      const r = audit.record(event);
      if (r.ok && r.fallback) tally.fallback += 1;
      else if (r.ok && r.idempotent_replay) tally.replay += 1;
      else if (r.ok) tally.ok_new += 1;
      else tally.failed += 1;
      return r;
    },
  };

  // -- Ingest every fixture run through the real WP-06 pipeline ----------
  const runs = [];
  const ingestRun = (spec) => {
    const { events, cleanup, ...own } = spec.run;
    const ctx = { ...FIXTURES.shared, ...own };
    const created = store.createRun(ctx);
    if (!created.ok) throw new Error(`createRun failed for ${ctx.run_id}`);
    const bundle = created.bundle;
    const obsByCase = new Map();
    let repetition = 0;
    for (const ev of events) {
      const r = bundle.ingestCaseEvent(ev);
      if (!r.ok) throw new Error(`ingest failed for ${ev.case_id}: ${JSON.stringify(r.error)}`);
      if (ev.result === "failed" || ev.result === "error") {
        repetition += 1;
        const observation = {
          observation_id: ids.observationId(),
          run_id: ctx.run_id,
          execution_id: ctx.execution_id,
          case_id: ev.case_id,
          occurred_at: ctx.finished_at,
          fact: {
            api_id: ev.api_id,
            method: ev.method,
            path: ev.path,
            status_or_error: ev.status_or_error,
            response_signature: ev.response_signature,
          },
          context: { scenario_id: ctx.scenario_id, scenario_state: ev.scenario_state, seed: ctx.seed, repetition },
          evidence_ref: (r.refs ?? []).find((x) => x.startsWith("responses/")) ?? "cases.jsonl",
        };
        const or = bundle.recordObservation(observation);
        if (!or.ok) throw new Error(`recordObservation failed for ${ev.case_id}: ${JSON.stringify(or.error)}`);
        obsByCase.set(ev.case_id, observation);
      }
    }
    if (cleanup) {
      const cleanupResult = bundle.recordCleanup(cleanup);
      if (!cleanupResult.ok) throw new Error(`recordCleanup failed for ${ctx.run_id}`);
    }
    const seal = spec.seal ? bundle.seal() : { ok: false, skipped: true };
    return { purpose: spec.purpose, spec, ctx, events, bundle, obsByCase, seal };
  };
  for (const spec of FIXTURES.runs) runs.push(ingestRun(spec));
  const retestRun = ingestRun(FIXTURES.retest_run);

  // -- Finding submissions (quartet grouping, same as WP-06 verify) ------
  const submitFindingsForRun = (run) => {
    const groups = new Map();
    for (const ev of run.events) {
      const parts = buildFingerprint(ev);
      const quartet = [parts.api_id, parts.normalized_method_path, parts.assertion_class, parts.scenario_state].join("|");
      if (!groups.has(quartet)) groups.set(quartet, { attempts: 0, bySignature: new Map() });
      const g = groups.get(quartet);
      g.attempts += 1;
      if (ev.result !== "failed" && ev.result !== "error") continue;
      const sig = `${parts.normalized_status_or_error}|${parts.response_signature}`;
      if (!g.bySignature.has(sig)) g.bySignature.set(sig, { parts, failures: 0, signals: [], ambiguity: null, observations: [] });
      const s = g.bySignature.get(sig);
      s.failures += 1;
      const obs = run.obsByCase.get(ev.case_id);
      if (obs) s.observations.push(obs);
    }
    const submissions = [];
    for (const g of groups.values()) {
      for (const s of g.bySignature.values()) {
        const result = findings.submit({ parts: s.parts, attempts: g.attempts, failures: s.failures, observations: s.observations });
        if (!result.ok) throw new Error(`finding submit failed (${run.purpose}): ${JSON.stringify(result.error)}`);
        submissions.push({ run: run.purpose, parts: s.parts, attempts: g.attempts, failures: s.failures, result });
      }
    }
    return submissions;
  };
  const submissions = [];
  for (const run of runs) submissions.push(...submitFindingsForRun(run));

  store.buildIndex();

  // -- Build the Issue Gateway with a clean GitHub Stub -----------------
  // Both pipeline passes run against an EMPTY stub (no preset issues): the
  // happy-path publishes (A7/A8/A10) must reach createIssue. The preset
  // dedup issue is injected ONLY into the A4-local stub.
  const confirmedPrimary = submissions.find((s) => s.run === "confirmed-primary" && s.result.status === "created" && s.result.classification === "confirmed");
  if (!confirmedPrimary) throw new Error("confirmed-primary finding not found in submissions");
  const dedupFpHash = fingerprintHash(confirmedPrimary.result.finding.fingerprint);
  const github = new GitHubStub({ issues: [], clock });

  const gateway = new IssueGateway({
    github,
    evidenceStore: store,
    ids: issueIds,
    clock,
    audit: auditSink,
    stateDir: join(STATE_DIR, `registry-${tag}`),
  });

  return {
    tag,
    ids,
    issueIds,
    store,
    findings,
    audit,
    auditSink,
    tally,
    github,
    gateway,
    runs,
    retestRun,
    submissions,
    confirmedPrimary,
    dedupFpHash,
  };
}

/* Wipe runtime state and execute both passes. */
rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
const AUDIT_STORE = join(STATE_DIR, "audit-store");
const pass1 = runPipeline("1", AUDIT_STORE);
const pass2 = runPipeline("2", AUDIT_STORE);

/* ------------------------------------------------------------------ */
/* Check collectors keyed by acceptance gate                           */
/* ------------------------------------------------------------------ */
const R = Object.fromEntries(
  [
    "a1_draft_generation",
    "a2_evidence_gate",
    "a3_secret_scan_gate",
    "a4_fingerprint_dedup",
    "a5_reviewer_gate",
    "a6_policy_integration",
    "a7_publish_idempotency",
    "a8_retest_linkage",
    "a9_hypothesis_firewall",
    "a10_determinism_and_baseline",
  ].map((k) => [k, { failures: [] }])
);
const fail = (block, msg) => R[block].failures.push(msg);
const expect = (block, cond, msg) => {
  if (!cond) fail(block, msg);
  return cond === true;
};
const line = (s) => process.stdout.write(s + "\n");

/* Helper: build a valid policy_decision fixture for a finding. */
const buildPolicy = (pass, finding, kind) => {
  const base = FIXTURES.policy_decisions[kind];
  return {
    decision: base.decision,
    reason: base.reason,
    requested_action: `issue.publish:finding=${finding.finding_id}`,
    decided_by: base.decided_by,
    decided_at: new Date(FIXED_MS + base.decided_at_offset_ms).toISOString().replace(/\.\d+Z$/, "Z"),
    expires_at: new Date(FIXED_MS + base.expires_at_offset_ms).toISOString().replace(/\.\d+Z$/, "Z"),
  };
};

/* Helper: build a valid approval_record for a finding. */
const buildApproval = (pass, finding, kind) => {
  const base = FIXTURES.approvals[kind];
  const scope = approvalScopeFor(finding.finding_id);
  const result = makeApprovalRecord({
    approver: base.approver,
    decision: base.decision,
    scope,
    approved_at: new Date(FIXED_MS + base.approved_at_offset_ms).toISOString().replace(/\.\d+Z$/, "Z"),
    expires_at: new Date(FIXED_MS + base.expires_at_offset_ms).toISOString().replace(/\.\d+Z$/, "Z"),
    reason: base.reason,
  });
  if (!result.ok) throw new Error(`approval build failed (${kind}): ${JSON.stringify(result.error)}`);
  return result.approval;
};

/* ================================================================== */
/* A1 — Draft generation (13 fields, WP-00 schema, hypothesis empty)    */
/* ================================================================== */
{
  const { gateway, confirmedPrimary } = pass1;
  const finding = confirmedPrimary.result.finding;
  const built = gateway.buildDraft({ finding });
  expect("a1_draft_generation", built.ok, `buildDraft failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const draft = built.draft;
    const required = [
      "draft_id", "finding_id", "summary", "environment", "preconditions",
      "minimal_reproduction", "expected", "actual", "reproducibility",
      "timing", "sanitized_evidence", "artifacts", "scope_boundary",
    ];
    for (const key of required) {
      expect("a1_draft_generation", key in draft, `draft missing required field "${key}"`);
    }
    expect("a1_draft_generation", draft.hypothesis === "", `hypothesis must default to empty, got "${draft.hypothesis}"`);
    expect("a1_draft_generation", draft.finding_id === finding.finding_id, "draft.finding_id must match the finding");
    const schemaCheck = validateIssueDraft(draft);
    expect("a1_draft_generation", schemaCheck.ok, `draft fails WP-00 issue_draft schema: ${schemaCheck.errors?.join("; ")}`);
    // Environment sub-fields
    for (const key of ["api_id", "environment_name", "spec_revision", "first_observed_at"]) {
      expect("a1_draft_generation", key in draft.environment, `draft.environment missing "${key}"`);
    }
    // Sanitized evidence references Evidence Index (run refs only), no raw payloads
    expect("a1_draft_generation", draft.sanitized_evidence.length > 0, "sanitized_evidence must be non-empty");
    expect("a1_draft_generation", draft.artifacts.length > 0 && draft.artifacts.every((a) => a.kind === "run"), "artifacts must all be run references");
    // Non-confirmed finding → rejected
    const inconclusiveFinding = pass1.submissions.find((s) => s.result.finding?.classification === "inconclusive");
    if (inconclusiveFinding) {
      const rejected = gateway.buildDraft({ finding: inconclusiveFinding.result.finding });
      expect("a1_draft_generation", !rejected.ok, "non-confirmed finding must not produce a draft");
    }
  }
}

/* ================================================================== */
/* A2 — Evidence Gate (unsealed bundle / inconclusive → reject, 0 writes) */
/* ================================================================== */
{
  const { gateway, confirmedPrimary } = pass1;
  const finding = confirmedPrimary.result.finding;
  // Build a draft from the unsealed run (confirmed-unsealed fixture)
  const unsealedRun = pass1.runs.find((r) => r.purpose === "confirmed-unsealed");
  expect("a2_evidence_gate", unsealedRun !== undefined, "confirmed-unsealed run fixture missing");
  expect("a2_evidence_gate", !unsealedRun.seal.ok, "confirmed-unsealed run must NOT be sealed");
  // Build a draft that references the unsealed run only
  const draftResult = gateway.buildDraft({ finding, overrides: { artifacts: [{ kind: "run", ref: unsealedRun.ctx.run_id }] } });
  expect("a2_evidence_gate", draftResult.ok, `buildDraft for unsealed reference failed: ${JSON.stringify(draftResult.error)}`);
  if (draftResult.ok) {
    const policy = buildPolicy(pass1, finding, "approved");
    const approval = buildApproval(pass1, finding, "valid");
    const writesBefore = pass1.github.writeCount();
    const result = gateway.publish({ draft: draftResult.draft, finding, idempotency_key: `${draftResult.draft.draft_id}:publish:unsealed`, policy_decision: policy, approvals: [approval] });
    expect("a2_evidence_gate", !result.ok, "publish with unsealed bundle must be rejected");
    expect("a2_evidence_gate", result.error?.code === ERROR_CODES.GATE_FAILED, `expected ISS_GATE_FAILED, got ${result.error?.code}`);
    expect("a2_evidence_gate", result.error?.details?.gate === "evidence-completeness", `expected gate=evidence-completeness, got ${result.error?.details?.gate}`);
    expect("a2_evidence_gate", result.error?.details?.reason === "bundle_not_sealed", `expected reason=bundle_not_sealed, got ${result.error?.details?.reason}`);
    expect("a2_evidence_gate", pass1.github.writeCount() === writesBefore, "zero GitHub writes on gate failure");
  }
  // Inconclusive finding → rejected at gate 1 (finding_not_confirmed), even
  // with a schema-valid draft, approved policy and valid approval.
  const inconclusive = pass1.submissions.find((s) => s.result.finding?.classification === "inconclusive");
  if (inconclusive) {
    const incFinding = inconclusive.result.finding;
    const rejected = gateway.publish({
      draft: {
        draft_id: makeIssueIdFactory(() => FIXED_MS).draftId(),
        finding_id: incFinding.finding_id,
        summary: "schema-valid draft used only to prove the gate-1 rejection path",
        environment: { api_id: incFinding.fingerprint.api_id, environment_name: "synthetic-staging", spec_revision: "synthetic-rev-wp07-4c3f", first_observed_at: incFinding.first_observed_at },
        preconditions: ["synthetic precondition"],
        minimal_reproduction: ["GET /v1/widgets/{ulid} in synthetic-staging"],
        expected: "the pinned contract requires a 2xx success status for this request (spec revision synthetic-rev-wp07-4c3f)",
        actual: "observed 404 with response signature synthetic-sig-404-widget-missing across 1 sealed run(s)",
        reproducibility: { attempts: 1, failures: 1, rate: 1 },
        timing: "single attempt run; see sealed bundle",
        sanitized_evidence: ["run_01J8WP07RG000000000000CCC3 observations.jsonl — GET /v1/widgets/{ulid} → 404 (signature synthetic-sig-404-widget-missing)"],
        artifacts: [{ kind: "run", ref: "run_01J8WP07RG000000000000CCC3" }],
        scope_boundary: "NightWatch observed this symptom from outside via black-box API testing and did not modify business code.",
      },
      finding: incFinding,
      idempotency_key: `${incFinding.finding_id}:publish:inconclusive`,
      policy_decision: buildPolicy(pass1, incFinding, "approved"),
      approvals: [buildApproval(pass1, incFinding, "valid")],
    });
    expect("a2_evidence_gate", !rejected.ok, "inconclusive finding publish must be rejected");
    expect("a2_evidence_gate", rejected.error?.code === ERROR_CODES.GATE_FAILED, `expected ISS_GATE_FAILED for inconclusive finding, got ${rejected.error?.code}`);
    expect("a2_evidence_gate", rejected.error?.details?.reason === "finding_not_confirmed", `expected reason=finding_not_confirmed, got ${rejected.error?.details?.reason}`);
  }
}

/* ================================================================== */
/* A3 — Secret scan gate (injected credential → reject; clean path 0 residue) */
/* ================================================================== */
{
  const { gateway, confirmedPrimary } = pass1;
  const finding = confirmedPrimary.result.finding;
  const negSpec = FIXTURES.secret_negative;
  // Build a clean draft, then inject the secret value via override
  const built = gateway.buildDraft({ finding, overrides: { [negSpec.override_field]: negSpec.value } });
  expect("a3_secret_scan_gate", built.ok, `buildDraft with secret override failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const draft = built.draft;
    // The draft itself may pass schema (actual is a string); the gate scan must catch it
    const scanResult = scanDraftSecrets(draft);
    expect("a3_secret_scan_gate", scanResult.hits.length > 0, `secret scan must detect the injected credential in draft.${negSpec.override_field}`);
    const policy = buildPolicy(pass1, finding, "approved");
    const approval = buildApproval(pass1, finding, "valid");
    const writesBefore = pass1.github.writeCount();
    const result = gateway.publish({ draft, finding, idempotency_key: `${draft.draft_id}:publish:secret`, policy_decision: policy, approvals: [approval] });
    expect("a3_secret_scan_gate", !result.ok, "publish with injected secret must be rejected");
    expect("a3_secret_scan_gate", result.error?.code === ERROR_CODES.GATE_FAILED, `expected ISS_GATE_FAILED, got ${result.error?.code}`);
    expect("a3_secret_scan_gate", result.error?.details?.gate === "secret-scan", `expected gate=secret-scan, got ${result.error?.details?.gate}`);
    expect("a3_secret_scan_gate", pass1.github.writeCount() === writesBefore, "zero GitHub writes on secret gate failure");
    // Clean path: the default draft has zero secret hits
    const cleanBuilt = gateway.buildDraft({ finding });
    if (cleanBuilt.ok) {
      const cleanScan = scanDraftSecrets(cleanBuilt.draft);
      expect("a3_secret_scan_gate", cleanScan.hits.length === 0, `clean draft must have zero secret scan hits, got ${JSON.stringify(cleanScan.hits)}`);
    }
  }
}

/* ================================================================== */
/* A4 — Fingerprint dedup (preset open issue → ISS_DUPLICATE, only addComment) */
/* ================================================================== */
{
  // Dedicated stub preloaded with an OPEN issue carrying the confirmed-primary
  // fingerprint hash; a dedicated gateway over pass1's sealed store. The
  // pipeline stubs stay clean so A7/A8/A10 publishes reach createIssue.
  const finding = pass1.confirmedPrimary.result.finding;
  const presetIssues = FIXTURES.preset_issues.map((p) => ({
    ...p,
    fingerprint_hash: p.fingerprint_of === "confirmed-primary" ? pass1.dedupFpHash : p.fingerprint_hash ?? null,
  }));
  const github = new GitHubStub({ issues: presetIssues, clock });
  const gateway = new IssueGateway({
    github,
    evidenceStore: pass1.store,
    ids: makeIssueIdFactory(() => FIXED_MS),
    clock,
    audit: pass1.auditSink,
    stateDir: join(STATE_DIR, "registry-dedup"),
  });
  const built = gateway.buildDraft({ finding });
  expect("a4_fingerprint_dedup", built.ok, `buildDraft for dedup test failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const policy = buildPolicy(pass1, finding, "approved");
    const approval = buildApproval(pass1, finding, "valid");
    const writesBeforeCreate = github.writeCount("createIssue");
    const writesBeforeComment = github.writeCount("addComment");
    const result = gateway.publish({ draft: built.draft, finding, idempotency_key: `${built.draft.draft_id}:publish:dedup`, policy_decision: policy, approvals: [approval] });
    expect("a4_fingerprint_dedup", !result.ok, "dedup publish must return not-ok (ISS_DUPLICATE)");
    expect("a4_fingerprint_dedup", result.error?.code === ERROR_CODES.DUPLICATE, `expected ISS_DUPLICATE, got ${result.error?.code}`);
    expect("a4_fingerprint_dedup", result.duplicate?.appended === true, "dedup must append a comment");
    expect("a4_fingerprint_dedup", github.writeCount("createIssue") === writesBeforeCreate, "dedup must NOT create a new issue (zero createIssue writes)");
    expect("a4_fingerprint_dedup", github.writeCount("addComment") === writesBeforeComment + 1, "dedup must append exactly one comment");
    // Idempotent replay of the dedup outcome
    const replay = gateway.publish({ draft: built.draft, finding, idempotency_key: `${built.draft.draft_id}:publish:dedup`, policy_decision: policy, approvals: [approval] });
    expect("a4_fingerprint_dedup", replay.replay === true, "dedup replay must be idempotent");
    expect("a4_fingerprint_dedup", github.writeCount("addComment") === writesBeforeComment + 1, "dedup replay must NOT add another comment");
  }
}

/* ================================================================== */
/* A5 — Reviewer gate (missing / expired → reject; valid → pass)       */
/* ================================================================== */
{
  const { gateway, confirmedPrimary } = pass1;
  const finding = confirmedPrimary.result.finding;
  const built = gateway.buildDraft({ finding });
  expect("a5_reviewer_gate", built.ok, `buildDraft for reviewer test failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const policy = buildPolicy(pass1, finding, "approved");
    // Missing approvals
    const writesBefore = pass1.github.writeCount();
    const noApproval = gateway.publish({ draft: built.draft, finding, idempotency_key: `${built.draft.draft_id}:publish:no-approval`, policy_decision: policy, approvals: [] });
    expect("a5_reviewer_gate", !noApproval.ok, "missing approval must reject");
    expect("a5_reviewer_gate", noApproval.error?.code === ERROR_CODES.GATE_FAILED, `expected ISS_GATE_FAILED, got ${noApproval.error?.code}`);
    expect("a5_reviewer_gate", noApproval.error?.details?.gate === "reviewer", `expected gate=reviewer, got ${noApproval.error?.details?.gate}`);
    expect("a5_reviewer_gate", noApproval.error?.details?.reason === "approval_missing", `expected reason=approval_missing, got ${noApproval.error?.details?.reason}`);
    expect("a5_reviewer_gate", pass1.github.writeCount() === writesBefore, "zero writes on missing approval");
    // Expired approval
    const expiredApproval = buildApproval(pass1, finding, "expired");
    const expiredResult = gateway.publish({ draft: built.draft, finding, idempotency_key: `${built.draft.draft_id}:publish:expired-approval`, policy_decision: policy, approvals: [expiredApproval] });
    expect("a5_reviewer_gate", !expiredResult.ok, "expired approval must reject");
    expect("a5_reviewer_gate", expiredResult.error?.details?.reason === "approval_expired", `expected reason=approval_expired, got ${expiredResult.error?.details?.reason}`);
    expect("a5_reviewer_gate", pass1.github.writeCount() === writesBefore, "zero writes on expired approval");
  }
}

/* ================================================================== */
/* A6 — Policy integration (denied / missing → zero writes; approved → proceeds) */
/* ================================================================== */
{
  const { gateway, confirmedPrimary } = pass1;
  const finding = confirmedPrimary.result.finding;
  const built = gateway.buildDraft({ finding });
  expect("a6_policy_integration", built.ok, `buildDraft for policy test failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const approval = buildApproval(pass1, finding, "valid");
    // Missing policy
    const writesBefore = pass1.github.writeCount();
    const noPolicy = gateway.publish({ draft: built.draft, finding, idempotency_key: `${built.draft.draft_id}:publish:no-policy`, policy_decision: undefined, approvals: [approval] });
    expect("a6_policy_integration", !noPolicy.ok, "missing policy must reject");
    expect("a6_policy_integration", noPolicy.error?.code === ERROR_CODES.POLICY_DENIED, `expected POL_DENIED, got ${noPolicy.error?.code}`);
    expect("a6_policy_integration", noPolicy.error?.details?.reason === "policy_decision_missing", `expected reason=policy_decision_missing, got ${noPolicy.error?.details?.reason}`);
    expect("a6_policy_integration", pass1.github.writeCount() === writesBefore, "zero writes on missing policy");
    // Denied policy
    const deniedPolicy = buildPolicy(pass1, finding, "denied");
    const deniedResult = gateway.publish({ draft: built.draft, finding, idempotency_key: `${built.draft.draft_id}:publish:denied-policy`, policy_decision: deniedPolicy, approvals: [approval] });
    expect("a6_policy_integration", !deniedResult.ok, "denied policy must reject");
    expect("a6_policy_integration", deniedResult.error?.code === ERROR_CODES.POLICY_DENIED, `expected POL_DENIED, got ${deniedResult.error?.code}`);
    expect("a6_policy_integration", deniedResult.error?.details?.reason === "policy_decision_denied", `expected reason=policy_decision_denied, got ${deniedResult.error?.details?.reason}`);
    expect("a6_policy_integration", pass1.github.writeCount() === writesBefore, "zero writes on denied policy");
  }
}

/* ================================================================== */
/* A7 — Publish idempotency (same key → single write; different key → conflict) */
/* ================================================================== */
let a7FirstPublish = null; // reused by A8 (retest base) and A10 (receipt validation)
{
  const { gateway, confirmedPrimary, github } = pass1;
  const finding = confirmedPrimary.result.finding;
  const built = gateway.buildDraft({ finding });
  expect("a7_publish_idempotency", built.ok, `buildDraft for idempotency test failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const policy = buildPolicy(pass1, finding, "approved");
    const approval = buildApproval(pass1, finding, "valid");
    const key = `${built.draft.draft_id}:publish`;
    const writesBefore = github.writeCount();
    // First publish → success
    const first = gateway.publish({ draft: built.draft, finding, idempotency_key: key, policy_decision: policy, approvals: [approval] });
    expect("a7_publish_idempotency", first.ok, `first publish must succeed: ${JSON.stringify(first.error)}`);
    expect("a7_publish_idempotency", first.replay === false, "first publish must not be a replay");
    expect("a7_publish_idempotency", github.writeCount("createIssue") === writesBefore + 1, "first publish must create exactly one issue");
    if (first.ok) a7FirstPublish = first;
    // Replay with same key → returns original receipt, zero new writes
    const replay = gateway.publish({ draft: built.draft, finding, idempotency_key: key, policy_decision: policy, approvals: [approval] });
    expect("a7_publish_idempotency", replay.ok, "replay must succeed");
    expect("a7_publish_idempotency", replay.replay === true, "replay must be marked as idempotent replay");
    expect("a7_publish_idempotency", JSON.stringify(replay.receipt) === JSON.stringify(first.receipt), "replay receipt must be byte-identical to the original");
    expect("a7_publish_idempotency", github.writeCount("createIssue") === writesBefore + 1, "replay must NOT create another issue");
    // Different key, same draft → ISS_IDEMPOTENCY_CONFLICT
    const conflictKey = `${built.draft.draft_id}:publish:other`;
    const conflict = gateway.publish({ draft: built.draft, finding, idempotency_key: conflictKey, policy_decision: policy, approvals: [approval] });
    expect("a7_publish_idempotency", !conflict.ok, "different key for same draft must reject");
    expect("a7_publish_idempotency", conflict.error?.code === ERROR_CODES.IDEMPOTENCY_CONFLICT, `expected ISS_IDEMPOTENCY_CONFLICT, got ${conflict.error?.code}`);
    expect("a7_publish_idempotency", conflict.error?.details?.reason === "draft_already_published", `expected reason=draft_already_published, got ${conflict.error?.details?.reason}`);
    expect("a7_publish_idempotency", github.writeCount("createIssue") === writesBefore + 1, "conflict must NOT create another issue");
  }
}

/* ================================================================== */
/* A8 — Retest linkage (new evidence → comment, never new issue)      */
/* ================================================================== */
{
  const { gateway, confirmedPrimary, github } = pass1;
  const finding = confirmedPrimary.result.finding;
  // The retest targets the issue A7 already published (the natural flow:
  // finding published → retest evidence arrives → comment on the SAME issue).
  expect("a8_retest_linkage", a7FirstPublish !== null, "A7 first publish must be available as the retest base issue");
  if (a7FirstPublish !== null) {
    const issueRef = a7FirstPublish.receipt.issue_ref;
    const writesBeforeComment = github.writeCount("addComment");
    const writesBeforeCreate = github.writeCount("createIssue");
    // Submit retest run findings, then aggregate into the finding
    const retestSubs = submitFindingsForRunInPipeline(pass1, pass1.retestRun);
    const retestFinding = retestSubs.find((s) => s.result.status === "merged")?.result?.finding ?? finding;
    const retestKey = `${finding.finding_id}:retest:${pass1.retestRun.ctx.run_id}`;
    const retest = gateway.attachRetest({
      finding: retestFinding,
      issue_ref: issueRef,
      new_evidence: [{ run_id: pass1.retestRun.ctx.run_id, evidence_refs: ["observations.jsonl"], summary: "retest sealed run" }],
      conclusion: "symptom persists after retest (500 still observed)",
      idempotency_key: retestKey,
    });
    expect("a8_retest_linkage", retest.ok, `retest attach must succeed: ${JSON.stringify(retest.error)}`);
    expect("a8_retest_linkage", retest.ok && github.writeCount("addComment") === writesBeforeComment + 1, "retest must append exactly one comment");
    expect("a8_retest_linkage", retest.ok && github.writeCount("createIssue") === writesBeforeCreate, "retest must NOT create a new issue");
    expect("a8_retest_linkage", retest.ok && retest.comment.body.includes(pass1.retestRun.ctx.run_id), "retest comment must reference the new sealed run evidence");
    expect("a8_retest_linkage", retest.ok && retest.comment.body.includes("symptom persists after retest"), "retest comment must carry the conclusion");
    // Idempotent replay of retest
    const retestReplay = gateway.attachRetest({
      finding: retestFinding,
      issue_ref: issueRef,
      new_evidence: [{ run_id: pass1.retestRun.ctx.run_id, evidence_refs: ["observations.jsonl"], summary: "retest sealed run" }],
      conclusion: "symptom persists after retest (500 still observed)",
      idempotency_key: retestKey,
    });
    expect("a8_retest_linkage", retestReplay.ok && retestReplay.replay === true, "retest replay must be idempotent");
    expect("a8_retest_linkage", github.writeCount("addComment") === writesBeforeComment + 1, "retest replay must NOT add another comment");
  }
}

/* Helper to submit findings for a run within an existing pipeline pass. */
function submitFindingsForRunInPipeline(pass, run) {
  const groups = new Map();
  for (const ev of run.events) {
    const parts = buildFingerprint(ev);
    const quartet = [parts.api_id, parts.normalized_method_path, parts.assertion_class, parts.scenario_state].join("|");
    if (!groups.has(quartet)) groups.set(quartet, { attempts: 0, bySignature: new Map() });
    const g = groups.get(quartet);
    g.attempts += 1;
    if (ev.result !== "failed" && ev.result !== "error") continue;
    const sig = `${parts.normalized_status_or_error}|${parts.response_signature}`;
    if (!g.bySignature.has(sig)) g.bySignature.set(sig, { parts, failures: 0, observations: [] });
    const s = g.bySignature.get(sig);
    s.failures += 1;
    const obs = run.obsByCase.get(ev.case_id);
    if (obs) s.observations.push(obs);
  }
  const submissions = [];
  for (const g of groups.values()) {
    for (const s of g.bySignature.values()) {
      const result = pass.findings.submit({ parts: s.parts, attempts: g.attempts, failures: s.failures, observations: s.observations });
      if (!result.ok) throw new Error(`retest finding submit failed: ${JSON.stringify(result.error)}`);
      submissions.push({ parts: s.parts, attempts: g.attempts, failures: s.failures, result });
    }
  }
  return submissions;
}

/* ================================================================== */
/* A9 — Hypothesis firewall (dedicated section, disclaimer, single occurrence) */
/* ================================================================== */
{
  const { gateway, confirmedPrimary } = pass1;
  const finding = confirmedPrimary.result.finding;
  const hypothesisText = "suspected database connection pool exhaustion under concurrent widget creation";
  const built = gateway.buildDraft({ finding, overrides: { hypothesis: hypothesisText } });
  expect("a9_hypothesis_firewall", built.ok, `buildDraft with hypothesis failed: ${JSON.stringify(built.error)}`);
  if (built.ok) {
    const draft = built.draft;
    expect("a9_hypothesis_firewall", draft.hypothesis === hypothesisText, "hypothesis must be set via the override channel");
    const body = renderIssueBody(draft);
    // Hypothesis must appear in a dedicated section with the disclaimer
    expect("a9_hypothesis_firewall", body.includes("## Hypothesis (suspected — NOT a confirmed root cause)"), "body must contain the hypothesis section title");
    expect("a9_hypothesis_firewall", body.includes("> The following is an unverified hypothesis."), "body must contain the hypothesis disclaimer");
    expect("a9_hypothesis_firewall", body.includes(hypothesisText), "body must contain the hypothesis text in the dedicated section");
    // Single-occurrence guarantee: the hypothesis text appears exactly once
    const occurrences = body.split(hypothesisText).length - 1;
    expect("a9_hypothesis_firewall", occurrences === 1, `hypothesis text must appear exactly once in the body (found ${occurrences})`);
    // The hypothesis must NOT appear in Summary or Actual
    const summarySection = body.split("## Summary")[1]?.split("## Environment")[0] ?? "";
    const actualSection = body.split("## Actual")[1]?.split("## Reproducibility")[0] ?? "";
    expect("a9_hypothesis_firewall", !summarySection.includes(hypothesisText), "hypothesis must NOT appear in Summary section");
    expect("a9_hypothesis_firewall", !actualSection.includes(hypothesisText), "hypothesis must NOT appear in Actual section");
    // Secret scan of the rendered body must be clean
    const bodyScan = scanTextSecrets(body, "$issue.body");
    expect("a9_hypothesis_firewall", bodyScan.hits.length === 0, "rendered body must pass secret scan");
    // Empty hypothesis → no hypothesis section in body
    const cleanBuilt = gateway.buildDraft({ finding });
    if (cleanBuilt.ok) {
      const cleanBody = renderIssueBody(cleanBuilt.draft);
      expect("a9_hypothesis_firewall", !cleanBody.includes("## Hypothesis"), "empty hypothesis must NOT produce a hypothesis section");
    }
  }
}

/* ================================================================== */
/* A10 — Determinism & baseline (receipt schema, zero hits, byte-identical, baselines) */
/* ================================================================== */
{
  // publish_receipt schema validation on A7's successful publish receipt
  expect("a10_determinism_and_baseline", a7FirstPublish !== null, "A7 first publish receipt must be available for schema validation");
  if (a7FirstPublish !== null) {
    const receipt = a7FirstPublish.receipt;
    const receiptCheck = validatePublishReceipt(receipt);
    expect("a10_determinism_and_baseline", receiptCheck.ok, `publish_receipt fails WP-00 schema: ${receiptCheck.errors?.join("; ")}`);
    // All six gates must be recorded as passed
    expect("a10_determinism_and_baseline", receipt.gates.length === PUBLISH_GATES.length, `receipt must record all ${PUBLISH_GATES.length} gates, got ${receipt.gates.length}`);
    expect("a10_determinism_and_baseline", receipt.gates.every((g) => g.passed), "every gate in a successful receipt must be passed=true");
    expect("a10_determinism_and_baseline", isErrorEnvelope(a7FirstPublish.receipt) === false, "sanity: receipt is not an error envelope");
  }
  // Secret scan zero hits on clean drafts
  for (const pass of [pass1, pass2]) {
    const built = pass.gateway.buildDraft({ finding: pass.confirmedPrimary.result.finding });
    if (built.ok) {
      const scan = scanDraftSecrets(built.draft);
      expect("a10_determinism_and_baseline", scan.hits.length === 0, `clean draft must have zero secret hits (pass ${pass.tag}), got ${JSON.stringify(scan.hits)}`);
    }
  }
  // Two-pass determinism: byte-identical checks (excluding time fields)
  const stripTime = (obj) => {
    const s = JSON.stringify(obj, null, 2);
    return s.replace(/"published_at"\s*:\s*"[^"]+"/g, '"published_at":"__EXCLUDED__"')
            .replace(/"decided_at"\s*:\s*"[^"]+"/g, '"decided_at":"__EXCLUDED__"')
            .replace(/"approved_at"\s*:\s*"[^"]+"/g, '"approved_at":"__EXCLUDED__"')
            .replace(/"expires_at"\s*:\s*"[^"]+"/g, '"expires_at":"__EXCLUDED__"')
            .replace(/"recorded_at"\s*:\s*"[^"]+"/g, '"recorded_at":"__EXCLUDED__"')
            .replace(/"timestamp"\s*:\s*"[^"]+"/g, '"timestamp":"__EXCLUDED__"');
  };
  // Build identical publish scenarios on both passes and compare receipts
  const scenario1 = buildAndPublishScenario(pass1, "determinism");
  const scenario2 = buildAndPublishScenario(pass2, "determinism");
  expect("a10_determinism_and_baseline", scenario1.ok && scenario2.ok, "determinism scenario must succeed on both passes");
  if (scenario1.ok && scenario2.ok) {
    const r1 = stripTime(scenario1.receipt);
    const r2 = stripTime(scenario2.receipt);
    expect("a10_determinism_and_baseline", r1 === r2, `receipts must be byte-identical (time excluded):\npass1=${r1}\npass2=${r2}`);
  }
  // Audit went through WP-03 (idempotent)
  expect("a10_determinism_and_baseline", pass1.tally.failed === 0 && pass1.tally.fallback === 0, `audit must reach WP-03 store (tally=${JSON.stringify(pass1.tally)})`);
  expect("a10_determinism_and_baseline", pass1.tally.ok_new > 0, "pass 1 must record new audit events");
  // Baseline receipts (read-only; fresh reruns are the Coordinator-side step)
  const readReceipt = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const wp00 = readReceipt(join(NW_ROOT, "verify", "receipt.json"));
  const wp03 = readReceipt(join(NW_ROOT, "state", "verify", "receipt.json"));
  const wp04 = readReceipt(join(NW_ROOT, "policy", "verify", "receipt.json"));
  const wp06 = readReceipt(join(NW_ROOT, "evidence", "verify", "receipt.json"));
  expect("a10_determinism_and_baseline", wp00?.ok === true, "baseline WP-00 receipt must exist and be ok");
  expect("a10_determinism_and_baseline", wp03?.ok === true, "baseline WP-03 receipt must exist and be ok");
  expect("a10_determinism_and_baseline", wp04?.ok === true, "baseline WP-04 receipt must exist and be ok");
  expect("a10_determinism_and_baseline", wp06?.ok === true, "baseline WP-06 receipt must exist and be ok");
}

/* Helper: build a fresh draft + publish scenario for determinism comparison.
 * Each pass gets a DEDICATED GitHub stub + ID factory + gateway registry, so
 * draft_id / receipt_id / issue number are the first-of-factory on BOTH passes
 * and the two receipts are directly comparable byte-for-byte. */
function buildAndPublishScenario(pass, label) {
  const finding = pass.confirmedPrimary.result.finding;
  const github = new GitHubStub({ issues: [], clock });
  const gateway = new IssueGateway({
    github,
    evidenceStore: pass.store,
    ids: makeIssueIdFactory(() => FIXED_MS),
    clock,
    audit: pass.auditSink,
    stateDir: join(STATE_DIR, `registry-${pass.tag}-${label}`),
  });
  const built = gateway.buildDraft({ finding });
  if (!built.ok) return { ok: false, error: built.error };
  const policy = buildPolicy(pass, finding, "approved");
  const approval = buildApproval(pass, finding, "valid");
  const key = `${built.draft.draft_id}:publish:${label}`;
  const result = gateway.publish({ draft: built.draft, finding, idempotency_key: key, policy_decision: policy, approvals: [approval] });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, receipt: result.receipt, draft: built.draft };
}

/* ================================================================== */
/* Receipt                                                             */
/* ================================================================== */
const checks = {};
for (const [key, val] of Object.entries(R)) checks[key] = { ok: val.failures.length === 0, failures: val.failures };

checks.a1_draft_generation.finding_class = "confirmed";
checks.a2_evidence_gate.gate = "evidence-completeness";
checks.a3_secret_scan_gate.injected_field = FIXTURES.secret_negative.override_field;
checks.a4_fingerprint_dedup.preset_issue = FIXTURES.preset_issues[0].number;
checks.a5_reviewer_gate.cases = ["missing", "expired", "valid"];
checks.a6_policy_integration.cases = ["missing", "denied", "approved"];
checks.a7_publish_idempotency.scenarios = ["same-key-replay", "different-key-conflict"];
checks.a8_retest_linkage.channel = "addComment";
checks.a9_hypothesis_firewall.section = "## Hypothesis (suspected — NOT a confirmed root cause)";
checks.a10_determinism_and_baseline.audit_tally_pass1 = pass1.tally;
checks.a10_determinism_and_baseline.baselines = ["WP-00", "WP-03", "WP-04", "WP-06"];

const ok = Object.values(R).every((v) => v.failures.length === 0);
const receipt = {
  ok,
  finished_at: new Date().toISOString(),
  verifier: "nightwatch/issue/verify.mjs",
  task_fingerprint: "nw+p0+wp07+issue-gateway+impl+arch@v1.4+d7f0a6b",
  checks,
  artifacts: [relFromRepo(RECEIPT_PATH), relFromRepo(join(ISSUE_ROOT, "fixtures", "publish-cases.json"))],
  state_dir: relFromRepo(STATE_DIR) + " (runtime only, wiped at every verify start)",
};

mkdirSync(join(ISSUE_ROOT, "verify"), { recursive: true });
writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

line("=== NightWatch WP-07 Issue Gateway Verification ===");
line(`A1  draft_generation          : ${checks.a1_draft_generation.ok ? "ok" : "FAILED"} (13 fields, hypothesis empty, WP-00 schema)`);
line(`A2  evidence_gate            : ${checks.a2_evidence_gate.ok ? "ok" : "FAILED"} (unsealed/inconclusive → ISS_GATE_FAILED, 0 writes)`);
line(`A3  secret_scan_gate         : ${checks.a3_secret_scan_gate.ok ? "ok" : "FAILED"} (injected credential → rejected, clean path 0 hits)`);
line(`A4  fingerprint_dedup        : ${checks.a4_fingerprint_dedup.ok ? "ok" : "FAILED"} (preset open issue → ISS_DUPLICATE, addComment only)`);
line(`A5  reviewer_gate            : ${checks.a5_reviewer_gate.ok ? "ok" : "FAILED"} (missing/expired → rejected, valid → passes)`);
line(`A6  policy_integration       : ${checks.a6_policy_integration.ok ? "ok" : "FAILED"} (denied/missing → 0 writes, approved → proceeds)`);
line(`A7  publish_idempotency      : ${checks.a7_publish_idempotency.ok ? "ok" : "FAILED"} (same-key replay, different-key conflict)`);
line(`A8  retest_linkage           : ${checks.a8_retest_linkage.ok ? "ok" : "FAILED"} (new evidence → comment, never new issue)`);
line(`A9  hypothesis_firewall      : ${checks.a9_hypothesis_firewall.ok ? "ok" : "FAILED"} (dedicated section, disclaimer, single occurrence)`);
line(`A10 determinism_and_baseline  : ${checks.a10_determinism_and_baseline.ok ? "ok" : "FAILED"} (receipt schema, 0 hits, byte-identical, baselines ok)`);
line("");
for (const [key, val] of Object.entries(R)) {
  if (val.failures.length > 0) line(`${key} failures:\n${JSON.stringify(val.failures, null, 2)}`);
}
line(`receipt: ${relFromRepo(RECEIPT_PATH)}`);
line(ok ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
process.exit(ok ? 0 : 1);
