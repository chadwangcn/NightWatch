/**
 * NightWatch WP-10 — E2E orchestration assembly (WorkRequest §5.5, A6).
 *
 * Assembles ONE full in-process deployment of REAL public components
 * (WP-01..WP-07 constructors + WP-08 Control API/Orchestrator), exactly
 * in the shape documented by wiring.mjs (WP-09), but pointing the
 * ExecutorGateway at the REAL Golden Fault API (§20.2) instead of the
 * WP-08 synthetic stub. The Golden API is a 127.0.0.1 node:http service
 * carrying the FROZEN defect set from fixtures/defect-manifest.json.
 *
 * The scenario library is the golden-manual-cases.json fixture (25 cases:
 * 4 baseline + 3×7 defect probes), imported into the WP-02 LibraryStore
 * through its public loader contract (same as WP-08 fixtures).
 *
 * This module exposes the ControlApi seven-command closed loop:
 *
 *   createSession → startRun(Golden API scenario)
 *     → runCompleted + Evidence Seal → findingClassified → issueDrafted
 *     → registerApproval (scope=issue.publish:finding=…)
 *     → publishIssue (GitHubStub, exactly one write)
 *     → retestIssue (scenario re-run, reproduction rate updated)
 *
 * Every step goes through the REAL public APIs — NO component data-plane
 * is read directly at runtime. HTTP servers are closed in finally by the
 * caller via the returned `close()` method.
 *
 * Determinism: the clock is injected by the caller (verify pins it);
 * the Golden Fault API uses fixed seeds/nonces, so the same inputs always
 * produce the same outputs on every port and in every pass.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlApi, Orchestrator, SessionStore, EventBus, makeControlIdFactory } from "../../control/lib/index.mjs";

import { openState } from "../../state/index.mjs";
import { RegistryStore } from "../../registry/lib/store.mjs";
import { runImportPipeline } from "../../registry/lib/pipeline.mjs";
import { LibraryStore } from "../../library/lib/store.mjs";
import { compileScenario } from "../../library/lib/compile.mjs";
import { transitionCase } from "../../library/lib/lifecycle.mjs";
import { PolicyGate } from "../../policy/lib/gate.mjs";
import { PolicyAuditSink } from "../../policy/lib/audit.mjs";
import { ExecutorGateway } from "../../executor/lib/worker.mjs";
import { ExecutorAuditSink } from "../../executor/lib/audit.mjs";
import { EvidenceStore, FindingStore, makeIdFactory, makeAuditSink as makeEvidenceAuditSink } from "../../evidence/lib/index.mjs";
import { IssueGateway, GitHubStub, makeIssueIdFactory, makeAuditSink as makeIssueAuditSink } from "../../issue/lib/index.mjs";

import { startGoldenFaultApi } from "./golden-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/migration/lib
const MIGRATION_ROOT = join(HERE, "..");
const REPO_ROOT = join(MIGRATION_ROOT, "..", "..");

const GOLDEN_CASES = JSON.parse(readFileSync(join(MIGRATION_ROOT, "fixtures", "golden-manual-cases.json"), "utf8"));
const GOLDEN_MANIFEST = JSON.parse(readFileSync(join(MIGRATION_ROOT, "fixtures", "defect-manifest.json"), "utf8"));

export const GOLDEN_API_ID = GOLDEN_MANIFEST.api_id; // "nw-golden-api"

// Deterministic ULID (26 chars, Crockford base32) for the golden scenario.
// The WP-00 schema requires scenario_id to match ^scen_[0-9A-HJKMNP-TV-Z]{26}$.
// We derive a stable 26-char ULID from the GOLDEN_API_ID via sha256 → base32.
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I/L/O/U
function deriveUlid(seed) {
  const hash = createHash("sha256").update(seed).digest();
  let id = "";
  for (let i = 0; i < 26; i++) {
    id += ULID_ALPHABET[hash[i % hash.length] % 32];
  }
  return id;
}
export const GOLDEN_SCENARIO_ID = `scen_${deriveUlid("nw-golden-api-defect-sweep")}`;

/** Deterministic case id (same loader contract as WP-05/WP-08). */
function goldenCaseId(key) {
  const idx = GOLDEN_CASES.cases.findIndex((c) => c.key === key);
  if (idx < 0) throw new Error(`unknown golden case key: ${key}`);
  return `case_01J${"0".repeat(20)}${String(idx + 1).padStart(3, "0")}`;
}

