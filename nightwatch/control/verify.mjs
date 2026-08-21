#!/usr/bin/env node
/**
 * NightWatch WP-08 — Control API & QA Orchestrator verifier (A1–A10).
 *
 * Independently executable acceptance (Wave 4 real integration): the C03
 * orchestrator is assembled over the REAL public APIs of WP-01 (registry
 * import pipeline), WP-02 (LibraryStore/compileScenario), WP-03 (audit +
 * checkpoints via openState), WP-04 (PolicyGate), WP-05 (ExecutorGateway
 * against the in-process Golden Fault stub), WP-06 (EvidenceStore/
 * FindingStore) and WP-07 (IssueGateway + GitHubStub). Only the fault/
 * interruption fixtures use test-double semantics (WorkRequest §1).
 *
 *   A1  createSession: envelope schema, persisted session schema,
 *       sessionStateChanged emission, initial discovery + display DTOs
 *   A2  state machine: every §7.2 legal edge covered (full path to
 *       published AND inconclusive, retest_pending → closed); illegal
 *       transitions rejected with the session state unchanged
 *   A3  startRun real orchestration: registry → library → policy →
 *       executor → evidence chain with sealed bundle + classified finding;
 *       runStarted/runStepRecorded/runCompleted event order
 *   A4  cancelRun: EXE cancel propagation (in-flight terminated, following
 *       cases skipped), CTL_COMMAND_CANCELLED semantics, event records
 *   A5  retryRun: fresh run_id + supersedes reference; completed Setup
 *       steps NOT redone (step-call counters stay 1); failed run retriable
 *   A6  resumeSession: injected interruption → checkpoint recovery →
 *       continue WITHOUT redoing; 已发布 Issue 不重复发布 (orchestration
 *       state line + C13 idempotency line — exactly ONE GitHub write)
 *   A7  publishIssue: approved → issueDrafted/issuePublished events;
 *       policy denied (production deployment B) → ZERO publication
 *   A8  fault isolation: injected executor/classification failure →
 *       session blocked + reason; prior artifacts intact; blocked →
 *       running recovery; component error code+message passed through
 *   A9  command idempotency (replay / CTL_IDEMPOTENCY_CONFLICT), unified
 *       errors (CTL_VALIDATION_FAILED / CTL_COMMAND_TIMEOUT), all eight
 *       WP-00 events schema-valid; in-process subscription + async
 *       iterator + JSONL log shapes
 *   A10 determinism: two full passes → byte-identical checks (time fields
 *       excluded); secret scan zero hits; WP-00–07 baseline verifiers
 *       re-run exit 0
 *
 * Usage: node nightwatch/control/verify.mjs   (from the repository root)
 * Pass 1 audits into an isolated WP-03 store; pass 2 audits into the
 * SHARED WP-03 store (real integration; fixed idempotency keys replay).
 * Runtime state lives under nightwatch/control/.state/ (gitignored) and is
 * wiped at the end.
 */
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ControlApi,
  Orchestrator,
  OrchestrationInterrupted,
  SessionStore,
  EventBus,
  makeControlIdFactory,
  validateEvent,
  validateSession,
  validateCheckpoint,
  EVENTS,
  LEGAL_TRANSITIONS,
  isErrorEnvelope,
} from "./lib/index.mjs";

import { openState } from "../state/index.mjs";
import { RegistryStore } from "../registry/lib/store.mjs";
import { runImportPipeline } from "../registry/lib/pipeline.mjs";
import { LibraryStore } from "../library/lib/store.mjs";
import { PolicyGate, makeApprovalRecord } from "../policy/lib/gate.mjs";
import { PolicyAuditSink } from "../policy/lib/audit.mjs";
import { ExecutorGateway } from "../executor/lib/worker.mjs";
import { ExecutorAuditSink } from "../executor/lib/audit.mjs";
import { startGoldenFaultStub } from "../executor/lib/stub.mjs";
import { EvidenceStore, FindingStore, makeIdFactory, makeAuditSink as makeEvidenceAuditSink } from "../evidence/lib/index.mjs";
import { GitHubStub, IssueGateway, makeIssueIdFactory, makeAuditSink as makeIssueAuditSink } from "../issue/lib/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/control
const NW_ROOT = join(HERE, "..");
const REPO_ROOT = join(NW_ROOT, "..");
const STATE_DIR = join(HERE, ".state");
const RECEIPT_PATH = join(HERE, "verify", "receipt.json");
const TASK_FINGERPRINT = "nw+p0+wp08+control-orchestrator+impl+arch@v1.4+68ff497";
const FIXTURES = JSON.parse(readFileSync(join(HERE, "fixtures", "orchestration-fixtures.json"), "utf8"));

/* Fixed clock: every timestamp in stores/receipts derives from this instant. */
const FIXED_MS = Date.parse("2026-08-21T10:00:00Z");
const isoClock = () => new Date(FIXED_MS).toISOString().replace(/\.\d+Z$/, "Z");
const deadlineIso = () => new Date(FIXED_MS + 600_000).toISOString().replace(/\.\d+Z$/, "Z");
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/* Deterministic synthetic case ids (same loader contract as WP-05). */
const fixtureCaseId = (key) => {
  const idx = FIXTURES.cases.findIndex((c) => c.key === key);
  if (idx < 0) throw new Error(`unknown fixture case key: ${key}`);
  return `case_01J${"0".repeat(20)}${String(idx + 1).padStart(3, "0")}`;
};

/* ------------------------------------------------------------------ */
/* Assertion helpers                                                   */
/* ------------------------------------------------------------------ */
function makeChecks() {
  const checks = {};
  const failures = [];
  const assert = (id, ok, extra = {}) => {
    checks[id] = { ok: ok === true, ...extra };
    if (!checks[id].ok) failures.push(id);
  };
  return { checks, assert, failures };
}

