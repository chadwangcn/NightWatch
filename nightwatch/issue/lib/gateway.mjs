/**
 * NightWatch WP-07 — Issue Gateway (C13, §5.9 / §5.11 / §5.5)
 *
 * The ONLY GitHub write exit of the system. Publish flow (frozen contract):
 *
 *   1. Idempotency layer — same key + same draft → replay of the original
 *      outcome (zero new writes); same key + different draft →
 *      ISS_IDEMPOTENCY_CONFLICT; same draft + different key (already
 *      published) → ISS_IDEMPOTENCY_CONFLICT (WorkRequest §5.3).
 *   2. Policy Gate — consumes a WP-04 policy_decision for
 *      `issue.publish:finding=<id>`: approved & unexpired → proceed;
 *      denied / missing / expired / scope-mismatch → POL_DENIED, ZERO writes.
 *   3. Six §5.9 gates, evaluated IN ORDER; any failure → ISS_GATE_FAILED,
 *      zero GitHub writes:
 *        evidence-completeness → secret-scan → fingerprint-dedup →
 *        minimal-reproduction → environment-scope → reviewer
 *      (gate 3 fingerprint hit DIVERTS to the append-comment path with
 *       ISS_DUPLICATE — one addComment write, zero createIssue).
 *   4. All gates pass → single createIssue → WP-00 publish_receipt (all six
 *      gates recorded passed) → audit via the WP-03 public API.
 *
 * Retest linkage (§5.5): new evidence is appended to the EXISTING issue as a
 * sanitized comment; the retest channel structurally never creates issues.
 *
 * No real network: all GitHub interaction goes through the injected client
 * (local stub in P0; a real adapter is a WP-10 concern).
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSealedForConsumption,
  fingerprintHash,
  validateFinding,
  DEFAULT_REPRODUCTION_GATE,
} from "../../evidence/lib/index.mjs";
import { findValidApproval, makeApprovalRecord } from "../../policy/lib/gate.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validateIssueDraft, validatePublishReceipt, validatePolicyDecision, validateApprovalRecord } from "./schemas.mjs";
import { scanDraftSecrets, scanTextSecrets } from "./secret-scan.mjs";
import { buildDraft } from "./draft.mjs";
import { renderIssueTitle, renderIssueBody, renderDedupComment, renderRetestComment } from "./render.mjs";
import { C13_ACTOR, ISSUE_ACTIONS } from "./audit.mjs";

/** The six §5.9 gates in frozen evaluation order (matches publish_receipt schema enum). */
export const PUBLISH_GATES = [
  "evidence-completeness",
  "secret-scan",
  "fingerprint-dedup",
  "minimal-reproduction",
  "environment-scope",
  "reviewer",
];

/** Publish-time reproducibility threshold (gate 4; confirmed findings are rate=1 by derivation). */
export const MIN_REPRODUCE_RATE = 0.5;

/** Approval scope format (approval_record/v1 description: 'issue.publish:finding=find_...'). */
const approvalScopeFor = (findingId) => `issue.publish:finding=${findingId}`;

/** Deep-sorted canonical JSON (stable idempotency fingerprints). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Build a schema-validated policy_decision (wiring helper for callers/fixtures). */
export function makePolicyDecision({ decision, reason, requested_action, decided_by, decided_at, expires_at, conditions }) {
  const record = { decision, reason, requested_action, decided_by, decided_at, expires_at };
  if (conditions !== undefined) record.conditions = conditions;
  const sr = validatePolicyDecision(record);
  if (!sr.ok) {
    return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "policy decision failed schema validation", { errors: sr.errors }) };
  }
  return { ok: true, decision: record };
}

export { makeApprovalRecord };