/** Deterministic case_type → WP-02 library type mapping (from golden-manual-cases.json). */
function caseTypeFor(kind) {
  const map = GOLDEN_CASES.common.case_type_by_kind;
  return map[kind] ?? "functional";
}

function buildGoldenRegistry(rootDir) {
  const registry = new RegistryStore({ rootDir, clock: () => new Date(0).toISOString(), impactLinks: [] });
  registry.reset();
  const imported = runImportPipeline(registry, {
    repoRoot: REPO_ROOT,
    location: "nightwatch/migration/fixtures/golden-api.openapi.json",
    apiId: GOLDEN_API_ID,
    environments: {
      "golden-local": {
        base_url_env: "NW_GOLDEN_BASE_URL",
        auth_profile: "nw-golden-bearer",
        destructive_allowed: false,
        load_allowed: false,
      },
    },
    owner: "nw-wp10-e2e",
    purpose: "Golden Fault API contract pin (NW-WP-10 §5.3)",
  });
  if (!imported.ok) throw new Error(`golden registry import failed: ${JSON.stringify(imported.error)}`);
  return registry;
}

function buildGoldenLibrary(rootDir) {
  const store = new LibraryStore({ rootDir });
  store.reset();
  const common = GOLDEN_CASES.common;
  const scenarioDef = GOLDEN_CASES.scenario;
  for (const c of GOLDEN_CASES.cases) {
    const defect = GOLDEN_MANIFEST.defects.find((d) => d.defect_id === c.defect_id);
    const caseType = caseTypeFor(defect?.kind ?? "none-baseline");
    store.saveCase({
      case_id: goldenCaseId(c.key),
      title: c.title,
      api_id: GOLDEN_API_ID,
      risk: common.risk,
      status: "reviewed",
      provenance: { source_revision: scenarioDef.revision, generated_by: "nw-wp10-golden-fixture", skill_version: "fixture@1", last_validated_run: null },
      type: caseType,
      preconditions: ["golden-fault API running on 127.0.0.1"],
      setup: { workflow: "none" },
      steps: c.steps,
      assertions: c.assertions,
      timing: { per_request_timeout_ms: 10000 },
      repetitions: 1,
      cleanup: { workflow: "none" },
      evidence: { capture_timeline: true, capture_request_response: "failures", redact_profile: "nw-default" },
    });
  }
  // Lifecycle: advance every case to validated through the public API.
  for (const caseId of store.listCaseIds()) {
    const oneCase = store.getCase(caseId);
    if (!oneCase || oneCase.status === "validated") continue;
    const chain = oneCase.status === "draft" ? ["reviewed", "validated"] : ["validated"];
    for (const to of chain) {
      const moved = transitionCase(store, caseId, to, { actor: "nw-wp10-e2e" });
      if (!moved.ok) throw new Error(`lifecycle transition ${caseId} → ${to} failed: ${moved.error?.message}`);
    }
  }
  const caseIds = store.listCaseIds().sort();
  store.saveScenario({
    scenario_id: GOLDEN_SCENARIO_ID,
    name: scenarioDef.name,
    description: scenarioDef.description,
    endpoints: scenarioDef.endpoints,
    revision: scenarioDef.revision,
    case_ids: caseIds,
  });
  return store;
}

/** Environment set for the Golden Fault API (local, no production gating). */
const GOLDEN_ENVIRONMENTS = {
  environments: [
    {
      environment: "golden-local",
      classification: "local",
      base_url_env: "NW_GOLDEN_BASE_URL",
      credential_profile: "nw-golden-bearer",
      health_checks: [{ method: "GET", path: "/widgets/100" }],
      data_namespace: "nw-golden",
      limits: { max_requests: 1000, max_duration_seconds: 300, max_parallelism: 1 },
      capabilities: { destructive: false, fuzzing: false, load: false },
    },
  ],
};