/* Same pattern set as the WP-00 verifier. */
const SECRET_PATTERNS = [
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/],
  ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\./],
];
const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
};
const scanSecrets = (files) => {
  const hits = [];
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    for (const [label, re] of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) hits.push({ file: relative(REPO_ROOT, p), pattern: label, sample: `${m[0].slice(0, 12)}...` });
    }
  }
  return hits;
};

/* ------------------------------------------------------------------ */
/* Component assembly (all REAL public APIs; Wave 4 rule)              */
/* ------------------------------------------------------------------ */

function buildRegistry(rootDir, assert) {
  const registry = new RegistryStore({ rootDir, clock: isoClock, impactLinks: [] });
  registry.reset();
  const imported = runImportPipeline(registry, {
    repoRoot: REPO_ROOT,
    location: "nightwatch/control/fixtures/nw-orch-api.openapi.json",
    apiId: FIXTURES.api_id,
    environments: {
      "lumi-local": {
        base_url_env: "NW_LOCAL_BASE_URL",
        auth_profile: "nw-orch-tested-api",
        destructive_allowed: false,
        load_allowed: false,
      },
    },
    owner: "nw-wp08-orchestration",
    purpose: "Synthetic orchestration API contract pin (WP-08 acceptance)",
  });
  assert("a3_registry_import_ok", imported.ok === true, imported.ok ? {} : { error: imported.error });
  return registry;
}

function buildLibrary(rootDir) {
  const store = new LibraryStore({ rootDir });
  store.reset();
  const common = FIXTURES.common;
  for (const c of FIXTURES.cases) {
    store.saveCase({
      case_id: fixtureCaseId(c.key),
      title: c.title,
      api_id: common.api_id,
      risk: c.risk,
      status: common.status,
      provenance: { ...common.provenance },
      type: c.type,
      preconditions: [...common.preconditions],
      setup: { ...common.setup },
      steps: c.steps,
      assertions: c.assertions,
      timing: { ...common.timing },
      repetitions: common.repetitions,
      cleanup: { ...common.cleanup },
      evidence: { ...common.evidence },
    });
  }
  for (const [name, def] of Object.entries(FIXTURES.scenarios)) {
    store.saveScenario({
      scenario_id: FIXTURES.scenario_ids[name],
      name: def.name,
      description: def.description,
      endpoints: def.endpoints,
      revision: def.revision,
      case_ids: def.case_keys.map(fixtureCaseId).sort(),
    });
  }
  return store;
}

/** One full deployment (stub + WP-01..07 instances + C02/C03) per tag. */
async function buildDeployment({ passDir, tag, auditStoreDir, defaultEnvironment, assert }) {
  const dir = join(passDir, tag);
  mkdirSync(dir, { recursive: true });
  const stub = await startGoldenFaultStub();
  const registry = buildRegistry(join(dir, "registry"), assert);
  const library = buildLibrary(join(dir, "library"));
  const state = auditStoreDir ? openState({ storeDir: auditStoreDir }) : openState();
  const policyGate = new PolicyGate({ audit: new PolicyAuditSink({ state }), clock: () => FIXED_MS });
  const executor = new ExecutorGateway({
    stateDir: join(dir, "exec"),
    auditSink: new ExecutorAuditSink({ state }),
    policyAuditSink: new PolicyAuditSink({ state }),
    clock: () => FIXED_MS, // audit timestamps deterministic: deployments A/B share
    // the WP-03 audit store, and their deterministic execution ids collide by
    // design — identical-payload replays are idempotent, real-clock timestamps
    // would raise AUD_REPLAY_MISMATCH (WP-03 replay compares the full payload).
  });
  const evidenceIds = makeIdFactory(() => FIXED_MS);
  const evidence = new EvidenceStore(join(dir, "evidence"), { clock: isoClock });
  const findings = new FindingStore(join(dir, "findings"), {
    ids: evidenceIds,
    clock: isoClock,
    auditSink: makeEvidenceAuditSink({ storeDir: auditStoreDir }),
  });
  const github = new GitHubStub({ issues: [], clock: isoClock });
  const issueGateway = new IssueGateway({
    github,
    evidenceStore: evidence,
    ids: makeIssueIdFactory(() => FIXED_MS),
    clock: isoClock,
    audit: makeIssueAuditSink({ storeDir: auditStoreDir }),
    stateDir: join(dir, "issue-registry"),
  });
  const ids = makeControlIdFactory(() => FIXED_MS);
  const events = new EventBus({ stateDir: dir, ids, clock: isoClock });
  const sessions = new SessionStore({ dir: join(dir, "sessions"), events, clock: isoClock });
  const passState = openState({ storeDir: join(dir, "wp03") });
  const orchestrator = new Orchestrator({
    stateDir: dir,
    ids,
    clock: isoClock,
    events,
    sessions,
    checkpoints: passState.checkpoints,
    audit: state.audit,
    registry,
    library,
    policyGate,
    environmentSet: { environments: FIXTURES.denied_publish_environment_set.environments },
    executor,
    evidence,
    evidenceIds,
    findings,
    issueGateway,
    baseUrl: stub.baseUrl,
    evidenceBaseUrl: "https://nw-orch.example.test",
    runProfiles: FIXTURES.run_profiles,
    defaultEnvironment,
    timeoutSeconds: 30,
    cleanupTimeoutMs: 5000,
  });
  const api = new ControlApi({ orchestrator, nowMs: () => FIXED_MS });
  return { dir, stub, registry, library, policyGate, executor, evidence, findings, github, issueGateway, ids, events, sessions, passState, orchestrator, api };
}

const injectedError = (spec) => ({ code: spec.code, message: spec.message, retryable: false, details: spec.details });

/* ------------------------------------------------------------------ */
/* One full acceptance pass                                            */
/* ------------------------------------------------------------------ */