export class IssueGateway {
  /**
   * @param {object} options
   *   github       — GitHub client (local stub in P0): searchIssues/getIssue/
   *                  createIssue/addComment
   *   evidenceStore— WP-06 EvidenceStore (read-only consumption; sealed
   *                  bundle verification at publish time)
   *   ids          — {draftId(), receiptId()} from makeIssueIdFactory
   *   clock        — () => ISO string (deterministic in verify)
   *   audit        — audit sink (makeAuditSink(); WP-03 public API)
   *   stateDir?    — publish-registry persistence dir (JSONL, append-only);
   *                  omitted → in-memory registry (idempotency lifetime =
   *                  gateway instance)
   */
  constructor({ github, evidenceStore, ids, clock, audit = null, stateDir = null }) {
    if (!github) throw new TypeError("IssueGateway requires a GitHub client (stub)");
    if (!evidenceStore) throw new TypeError("IssueGateway requires a WP-06 EvidenceStore");
    if (!ids) throw new TypeError("IssueGateway requires an id factory");
    this.github = github;
    this.store = evidenceStore;
    this.ids = ids;
    this.clock = clock;
    this.audit = audit;
    this.stateDir = stateDir;
    this._byKey = new Map(); // idempotency_key → registry entry
    this._byDraft = new Map(); // draft fingerprint → idempotency_key
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true });
      this._registryPath = join(stateDir, "publish-registry.jsonl");
      if (existsSync(this._registryPath)) {
        for (const line of readFileSync(this._registryPath, "utf8").split("\n")) {
          if (line.trim() === "") continue;
          const entry = JSON.parse(line);
          this._byKey.set(entry.idempotency_key, entry);
          this._byDraft.set(entry.draft_fingerprint, entry.idempotency_key);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Draft generation (§14 template)                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Build a draft from a confirmed finding, assembling run evidence from the
   * Evidence Index (sealed + unsealed runs containing the finding's
   * observations; publish gate 1 later enforces sealed + checksum integrity).
   */
  buildDraft({ finding, overrides = {} }) {
    const index = this.store.readIndex();
    const wanted = new Set(finding.observation_ids ?? []);
    const runs = [];
    for (const entry of index.runs) {
      const obsIds = entry.observations.filter((id) => wanted.has(id));
      if (obsIds.length === 0) continue;
      const opened = this.store.open(entry.run_id);
      if (!opened.ok) return { ok: false, error: opened.error };
      const observations = opened.bundle.readObservations().filter((o) => obsIds.includes(o.observation_id));
      runs.push({ run_id: entry.run_id, manifest: opened.bundle.ctx, observations });
    }
    return buildDraft({ finding, runs, ids: this.ids, overrides });
  }

  /* ---------------------------------------------------------------- */
  /* Publish (six gates + policy + idempotency)                        */
  /* ---------------------------------------------------------------- */

  /**
   * Publish a draft as a GitHub issue.
   * @param {object} input
   *   draft           — WP-00 issue_draft/v1 object
   *   finding         — the authoritative WP-00 finding the draft was built from
   *   idempotency_key — recommended form `<draft_id>:publish` (§5.3)
   *   policy_decision — WP-00 policy_decision/v1 (approved) from WP-04
   *   approvals       — approval_record[] (reviewer gate; §5.9 gate 6)
   */
  publish({ draft, finding, idempotency_key, policy_decision, approvals = [] }) {
    if (typeof idempotency_key !== "string" || idempotency_key.length === 0 || idempotency_key.length > 128) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "idempotency_key is required (1..128 chars)", { reason: "invalid_idempotency_key" }) };
    }
    const draftCheck = validateIssueDraft(draft);
    if (!draftCheck.ok) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "draft failed WP-00 issue_draft schema validation", { reason: "draft_schema", errors: draftCheck.errors }) };
    }
    const findingCheck = validateFinding(finding);
    if (!findingCheck.ok) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "finding failed WP-00 schema validation", { reason: "finding_schema", errors: findingCheck.errors }) };
    }
    if (draft.finding_id !== finding.finding_id) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "draft.finding_id does not match the supplied finding", { reason: "finding_mismatch", draft_finding_id: draft.finding_id, finding_id: finding.finding_id }) };
    }

    const draftFingerprint = canonicalJson(draft);

    // -- 1. Idempotency layer ------------------------------------------
    const existing = this._byKey.get(idempotency_key);
    if (existing) {
      if (existing.draft_fingerprint !== draftFingerprint) {
        return {
          ok: false,
          error: makeError(ERROR_CODES.IDEMPOTENCY_CONFLICT, `idempotency key "${idempotency_key}" replayed with a different draft payload`, {
            reason: "key_payload_mismatch",
            idempotency_key,
          }),
        };
      }
      return this._replayOutcome(existing);
    }
    const existingKeyForDraft = this._byDraft.get(draftFingerprint);
    if (existingKeyForDraft !== undefined && existingKeyForDraft !== idempotency_key) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.IDEMPOTENCY_CONFLICT, `this draft was already published under idempotency key "${existingKeyForDraft}"; republishing under a different key is forbidden`, {
          reason: "draft_already_published",
          idempotency_key,
          existing_key: existingKeyForDraft,
        }),
      };
    }

    // -- 2. Policy Gate (WP-04 policy_decision consumption) -------------
    const policy = this._checkPolicy(policy_decision, finding);
    if (!policy.ok) return { ok: false, error: policy.error };

    // -- 3. Six §5.9 gates, in frozen order -----------------------------
    for (const gate of PUBLISH_GATES) {
      const result = this._evaluateGate(gate, { draft, finding, approvals });
      if (result.ok) continue;
      if (gate === "fingerprint-dedup" && result.duplicate) {
        // §5.11 dedup path: append ONE comment to the existing open issue,
        // never create a new issue (the only write on this path).
        return this._duplicateOutcome({ draft, finding, duplicate: result.duplicate, idempotency_key, draftFingerprint });
      }
      return {
        ok: false,
        error: makeError(ERROR_CODES.GATE_FAILED, `publish gate "${gate}" rejected the draft: ${result.reason}`, {
          gate,
          reason: result.reason,
          ...(result.details ?? {}),
        }),
      };
    }

    // -- 4. Single createIssue + receipt + audit ------------------------
    const title = renderIssueTitle(finding);
    const body = renderIssueBody(draft);
    const bodyScan = scanTextSecrets(body, "$issue.body");
    if (bodyScan.hits.length > 0) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.GATE_FAILED, "rendered issue body failed the secret scan", { gate: "secret-scan", reason: "secret_scan_hit", hits: bodyScan.hits }),
      };
    }
    const created = this.github.createIssue({
      title,
      body,
      labels: draft.labels ?? [],
      fingerprint_hash: fingerprintHash(finding.fingerprint),
    });
    if (!created.ok) return { ok: false, error: created.error };

    const receipt = {
      receipt_id: this.ids.receiptId(),
      draft_id: draft.draft_id,
      issue_ref: this.github.issueRef(created.issue.number),
      idempotency_key,
      published_at: this.clock(),
      gates: PUBLISH_GATES.map((gate) => ({ gate, passed: true })),
    };
    const receiptCheck = validatePublishReceipt(receipt);
    if (!receiptCheck.ok) {
      // Defensive: a frozen-contract violation must surface, not publish a
      // schema-invalid receipt. (The stub write already happened — recorded
      // in the stub write log; P0 fixtures never reach this branch.)
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "publish receipt failed WP-00 schema validation", { reason: "receipt_schema", errors: receiptCheck.errors }) };
    }

    this._audit(ISSUE_ACTIONS.publish, "publish_receipt", receipt.receipt_id, idempotency_key);

    const entry = { idempotency_key, draft_fingerprint: draftFingerprint, outcome: "published", receipt, issue_ref: receipt.issue_ref };
    this._register(entry);
    return { ok: true, replay: false, receipt, issue: created.issue };
  }

  /* ---------------------------------------------------------------- */
  /* Retest linkage (§5.5)                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Append a sanitized retest comment (new evidence index + conclusion) to an
   * EXISTING issue. This channel structurally NEVER creates a new issue.
   * @param {object} input
   *   finding         — WP-00 finding AFTER retest aggregation
   *   issue_ref       — existing external issue reference (e.g. "org/repo#42")
   *   new_evidence    — [{run_id, evidence_refs: string[], summary?}]
   *   conclusion      — retest conclusion (external symptom statement)
   *   idempotency_key — recommended `<draft_id>:retest` or `<finding_id>:retest:<run>`
   */
  attachRetest({ finding, issue_ref, new_evidence, conclusion, idempotency_key }) {
    if (typeof idempotency_key !== "string" || idempotency_key.length === 0 || idempotency_key.length > 128) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "idempotency_key is required (1..128 chars)", { reason: "invalid_idempotency_key" }) };
    }
    const findingCheck = validateFinding(finding);
    if (!findingCheck.ok) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "finding failed WP-00 schema validation", { reason: "finding_schema", errors: findingCheck.errors }) };
    }
    if (!Array.isArray(new_evidence) || new_evidence.length === 0 || typeof conclusion !== "string" || conclusion.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "retest requires new_evidence[] and a non-empty conclusion", { reason: "invalid_retest_payload" }) };
    }
    const existing = this._byKey.get(idempotency_key);
    if (existing) {
      if (existing.outcome !== "retest-comment") {
        return { ok: false, error: makeError(ERROR_CODES.IDEMPOTENCY_CONFLICT, `idempotency key "${idempotency_key}" was used for a different action`, { reason: "key_payload_mismatch", idempotency_key }) };
      }
      const fp = canonicalJson({ finding, issue_ref, new_evidence, conclusion });
      if (existing.draft_fingerprint !== fp) {
        return { ok: false, error: makeError(ERROR_CODES.IDEMPOTENCY_CONFLICT, `idempotency key "${idempotency_key}" replayed with a different retest payload`, { reason: "key_payload_mismatch", idempotency_key }) };
      }
      return { ok: true, replay: true, issue_ref: existing.issue_ref, comment: { id: existing.comment_id, body: existing.comment_body } };
    }

    const issueNumber = Number(String(issue_ref).split("#")[1]);
    const got = this.github.getIssue(issueNumber);
    if (!got.ok) return { ok: false, error: got.error };
    if (got.issue.state !== "open") {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `issue ${issue_ref} is not open; retest comments target open issues`, { reason: "issue_not_open", issue_ref }) };
    }

    const body = renderRetestComment({ finding, new_evidence, conclusion, at: this.clock() });
    const bodyScan = scanTextSecrets(body, "$retest.comment");
    if (bodyScan.hits.length > 0) {
      return { ok: false, error: makeError(ERROR_CODES.GATE_FAILED, "retest comment failed the secret scan; append blocked", { gate: "secret-scan", reason: "secret_scan_hit", hits: bodyScan.hits }) };
    }
    const commented = this.github.addComment({ issue_number: issueNumber, body });
    if (!commented.ok) return { ok: false, error: commented.error };

    this._audit(ISSUE_ACTIONS.retestComment, "github_issue", issue_ref, idempotency_key);
    const entry = {
      idempotency_key,
      draft_fingerprint: canonicalJson({ finding, issue_ref, new_evidence, conclusion }),
      outcome: "retest-comment",
      issue_ref,
      comment_id: commented.comment.id,
      comment_body: commented.comment.body,
    };
    this._register(entry);
    return { ok: true, replay: false, issue_ref, comment: commented.comment };
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                          */
  /* ---------------------------------------------------------------- */

  _checkPolicy(policyDecision, finding) {
    if (policyDecision === undefined || policyDecision === null) {
      return { ok: false, error: makeError(ERROR_CODES.POLICY_DENIED, "no policy decision supplied for the publish action; zero-write policy applies", { reason: "policy_decision_missing" }) };
    }
    const sr = validatePolicyDecision(policyDecision);
    if (!sr.ok) {
      return { ok: false, error: makeError(ERROR_CODES.POLICY_DENIED, "policy decision failed WP-00 schema validation", { reason: "policy_decision_invalid", errors: sr.errors }) };
    }
    const expectedAction = `issue.publish:finding=${finding.finding_id}`;
    if (policyDecision.requested_action !== expectedAction) {
      return { ok: false, error: makeError(ERROR_CODES.POLICY_DENIED, "policy decision scope does not cover this publish action", { reason: "policy_scope_mismatch", expected_action: expectedAction, requested_action: policyDecision.requested_action }) };
    }
    if (policyDecision.decision !== "approved") {
      return { ok: false, error: makeError(ERROR_CODES.POLICY_DENIED, "policy decision denied the publish action", { reason: "policy_decision_denied", decided_by: policyDecision.decided_by }) };
    }
    if (Date.parse(policyDecision.expires_at) <= Date.parse(this.clock())) {
      return { ok: false, error: makeError(ERROR_CODES.POLICY_DENIED, "policy decision has expired; expired decisions are rejected, never auto-extended (§22.5.4)", { reason: "policy_decision_expired", expires_at: policyDecision.expires_at }) };
    }
    return { ok: true };
  }

  _evaluateGate(gate, { draft, finding, approvals }) {
    switch (gate) {
      case "evidence-completeness":
        return this._gateEvidenceCompleteness(draft, finding);
      case "secret-scan":
        return this._gateSecretScan(draft);
      case "fingerprint-dedup":
        return this._gateFingerprintDedup(draft, finding);
      case "minimal-reproduction":
        return this._gateMinimalReproduction(draft, finding);
      case "environment-scope":
        return this._gateEnvironmentScope(draft, finding);
      case "reviewer":
        return this._gateReviewer(draft, approvals);
      default:
        return { ok: false, reason: `unknown gate "${gate}"` };
    }
  }

  /** Gate 1: sealed + checksum-verified bundles; confirmed finding; coverage. */
  _gateEvidenceCompleteness(draft, finding) {
    if (finding.classification !== "confirmed") {
      return { ok: false, reason: "finding_not_confirmed", details: { classification: finding.classification } };
    }
    if (finding.reproduction.attempts < DEFAULT_REPRODUCTION_GATE.min_attempts) {
      return { ok: false, reason: "reproduction_below_gate", details: { attempts: finding.reproduction.attempts, min_attempts: DEFAULT_REPRODUCTION_GATE.min_attempts } };
    }
    const runRefs = draft.artifacts.filter((a) => a.kind === "run").map((a) => a.ref);
    if (runRefs.length === 0) return { ok: false, reason: "no_run_reference" };
    const coveredObservations = new Set();
    for (const runId of runRefs) {
      const opened = this.store.open(runId);
      if (!opened.ok) return { ok: false, reason: "run_not_found", details: { run_id: runId } };
      const sealedCheck = assertSealedForConsumption(opened.bundle); // EVD_NOT_SEALED-class rejection path
      if (!sealedCheck.ok) {
        return { ok: false, reason: "bundle_not_sealed", details: { run_id: runId, upstream_code: sealedCheck.error.code } };
      }
      const verified = opened.bundle.verifySealed(); // per-file checksums + payload digest
      if (!verified.ok) {
        return { ok: false, reason: "checksum_verification_failed", details: { run_id: runId, mismatches: (verified.mismatches ?? []).slice(0, 5) } };
      }
      for (const obs of opened.bundle.readObservations()) coveredObservations.add(obs.observation_id);
    }
    const missing = (finding.observation_ids ?? []).filter((id) => !coveredObservations.has(id));
    if (missing.length > 0) {
      return { ok: false, reason: "evidence_coverage_gap", details: { missing_observation_ids: missing.slice(0, 5) } };
    }
    return { ok: true };
  }

  /** Gate 2: zero credential-shaped residue in the WHOLE draft. */
  _gateSecretScan(draft) {
    const { hits } = scanDraftSecrets(draft);
    if (hits.length > 0) {
      return { ok: false, reason: "secret_scan_hit", details: { hits } };
    }
    return { ok: true };
  }

  /** Gate 3: fingerprint match against OPEN issues → duplicate divert. */
  _gateFingerprintDedup(draft, finding) {
    const hash = fingerprintHash(finding.fingerprint);
    const { ok, issues } = this.github.searchIssues({ state: "open", fingerprint_hash: hash });
    if (!ok) return { ok: false, reason: "dedup_query_failed" };
    if (issues.length > 0) {
      return { ok: false, reason: "fingerprint_duplicate", duplicate: issues[0] };
    }
    return { ok: true };
  }

  /** Gate 4: non-empty steps consistent with evidence + rate threshold. */
  _gateMinimalReproduction(draft, finding) {
    if (!Array.isArray(draft.minimal_reproduction) || draft.minimal_reproduction.length === 0) {
      return { ok: false, reason: "minimal_reproduction_empty" };
    }
    if (draft.reproducibility.rate < MIN_REPRODUCE_RATE) {
      return { ok: false, reason: "reproducibility_below_threshold", details: { rate: draft.reproducibility.rate, threshold: MIN_REPRODUCE_RATE } };
    }
    if (canonicalJson(draft.reproducibility) !== canonicalJson(finding.reproduction)) {
      return { ok: false, reason: "reproducibility_mismatch", details: { draft: draft.reproducibility, finding: finding.reproduction } };
    }
    const methodPath = finding.fingerprint.normalized_method_path;
    if (!draft.minimal_reproduction.some((step) => step.includes(methodPath))) {
      return { ok: false, reason: "reproduction_steps_mismatch", details: { expected_reference: methodPath } };
    }
    return { ok: true };
  }

  /** Gate 5: environment/scope non-empty and consistent with run manifests. */
  _gateEnvironmentScope(draft, finding) {
    if (!draft.environment?.environment_name || !draft.environment?.spec_revision || !draft.scope_boundary) {
      return { ok: false, reason: "environment_or_scope_empty" };
    }
    for (const artifact of draft.artifacts.filter((a) => a.kind === "run")) {
      const opened = this.store.open(artifact.ref);
      if (!opened.ok) return { ok: false, reason: "run_not_found", details: { run_id: artifact.ref } };
      const manifest = opened.bundle.ctx;
      if (manifest.environment_name !== draft.environment.environment_name || manifest.contract_pin.source_revision !== draft.environment.spec_revision) {
        return {
          ok: false,
          reason: "environment_mismatch",
          details: { run_id: artifact.ref, manifest_environment: manifest.environment_name, manifest_revision: manifest.contract_pin.source_revision, draft_environment: draft.environment.environment_name, draft_revision: draft.environment.spec_revision },
        };
      }
    }
    return { ok: true };
  }

  /** Gate 6: valid (approved, unexpired) approval_record via WP-04 semantics. */
  _gateReviewer(draft, approvals) {
    for (const approval of approvals ?? []) {
      const sr = validateApprovalRecord(approval);
      if (!sr.ok) return { ok: false, reason: "approval_record_invalid", details: { errors: sr.errors } };
    }
    const status = findValidApproval(approvals ?? [], { scope: approvalScopeFor(draft.finding_id), nowMs: Date.parse(this.clock()) });
    if (status.status === "valid") return { ok: true };
    const reason = { none: "approval_missing", expired: "approval_expired", denied: "approval_denied" }[status.status];
    return { ok: false, reason, details: { scope: approvalScopeFor(draft.finding_id) } };
  }

  _duplicateOutcome({ draft, finding, duplicate, idempotency_key, draftFingerprint }) {
    const body = renderDedupComment({ draft, finding });
    const bodyScan = scanTextSecrets(body, "$dedup.comment");
    if (bodyScan.hits.length > 0) {
      return { ok: false, error: makeError(ERROR_CODES.GATE_FAILED, "dedup comment failed the secret scan; append blocked", { gate: "secret-scan", reason: "secret_scan_hit", hits: bodyScan.hits }) };
    }
    const commented = this.github.addComment({ issue_number: duplicate.number, body });
    if (!commented.ok) return { ok: false, error: commented.error };
    this._audit(ISSUE_ACTIONS.dedupComment, "issue_draft", draft.draft_id, `${draft.draft_id}:dedup-comment`);
    const entry = {
      idempotency_key,
      draft_fingerprint: draftFingerprint,
      outcome: "duplicate",
      issue_ref: this.github.issueRef(duplicate.number),
      comment_id: commented.comment.id,
      comment_body: commented.comment.body,
      duplicate_of: duplicate.number,
    };
    this._register(entry);
    return {
      ok: false,
      error: makeError(ERROR_CODES.DUPLICATE, `fingerprint matches open issue ${entry.issue_ref}; reproduction info appended as a comment, no new issue created`, {
        reason: "fingerprint_duplicate",
        issue_ref: entry.issue_ref,
        comment_id: commented.comment.id,
        appended: true,
      }),
      duplicate: { issue_ref: entry.issue_ref, issue_number: duplicate.number, comment_id: commented.comment.id, appended: true },
    };
  }

  _replayOutcome(entry) {
    if (entry.outcome === "published") {
      return { ok: true, replay: true, receipt: entry.receipt };
    }
    if (entry.outcome === "duplicate") {
      return {
        ok: false,
        replay: true,
        error: makeError(ERROR_CODES.DUPLICATE, `fingerprint matches open issue ${entry.issue_ref}; reproduction info appended as a comment, no new issue created`, {
          reason: "fingerprint_duplicate",
          issue_ref: entry.issue_ref,
          comment_id: entry.comment_id,
          appended: true,
        }, { idempotentReplay: true }),
        duplicate: { issue_ref: entry.issue_ref, comment_id: entry.comment_id, appended: true },
      };
    }
    return { ok: true, replay: true, issue_ref: entry.issue_ref, comment: { id: entry.comment_id, body: entry.comment_body } };
  }

  _register(entry) {
    this._byKey.set(entry.idempotency_key, entry);
    this._byDraft.set(entry.draft_fingerprint, entry.idempotency_key);
    if (this._registryPath) {
      appendFileSync(this._registryPath, `${JSON.stringify(entry)}\n`, "utf8");
    }
  }

  _audit(action, objectType, objectId, idempotencyKey) {
    if (!this.audit) return { ok: true, skipped: true };
    return this.audit.record({
      actor: C13_ACTOR,
      action,
      objectType,
      objectId,
      timestamp: this.clock(),
      idempotencyKey,
    });
  }
}