/** Run profile for the golden defect sweep scenario (25 cases, 1 repetition). */
const GOLDEN_RUN_PROFILE = {
  [GOLDEN_SCENARIO_ID]: { api_id: GOLDEN_API_ID, seed: 424242, repetitions: 1 },
};

/**
 * Build one full E2E deployment against the REAL Golden Fault API.
 *
 * @param {object} options
 *   stateDir           — runtime root for this deployment
 *   auditStoreDir      — WP-03 store dir for audit/checkpoints (isolated)
 *   defaultEnvironment — "golden-local" (default)
 *   nowMs              — epoch ms clock injected into every component
 * @returns {Promise<{dir, golden, registry, library, policyGate, executor,
 *                    evidence, findings, github, issueGateway, ids, events,
 *                    sessions, passState, orchestrator, api, close(): Promise<void>}>}
 */
export async function buildE2EDeployment({ stateDir, auditStoreDir, defaultEnvironment = "golden-local", nowMs }) {
  if (!stateDir || !auditStoreDir) throw new TypeError("buildE2EDeployment requires stateDir and auditStoreDir");
  if (typeof nowMs !== "function") throw new TypeError("buildE2EDeployment requires a nowMs clock");
  const clock = () => new Date(nowMs()).toISOString().replace(/\.\d+Z$/, "Z");

  /* REAL Golden Fault API (§20.2) — NOT the WP-08 synthetic stub. */
  const golden = await startGoldenFaultApi();
  const registry = buildGoldenRegistry(join(stateDir, "registry"));
  const library = buildGoldenLibrary(join(stateDir, "library"));
  const state = openState({ storeDir: auditStoreDir });
  const policyGate = new PolicyGate({ audit: new PolicyAuditSink({ state }), clock: nowMs });
  const executor = new ExecutorGateway({
    stateDir: join(stateDir, "exec"),
    auditSink: new ExecutorAuditSink({ state }),
    policyAuditSink: new PolicyAuditSink({ state }),
    clock: nowMs,
  });
  const evidenceIds = makeIdFactory(nowMs);
  const evidence = new EvidenceStore(join(stateDir, "evidence"), { clock });
  const findings = new FindingStore(join(stateDir, "findings"), {
    ids: evidenceIds,
    clock,
    auditSink: makeEvidenceAuditSink({ storeDir: auditStoreDir }),
  });
  const github = new GitHubStub({ issues: [], clock });
  const issueGateway = new IssueGateway({
    github,
    evidenceStore: evidence,
    ids: makeIssueIdFactory(nowMs),
    clock,
    audit: makeIssueAuditSink({ storeDir: auditStoreDir }),
    stateDir: join(stateDir, "issue-registry"),
  });
  const ids = makeControlIdFactory(nowMs);
  const events = new EventBus({ stateDir, ids, clock });
  const sessions = new SessionStore({ dir: join(stateDir, "sessions"), events, clock });
  const orchestrator = new Orchestrator({
    stateDir,
    ids,
    clock,
    events,
    sessions,
    checkpoints: state.checkpoints,
    audit: state.audit,
    registry,
    library,
    policyGate,
    environmentSet: GOLDEN_ENVIRONMENTS,
    executor,
    evidence,
    evidenceIds,
    findings,
    issueGateway,
    baseUrl: golden.baseUrl,
    evidenceBaseUrl: "https://nw-golden.example.test",
    runProfiles: GOLDEN_RUN_PROFILE,
    defaultEnvironment,
    timeoutSeconds: 30,
    cleanupTimeoutMs: 5000,
  });
  const api = new ControlApi({ orchestrator, nowMs });

  const close = async () => {
    await golden.close();
  };
  return { dir: stateDir, golden, registry, library, policyGate, executor, evidence, findings, github, issueGateway, ids, events, sessions, passState: state, orchestrator, api, close };
}