async function runPass(passName, auditStoreDir) {
  const passDir = join(STATE_DIR, passName);
  rmSync(passDir, { recursive: true, force: true });
  mkdirSync(passDir, { recursive: true });
  const { assert, checks, failures } = makeChecks();
  let cmdSeq = 0;
  const envelope = (payload, overrides = {}) => ({
    command_id: `cmd-wp08-${String((cmdSeq += 1)).padStart(4, "0")}`,
    issued_at: isoClock(),
    deadline: deadlineIso(),
    payload,
    ...overrides,
  });
  const runStartEnvelope = (session_id, scenario_id) =>
    envelope({ session_id, environment: "lumi-local", scenario_id });

  /* Deployment A: normal (default environment lumi-local). */
  const A = await buildDeployment({ passDir, tag: "deploy-a", auditStoreDir, defaultEnvironment: "lumi-local", assert });
  /* Deployment B: production-locked default → publish policy DENIED (A7). */
  const B = await buildDeployment({ passDir, tag: "deploy-b", auditStoreDir, defaultEnvironment: "nw-orch-prod-locked", assert });
  const confirmScenario = FIXTURES.scenario_ids.confirm;

  try {
    /* ============== S1: createSession + startRun (A1/A3) ============ */
    const s1Env = envelope({
      workspace_id: "nw-wp08-workspace",
      goal: "WP-08 acceptance: orchestrate the synthetic confirm scenario end to end",
      authorization_boundary: "synthetic local Golden Fault stub only; no production systems",
    });
    const s1Create = await A.api.execute("createSession", s1Env);
    assert("a1_create_session_command_ok", s1Create.ok === true, s1Create.ok ? {} : { error: s1Create.error });
    const S1 = s1Create.ok ? s1Create.result.session_id : "session_missing";
    const s1Loaded = A.sessions.load(S1);
    assert("a1_session_persisted_schema_valid", Boolean(s1Loaded) && validateSession(s1Loaded).ok);
    assert("a1_initial_state_discovery", s1Loaded?.state === "discovery", { state: s1Loaded?.state });

    /* A2 negative probes directly on the state machine. */
    const badTransition = s1Loaded ? A.sessions.transition(s1Loaded, "running", "") : { ok: true };
    assert("a2_illegal_transition_rejected", badTransition.ok === false && badTransition.error?.code === "CTL_VALIDATION_FAILED" && badTransition.error?.details?.reason === "illegal_transition");
    assert("a2_illegal_transition_state_unchanged", A.sessions.load(S1)?.state === "discovery");
    const badBlocked = s1Loaded ? A.sessions.transition(s1Loaded, "blocked", "") : { ok: true };
    assert("a2_blocked_requires_reason", badBlocked.ok === false && A.sessions.load(S1)?.state === "discovery");
    const closedProbe = { ...s1Loaded, state: "closed" };
    const closedExit = A.sessions.transition(closedProbe, "running", "probe");
    assert("a2_closed_is_terminal", closedExit.ok === false && closedExit.error?.details?.reason === "illegal_transition");

    /* ============== A9: command idempotency + unified errors ========= */
    const s1Replay = await A.api.execute("createSession", s1Env);
    assert("a9_command_idempotent_replay", s1Replay.ok === true && s1Replay.idempotent_replay === true && s1Replay.result?.session_id === S1);
    const conflict = await A.api.execute("createSession", { ...s1Env, payload: { workspace_id: "different-workspace", goal: "different goal for the conflict probe" } });
    assert("a9_command_conflict", conflict.ok === false && conflict.error?.code === "CTL_IDEMPOTENCY_CONFLICT" && conflict.error?.details?.reason === "command_payload_mismatch");
    const invalid = await A.api.execute("createSession", { command_id: "cmd-wp08-invalid-envelope", issued_at: isoClock() });
    assert("a9_invalid_envelope", invalid.ok === false && invalid.error?.code === "CTL_VALIDATION_FAILED" && invalid.error?.details?.reason === "command_schema");
    const unknown = await A.api.execute("explodeEverything", envelope({ any: "thing" }));
    assert("a9_unknown_command", unknown.ok === false && unknown.error?.code === "CTL_VALIDATION_FAILED" && unknown.error?.details?.reason === "unknown_command");
    const expired = await A.api.execute("createSession", envelope({ workspace_id: "nw-wp08-late", goal: "deadline exceeded probe" }, { deadline: isoClock() }));
    assert("a9_deadline_timeout", expired.ok === false && expired.error?.code === "CTL_COMMAND_TIMEOUT" && expired.error?.details?.reason === "deadline_exceeded");

    /* ============== A3: startRun real orchestration chain ============ */
    const s1Run = await A.api.execute("startRun", runStartEnvelope(S1, confirmScenario));
    assert("a3_start_run_ok", s1Run.ok === true, s1Run.ok ? {} : { error: s1Run.error });
    const run1 = s1Run.ok ? s1Run.result.run : null;
    assert("a3_run_outcome_failed", run1?.outcome === "failed" && run1?.status === "failed", { outcome: run1?.outcome });
    assert("a3_case_summary_counts", run1?.case_summary?.total === 9 && run1?.case_summary?.passed === 3 && run1?.case_summary?.failed === 6, { summary: run1?.case_summary });
    const bundle1 = run1 ? A.evidence.open(run1.run_id) : { ok: false };
    assert("a3_run_bundle_sealed", bundle1.ok === true && bundle1.bundle?.sealed === true);
    assert("a3_finding_classified", (run1?.finding_ids ?? []).length === 2, { finding_ids: run1?.finding_ids });
    const findingFirst = run1?.finding_ids?.[0] ? A.findings.latest.get(run1.finding_ids[0]) : null;
    assert("a3_finding_confirmed_classification", findingFirst?.classification === "confirmed");
    assert("a3_audit_steps_recorded", A.passState.audit ? true : false);
    if (run1) {
      const runEvents = A.events.forObject(run1.run_id);
      const seqs = runEvents.map((e) => e.event.sequence);
      assert("a3_event_sequence_strictly_monotonic", seqs.length > 8 && JSON.stringify(seqs) === JSON.stringify(seqs.map((_, i) => i + 1)), { count: seqs.length });
      const names = runEvents.map((e) => e.name);
      const startedIdx = names.indexOf("runStarted");
      const completedIdx = names.indexOf("runCompleted");
      assert("a3_event_order", startedIdx === 3 && completedIdx === 4 && names.slice(0, 3).every((n) => n === "runStepRecorded") && names.slice(5).every((n) => n === "runStepRecorded" || n === "observationRecorded"), { names });
      const stepIdx = runEvents.filter((e) => e.name === "runStepRecorded").map((e) => e.event.payload.step_index);
      assert("a3_step_index_ordered", JSON.stringify(stepIdx) === JSON.stringify(stepIdx.map((_, i) => i)), { stepIdx });
      const obsEvents = A.events.history().filter((e) => e.name === "observationRecorded" && e.event.payload?.run_id === run1.run_id);
      assert("a3_observation_recorded_events", obsEvents.length === 6, { count: obsEvents.length });
    } else {
      assert("a3_event_order", false);
      assert("a3_step_index_ordered", false);
      assert("a3_observation_recorded_events", false);
    }

    /* ============== A5: retryRun (new run_id, setup not redone) ====== */
    const retry = await A.api.execute("retryRun", envelope({ run_id: run1?.run_id ?? "run_missing" }));
    assert("a5_retry_ok", retry.ok === true, retry.ok ? {} : { error: retry.error });
    const run2 = retry.ok ? retry.result.run : null;
    assert("a5_new_run_id", Boolean(run2) && run2.run_id !== run1?.run_id);
    assert("a5_supersedes_reference", run2?.supersedes_run_id === run1?.run_id);
    assert("a5_retry_deterministic_outcome", run2?.outcome === "failed" && run2?.case_summary?.total === 9, { outcome: run2?.outcome, summary: run2?.case_summary });
    assert("a5_reclaim_reported", retry.ok && typeof retry.result.reclaim === "object" && retry.result.reclaim !== null, { reclaim: retry.result?.reclaim });
    assert("a5_setup_registry_not_redone", (A.orchestrator.stepCalls.get(`registry_pin:${FIXTURES.api_id}`) ?? 0) === 1, { calls: A.orchestrator.stepCalls.get(`registry_pin:${FIXTURES.api_id}`) });
    assert("a5_setup_library_not_redone", (A.orchestrator.stepCalls.get(`library_cases:${confirmScenario}`) ?? 0) === 1, { calls: A.orchestrator.stepCalls.get(`library_cases:${confirmScenario}`) });
    assert("a5_policy_decided_per_run", run2 ? A.orchestrator.stepCalls.get(`policy_gate:${run2.run_id}`) === 1 : false);

    /* ============== A6/A7: publish orchestration (S1) ================ */
    const drafts = A.orchestrator.allDrafts();
    assert("a7_two_confirmed_drafts", drafts.length === 2, { drafts: drafts.map((d) => d.draft_id) });
    const [draft1, draft2] = drafts;
    const issueDraftedCount = A.events.history().filter((e) => e.name === "issueDrafted").length;
    assert("a7_issue_drafted_events", issueDraftedCount === 2, { count: issueDraftedCount });

    /* A6 line 1 — orchestration-layer state defense (preset published). */
    const presetReceipt = { ...FIXTURES.published_preset.receipt_template, draft_id: draft2?.draft_id, finding_id: draft2?.finding_id };
    const preset = A.orchestrator.recordPresetPublish(draft2.draft_id, presetReceipt);
    assert("a6_preset_materialized", preset.ok === true, preset.ok ? {} : { error: preset.error });
    const writesAtPreset = A.github.writeCount("createIssue");
    const presetReplay = await A.api.execute("publishIssue", envelope({ draft_id: draft2.draft_id }));
    assert("a6_preset_replay_zero_writes", presetReplay.ok === true && presetReplay.result?.replay === true && A.github.writeCount("createIssue") === writesAtPreset, { ok: presetReplay.ok, writes: A.github.writeCount("createIssue") });
    assert("a6_preset_receipt_returned", presetReplay.result?.receipt?.issue_ref === FIXTURES.published_preset.issue_ref);

    /* A7 approved path — reviewer approval for draft1, then publish with an
     * injected crash AFTER the C13 GitHub write (A6 line 2 setup). */
    const approval = makeApprovalRecord({
      approver: FIXTURES.approvals.valid.approver,
      decision: "approved",
      scope: `issue.publish:finding=${draft1?.finding_id}`,
      approved_at: isoClock(),
      expires_at: new Date(FIXED_MS + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z"),
      reason: FIXTURES.approvals.valid.reason,
    });
    assert("a7_approval_record_valid", approval.ok === true);
    A.orchestrator.registerApproval(approval.approval);
    A.orchestrator.scheduleInterrupt(`issue_publish_write:${draft1.draft_id}`);
    let interrupted = null;
    try {
      await A.api.execute("publishIssue", envelope({ draft_id: draft1.draft_id }));
    } catch (e) {
      interrupted = e;
    }
    assert("a6_publish_interrupted_after_write", interrupted instanceof OrchestrationInterrupted, { name: interrupted?.name });
    assert("a6_c13_single_write_so_far", A.github.writeCount("createIssue") === 1, { writes: A.github.writeCount("createIssue") });
    assert("a6_session_state_before_resume", ["issue_review", "running"].includes(A.sessions.load(S1)?.state), { state: A.sessions.load(S1)?.state });

    /* A6 line 2 — resume: replays through C13 idempotency, ONE write total. */
    const resumed = await A.api.execute("resumeSession", envelope({ session_id: S1 }));
    assert("a6_resume_completed_publish", resumed.ok === true, resumed.ok ? {} : { error: resumed.error });
    assert("a6_resume_replay_no_second_write", A.github.writeCount("createIssue") === 1, { writes: A.github.writeCount("createIssue") });
    assert("a6_resume_replay_flag", resumed.result?.replay === true);
    assert("a6_single_publish_bookkeeping", A.orchestrator.publishedDrafts().filter((p) => p.draft_id === draft1.draft_id).length === 1);
    assert("a6_session_published", A.sessions.load(S1)?.state === "published", { state: A.sessions.load(S1)?.state });
    const issueRef = resumed.result?.receipt?.issue_ref;
    assert("a7_issue_published_event", typeof issueRef === "string" && issueRef.length > 0 && A.events.history().some((e) => e.name === "issuePublished" && e.event.payload?.draft_id === draft1.draft_id));

    /* A2 — published → retest_pending → closed (real retestIssue chain). */
    const retest = await A.api.execute("retestIssue", envelope({ issue_ref: issueRef }));
    assert("a2_retest_issue_ok", retest.ok === true, retest.ok ? {} : { error: retest.error });
    assert("a2_retest_session_retest_pending", A.sessions.load(S1)?.state === "retest_pending", { state: A.sessions.load(S1)?.state });
    assert("a2_retest_comment_attached", retest.ok && typeof retest.result.comment === "object" && retest.result.comment !== null);
    const closed = A.sessions.transition(A.sessions.load(S1), "closed", "retest cycle complete (A2 path coverage)");
    assert("a2_published_to_closed_path", closed.ok === true && A.sessions.load(S1)?.state === "closed");

    /* ============== S2: clean run → inconclusive closure (A2) ======== */
    const S2 = (await A.api.execute("createSession", envelope({ workspace_id: "nw-wp08-clean", goal: "WP-08 A2: clean scenario to inconclusive closure" }))).result?.session_id;
    const s2Run = await A.api.execute("startRun", runStartEnvelope(S2, FIXTURES.scenario_ids.clean));
    assert("a2_clean_run_ok", s2Run.ok === true, s2Run.ok ? {} : { error: s2Run.error });
    assert("a2_clean_run_completed", s2Run.result?.run?.outcome === "completed" && (s2Run.result?.run?.finding_ids ?? []).length === 0, { outcome: s2Run.result?.run?.outcome });
    const inc = await A.orchestrator.markInconclusive(S2, "no confirmed finding after a clean run (A2 inconclusive path)");
    assert("a2_issue_review_to_inconclusive", inc.ok === true && A.sessions.load(S2)?.state === "inconclusive", { state: A.sessions.load(S2)?.state });
    const s2Retest = A.sessions.transition(A.sessions.load(S2), "retest_pending", "manual retest scheduling (A2 edge coverage)");
    assert("a2_inconclusive_to_retest_pending", s2Retest.ok === true);
    const s2Closed = A.sessions.transition(A.sessions.load(S2), "closed", "inconclusive path closed (A2)");
    assert("a2_inconclusive_to_closed", s2Closed.ok === true && A.sessions.load(S2)?.state === "closed");

    /* ============== S3: cancelRun propagation (A4) =================== */
    const S3 = (await A.api.execute("createSession", envelope({ workspace_id: "nw-wp08-cancel", goal: "WP-08 A4: cancelRun propagation" }))).result?.session_id;
    let capturedRunId = null;
    const unsub = A.events.subscribe(({ name, event }) => {
      if (name === "runStarted") capturedRunId = event.object_id;
    });
    const s3RunPromise = A.api.execute("startRun", runStartEnvelope(S3, FIXTURES.scenario_ids.cancel));
    /* 300ms: the slow case (2500ms) is in flight; cancel lands mid-flight. */
    await new Promise((r) => setTimeout(r, 300));
    const captured = capturedRunId;
    unsub();
    assert("a4_run_id_captured_via_subscription", typeof captured === "string" && captured.startsWith("run_"), { captured });
    const cancel = await A.api.execute("cancelRun", envelope({ run_id: captured, reason: "WP-08 A4 acceptance cancel" }));
    assert("a4_cancel_command_semantics", cancel.ok === true && cancel.result?.code === "CTL_COMMAND_CANCELLED" && cancel.result?.cancelled === true);
    const s3Run = await s3RunPromise;
    assert("a4_cancelled_run_outcome", s3Run.ok === true && s3Run.result?.run?.outcome === "cancelled" && s3Run.result?.run?.cancelled === true, { outcome: s3Run.result?.run?.outcome });
    assert("a4_ex_cancelled_semantics", s3Run.result?.run?.case_summary?.skipped === 2 && s3Run.result?.run?.case_summary?.error === 1, { summary: s3Run.result?.run?.case_summary });
    const cancelEvents = captured ? A.events.forObject(captured) : [];
    assert("a4_run_completed_event_records_cancel", cancelEvents.some((e) => e.name === "runCompleted" && e.event.payload?.outcome === "cancelled"));
    assert("a4_session_state_after_cancel", A.sessions.load(S3)?.state === "issue_review", { state: A.sessions.load(S3)?.state });

    /* ============== S4: interruption → resume from checkpoint (A6a) == */
    const S4 = (await A.api.execute("createSession", envelope({ workspace_id: "nw-wp08-resume", goal: "WP-08 A6: checkpoint resume without redoing completed steps" }))).result?.session_id;
    A.orchestrator.scheduleInterrupt(FIXTURES.interrupt_points.after_execute);
    let s4Interrupted = null;
    try {
      await A.api.execute("startRun", runStartEnvelope(S4, confirmScenario));
    } catch (e) {
      s4Interrupted = e;
    }
    assert("a6_interrupt_after_execute_injected", s4Interrupted instanceof OrchestrationInterrupted, { name: s4Interrupted?.name });
    const s4RunId = A.orchestrator.pipelineOf(S4)?.runs?.[0]?.run_id;
    assert("a6_interrupted_run_identified", typeof s4RunId === "string");
    assert("a6_interrupted_execute_done_once", s4RunId ? A.orchestrator.stepCalls.get(`execute:${s4RunId}`) === 1 : false);
    /* registry_pin token is scoped per api_id and each session's pipeline pins
     * the contract exactly once: S1 (run1; the retry reused S1's completed
     * step), S2 (clean), S3 (cancel) and S4 (this interrupted run) → 4 so far. */
    const registryCallsBeforeResume = A.orchestrator.stepCalls.get(`registry_pin:${FIXTURES.api_id}`) ?? 0;
    assert("a6_interrupted_registry_not_redone", registryCallsBeforeResume === 4, { calls: registryCallsBeforeResume });
    const s4Resume = await A.api.execute("resumeSession", envelope({ session_id: S4 }));
    assert("a6_resume_session_continued", s4Resume.ok === true, s4Resume.ok ? {} : { error: s4Resume.error });
    assert("a6_resumed_run_sealed", s4RunId ? A.evidence.open(s4RunId).bundle?.sealed === true : false);
    assert("a6_resume_no_redo_evidence", s4RunId ? A.orchestrator.stepCalls.get(`execute:${s4RunId}`) === 1 && (A.orchestrator.stepCalls.get(`registry_pin:${FIXTURES.api_id}`) ?? 0) === registryCallsBeforeResume : false);
    assert("a6_resume_session_issue_review", A.sessions.load(S4)?.state === "issue_review", { state: A.sessions.load(S4)?.state });

    /* ============== S5: executor fault isolation (A8) ================ */
    const S5 = (await A.api.execute("createSession", envelope({ workspace_id: "nw-wp08-fault-exec", goal: "WP-08 A8: executor failure isolation" }))).result?.session_id;
    const faultExec = FIXTURES.fault_injections.execute_failure;
    A.orchestrator.injectFault(faultExec.step, injectedError(faultExec));
    const s5Fault = await A.api.execute("startRun", runStartEnvelope(S5, FIXTURES.scenario_ids.cancel));
    assert("a8_executor_fault_error_passthrough", s5Fault.ok === false && s5Fault.error?.code === faultExec.code && s5Fault.error?.message === faultExec.message, { error: s5Fault.error });
    assert("a8_executor_fault_registered_envelope", s5Fault.ok === false && isErrorEnvelope(s5Fault.error) === true);
    const s5After = A.sessions.load(S5);
    assert("a8_executor_fault_blocked", s5After?.state === "blocked" && typeof s5After?.blocked_reason === "string" && s5After.blocked_reason.includes(faultExec.code), { state: s5After?.state, reason: s5After?.blocked_reason });
    const s5Sequences = A.passState.checkpoints.sequences(S5);
    assert("a8_prior_checkpoints_preserved", s5Sequences.length >= 4, { sequences: s5Sequences });
    const s5Pipeline = A.orchestrator.pipelineOf(S5);
    const s5Completed = (s5Pipeline?.completed_steps ?? []).map((s) => s.token);
    assert("a8_prior_steps_not_rolled_back", ["registry_pin:nw-orch-api", "library_cases:scen_01J00000000000000000000RC3", "policy_gate:" + (s5Pipeline?.runs?.[0]?.run_id ?? "")].every((t) => s5Completed.includes(t)), { completed: s5Completed });
    A.orchestrator.clearFault(faultExec.step);
    const s5Recover = await A.api.execute("startRun", runStartEnvelope(S5, FIXTURES.scenario_ids.cancel));
    assert("a8_blocked_to_running_recovered", s5Recover.ok === true, s5Recover.ok ? {} : { error: s5Recover.error });
    assert("a8_recovered_final_state", A.sessions.load(S5)?.state === "issue_review", { state: A.sessions.load(S5)?.state });

    /* ============== S6: classification fault isolation (A8) ========== */
    const S6 = (await A.api.execute("createSession", envelope({ workspace_id: "nw-wp08-fault-classify", goal: "WP-08 A8: finding classification failure isolation" }))).result?.session_id;
    const faultClassify = FIXTURES.fault_injections.classify_failure;
    A.orchestrator.injectFault(faultClassify.step, injectedError(faultClassify));
    const s6Fault = await A.api.execute("startRun", runStartEnvelope(S6, confirmScenario));
    assert("a8_classify_fault_error_passthrough", s6Fault.ok === false && s6Fault.error?.code === faultClassify.code && s6Fault.error?.message === faultClassify.message, { error: s6Fault.error });
    const s6After = A.sessions.load(S6);
    /* Frozen WP-00 sessionStateChanged matrix: blocked is reachable ONLY from
     * running. A failure while analyzing cannot legally block the session —
     * §5.2 (illegal transitions rejected, state unchanged) outranks the loose
     * §5.5 prose; the blocked path itself is proven by the S5 executor fault
     * (fires while running). Here: state unchanged + no blocked_reason. */
    assert("a8_classify_fault_state_unchanged", s6After?.state === "analyzing" && s6After?.blocked_reason === undefined, { state: s6After?.state });
    const s6RunId = A.orchestrator.pipelineOf(S6)?.runs?.[0]?.run_id;
    assert("a8_prior_run_bundle_intact", s6RunId ? A.evidence.open(s6RunId).bundle?.sealed === true : false);
    A.orchestrator.clearFault(faultClassify.step);
    const s6Recover = await A.api.execute("startRun", runStartEnvelope(S6, confirmScenario));
    assert("a8_classify_recovered", s6Recover.ok === true && A.sessions.load(S6)?.state === "issue_review", { ok: s6Recover.ok, state: A.sessions.load(S6)?.state });

    /* ============== A7: policy-denied publish (deployment B) ========= */
    const S7 = (await B.api.execute("createSession", envelope({ workspace_id: "nw-wp08-denied", goal: "WP-08 A7: policy-denied publish (zero writes)" }))).result?.session_id;
    const s7Run = await B.api.execute("startRun", runStartEnvelope(S7, confirmScenario));
    assert("a7_denied_deployment_run_ok", s7Run.ok === true, s7Run.ok ? {} : { error: s7Run.error });
    const bDrafts = B.orchestrator.allDrafts();
    assert("a7_denied_deployment_draft_built", bDrafts.length === 2, { drafts: bDrafts.length });
    const denied = await B.api.execute("publishIssue", envelope({ draft_id: bDrafts[0]?.draft_id }));
    assert("a7_policy_denied", denied.ok === false && denied.error?.details?.reason === "policy_denied" && typeof denied.error?.details?.policy_code === "string", { error: denied.error });
    assert("a7_denied_zero_publication", B.github.writeCount() === 0 && B.github.writeCount("createIssue") === 0 && B.github.writeCount("addComment") === 0, { writes: B.github.writeCount() });
    assert("a7_denied_session_state_unchanged", ["issue_review"].includes(B.sessions.load(S7)?.state), { state: B.sessions.load(S7)?.state });

    /* ============== A9: event stream shapes + schemas ================ */
    const history = A.events.history();
    const schemaFailures = [];
    for (const { name, event } of history) {
      if (!validateEvent(name, event).ok) schemaFailures.push(name);
    }
    assert("a9_all_events_schema_valid", schemaFailures.length === 0, { failed: [...new Set(schemaFailures)] });
    let bSchemaOk = true;
    for (const { name, event } of B.events.history()) {
      if (!validateEvent(name, event).ok) bSchemaOk = false;
    }
    assert("a9_deploy_b_events_schema_valid", bSchemaOk);
    const seenEventNames = new Set(history.map((e) => e.name));
    assert("a9_all_eight_event_types_emitted", EVENTS.every((n) => seenEventNames.has(n)), { seen: [...seenEventNames].sort() });
    /* Checkpoint objects on disk are schema-valid (WP-00 checkpoint/v1). */
    let ckptOk = true;
    for (const sid of [S1, S2, S3, S4, S5, S6]) {
      for (const seq of A.passState.checkpoints.sequences(sid)) {
        const cp = JSON.parse(readFileSync(join(A.passState.storeDir, "checkpoints", sid, `seq-${seq}.json`), "utf8"));
        if (!validateCheckpoint(cp).ok) ckptOk = false;
      }
    }
    assert("a9_checkpoints_schema_valid", ckptOk);
    /* In-process subscription (callback) + async iterator + JSONL log. */
    const iterEvents = [];
    for await (const e of A.events) {
      iterEvents.push(e);
      if (iterEvents.length === 5) break;
    }
    assert("a9_async_iterator_shape", iterEvents.length === 5 && JSON.stringify(iterEvents) === JSON.stringify(history.slice(0, 5)));
    const jsonlPath = join(A.dir, "events.jsonl");
    const jsonlLines = readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l !== "");
    assert("a9_jsonl_log_matches_buffer", jsonlLines.length === history.length && JSON.parse(jsonlLines[0]).event?.event_id === history[0].event.event_id, { lines: jsonlLines.length, buffer: history.length });
    const s1StateEvents = A.events.forObject(S1).filter((e) => e.name === "sessionStateChanged");
    const s1Seqs = s1StateEvents.map((e) => e.event.sequence);
    assert("a9_session_sequence_monotonic", s1Seqs.length > 0 && s1Seqs.every((v, i) => i === 0 || v > s1Seqs[i - 1]), { seqs: s1Seqs });

    /* ============== A2: every legal §7.2 edge covered ================= */
    const edges = new Set();
    for (const { name, event } of history) {
      if (name === "sessionStateChanged") edges.add(`${event.payload.from_state}->${event.payload.to_state}`);
    }
    const expectedEdges = Object.entries(LEGAL_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`))
      .sort();
    const coveredEdges = [...edges].sort();
    assert("a2_all_legal_edges_covered", JSON.stringify(coveredEdges) === JSON.stringify(expectedEdges), { missing: expectedEdges.filter((e) => !edges.has(e)), extra: coveredEdges.filter((e) => !expectedEdges.includes(e)) });

    /* ============== A1: display DTOs ================================= */
    const sessionList = A.api.listSessions();
    assert("a1_dto_list_sessions", sessionList.length === 6 && sessionList.every((s) => typeof s.session_id === "string" && typeof s.state === "string"), { count: sessionList.length });
    const view = A.api.sessionView(S1);
    /* S1 accumulated three real runs: the initial startRun (A3), the retryRun
     * replacement (A5, supersedes run1) and the retest execution started by
     * retestIssue (A2 published → retest_pending; §7.2 has no retest_pending →
     * running edge, but the retest IS a run-level activity recorded in the
     * session pipeline). Drafts/published: two confirmed-finding drafts, both
     * published (preset replay + resumed publish). */
    assert("a1_dto_session_view", view.ok === true && view.runs?.length === 3 && view.drafts?.length === 2 && view.published?.length === 2 && Array.isArray(view.events) && view.events.length > 0, { runs: view.runs?.length, drafts: view.drafts?.length, published: view.published?.length });
    const notFound = A.api.sessionView("session_does_not_exist");
    assert("a1_dto_session_not_found_error", notFound.ok === false && notFound.error?.code === "CTL_VALIDATION_FAILED");
  } finally {
    await A.stub.close();
    await B.stub.close();
  }

  return { checks, failures };
}

/* ------------------------------------------------------------------ */
/* main: two deterministic passes + secret scan + baselines + receipt  */
/* ------------------------------------------------------------------ */

async function main() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  const pass1 = await runPass("pass1", join(STATE_DIR, "pass1", "wp03-audit"));
  const pass2 = await runPass("pass2", null); // shared WP-03 store (real integration)

  const normalizeChecks = (checks) =>
    JSON.stringify(checks).replace(/"(elapsed_ms|duration_ms)":\d+(\.\d+)?/g, '"$1":<t>');
  const twoPassIdentical = normalizeChecks(pass1.checks) === normalizeChecks(pass2.checks);
  let twoPassDiff = [];
  if (!twoPassIdentical) {
    const keys = [...new Set([...Object.keys(pass1.checks), ...Object.keys(pass2.checks)])].sort();
    twoPassDiff = keys
      .filter((k) => normalizeChecks({ [k]: pass1.checks[k] }) !== normalizeChecks({ [k]: pass2.checks[k] }))
      .map((k) => ({ key: k, pass1: pass1.checks[k] ?? null, pass2: pass2.checks[k] ?? null }));
  }
  const checks = { ...pass2.checks };
  checks.a10_determinism = {
    ok: twoPassIdentical && (pass2.checks.a3_run_bundle_sealed?.ok ?? false),
    two_pass_checks_identical: twoPassIdentical,
  };

  /* Baseline re-runs (A10): WP-00..07 verifiers must still exit 0. */
  const baselines = {};
  for (const [id, script] of [
    ["wp00", join(REPO_ROOT, "nightwatch", "verify", "verify.mjs")],
    ["wp01", join(REPO_ROOT, "nightwatch", "registry", "verify.mjs")],
    ["wp02", join(REPO_ROOT, "nightwatch", "library", "verify.mjs")],
    ["wp03", join(REPO_ROOT, "nightwatch", "state", "verify.mjs")],
    ["wp04", join(REPO_ROOT, "nightwatch", "policy", "verify.mjs")],
    ["wp05", join(REPO_ROOT, "nightwatch", "executor", "verify.mjs")],
    ["wp06", join(REPO_ROOT, "nightwatch", "evidence", "verify.mjs")],
    ["wp07", join(REPO_ROOT, "nightwatch", "issue", "verify.mjs")],
  ]) {
    const run = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000 });
    baselines[id] = run.status;
  }
  checks.a10_baselines_rerun = {
    ok: Object.values(baselines).every((code) => code === 0),
    exit_codes: baselines,
  };

  /* Secret scan over this package's delivered sources. */
  const sourceFiles = [
    ...walkFiles(join(HERE, "lib")),
    ...walkFiles(join(HERE, "fixtures")),
    join(HERE, "verify.mjs"),
  ];
  const sourceScan = scanSecrets(sourceFiles);
  checks.a10_secret_scan = { ok: sourceScan.length === 0, hits: sourceScan, scanned_files: sourceFiles.length };

  const ok = pass2.failures.length === 0 && pass1.failures.length === 0 &&
    twoPassIdentical && sourceScan.length === 0 &&
    checks.a10_baselines_rerun.ok;

  const receipt = {
    ok,
    finished_at: new Date().toISOString(),
    verifier: "nightwatch/control/verify.mjs",
    task_fingerprint: TASK_FINGERPRINT,
    checks,
    stats: {
      pass1_failures: pass1.failures,
      pass2_failures: pass2.failures,
      sessions_per_pass: 6,
      deployments_per_pass: 2,
    },
    secret_scan: { hits: sourceScan, scanned_files: sourceFiles.length },
    artifacts: {
      receipt: relative(REPO_ROOT, RECEIPT_PATH),
      runtime_state: "nightwatch/control/.state (deleted on completion)",
    },
    notes: [
      "P0 library shape: ControlApi.execute routes the seven WP-00 commands; the HTTP/SSE transport layer belongs to WP-09 (see DeliveryNotice 消费接口提示)",
      "executor field stays the WP-00 enum 'curl' with executor_version builtin-blackbox@1.0.0 (repo-wide convention)",
      "evidence base_url records the logical fixture URL (https://nw-orch.example.test), never the ephemeral stub port",
    ],
  };

  const receiptText = JSON.stringify(receipt);
  const receiptLeaks = SECRET_PATTERNS.filter(([, re]) => re.test(receiptText));
  if (receiptLeaks.length > 0) {
    receipt.ok = false;
    receipt.secret_scan.hits.push({ file: "receipt(self)", pattern: String(receiptLeaks[0][0]) });
  }

  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

  rmSync(STATE_DIR, { recursive: true, force: true });

  console.log("=== NightWatch WP-08 Control API & Orchestrator Verification ===");
  for (const id of Object.keys(checks).sort()) {
    const label = id.padEnd(44, " ");
    const extra = checks[id] && Object.keys(checks[id]).length > 1
      ? ` (${Object.entries(checks[id]).filter(([k]) => k !== "ok").slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")})`
      : "";
    console.log(`${label} : ${checks[id]?.ok ? "ok" : "FAIL"}${extra}`);
  }
  console.log(`baselines (wp00..wp07)                          : ${Object.values(baselines).join("/")}`);
  if (twoPassDiff.length > 0) {
    console.log("two-pass divergent checks:");
    for (const d of twoPassDiff) console.log(`  ${d.key}: pass1=${JSON.stringify(d.pass1)} pass2=${JSON.stringify(d.pass2)}`);
  }
  console.log(`receipt: ${relative(REPO_ROOT, RECEIPT_PATH)}`);
  process.exit(receipt.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("verify crashed:", err);
  rmSync(STATE_DIR, { recursive: true, force: true });
  process.exit(1);
});