/**
 * Drive the full seven-command closed loop (A6) against the REAL Golden
 * Fault API through the ControlApi. Returns a structured result so verify
 * can assert each step.
 *
 * Usage:
 *   const D = await buildE2EDeployment({...});
 *   try {
 *     const loop = await runClosedLoop(D, { nowMs });
 *   } finally { await D.close(); }
 *
 * @param {object} D       — deployment returned by buildE2EDeployment
 * @param {object} options
 *   nowMs   — fixed clock (deterministic)
 *   approver— approval record approver name
 *   interruptStep — optional: schedule an OrchestrationInterrupted after this
 *                   step token, then resumeSession must recover without a
 *                   duplicate publish (§5.5 recovery double-line)
 * @returns {Promise<object>} — {session_id, run, drafts, receipt, retest, steps}
 */
export async function runClosedLoop(D, { nowMs, approver = "nw-synthetic-reviewer", interruptStep = null } = {}) {
  const { api, orchestrator } = D;
  const isoFixed = () => new Date(nowMs()).toISOString().replace(/\.\d+Z$/, "Z");
  const isoPlus = (ms) => new Date(nowMs() + ms).toISOString().replace(/\.\d+Z$/, "Z");

  let cmdSeq = 0;
  const envelope = (payload, overrides = {}) => ({
    command_id: `cmd-wp10-e2e-${String((cmdSeq += 1)).padStart(4, "0")}`,
    issued_at: isoFixed(),
    deadline: isoPlus(600_000),
    payload,
    ...overrides,
  });

  const steps = {};

  /* ---- Step 1: createSession ------------------------------------- */
  const createEnv = envelope({
    workspace_id: "nw-wp10-e2e-workspace",
    goal: "WP-10 E2E: Golden Fault defect sweep through the full closed loop",
    authorization_boundary: "local Golden Fault API on 127.0.0.1 only; no production systems",
  });
  if (interruptStep) orchestrator.scheduleInterrupt(interruptStep);
  const created = await api.execute("createSession", createEnv);
  steps.createSession = created;
  if (!created.ok) return { steps, error: created.error };
  const sessionId = created.result.session_id;

  /* ---- Step 2: startRun (Golden API scenario) -------------------- */
  const startEnv = envelope({ session_id: sessionId, environment: "golden-local", scenario_id: GOLDEN_SCENARIO_ID });
  const started = await api.execute("startRun", startEnv);
  steps.startRun = started;
  if (!started.ok) return { steps, error: started.error, session_id: sessionId };
  const run = started.result.run;

  /* ---- Step 3: publishIssue (requires approval first) ----------- */
  // After startRun, confirmed findings produce issue drafts. We register
  // an approval for each confirmed finding's draft, then publish.
  const view = api.sessionView(sessionId);
  const drafts = view.drafts ?? [];
  steps.drafts = drafts;

  const receipts = [];
  for (const draft of drafts) {
    const approvalRecord = {
      approver,
      decision: "approved",
      scope: `issue.publish:finding=${draft.finding_id}`,
      approved_at: isoFixed(),
      expires_at: isoPlus(3_600_000),
      reason: "WP-10 E2E: reviewer approves the confirmed finding for publish",
    };
    orchestrator.registerApproval(approvalRecord);

    const publishEnv = envelope({ draft_id: draft.draft_id });
    const published = await api.execute("publishIssue", publishEnv);
    if (published.ok) receipts.push(published.result.receipt);
  }
  steps.publishIssue = { receipts, count: receipts.length };

  /* ---- Step 4: retestIssue (scenario re-run) --------------------- */
  const retestResults = [];
  if (receipts.length > 0) {
    const retestEnv = envelope({ issue_ref: receipts[0].issue_ref, session_id: sessionId });
    const retested = await api.execute("retestIssue", retestEnv);
    steps.retestIssue = retested;
    if (retested.ok) retestResults.push(retested.result);
  }

  return {
    session_id: sessionId,
    run,
    drafts,
    receipts,
    retest: retestResults,
    steps,
  };
}
