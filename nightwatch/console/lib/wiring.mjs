/**
 * NightWatch WP-09 — Console deployment wiring (C01/C02 transport binding)
 *
 * Assembles ONE full in-process deployment of REAL public components
 * (WP-01..WP-07 constructors + the WP-08 Control API/Orchestrator), exactly
 * in the shape documented by the WP-08 DeliveryNotice §6:
 *
 *   RegistryStore + import pipeline → LibraryStore → openState() (WP-03
 *   audit/checkpoints) → PolicyGate → ExecutorGateway (against the local
 *   Golden Fault stub) → EvidenceStore/FindingStore → IssueGateway +
 *   GitHubStub → EventBus/SessionStore → Orchestrator → ControlApi.
 *
 * Runtime rule (WorkRequest §5.1): the wiring below is the ONLY place that
 * touches component constructors; every user-reachable operation afterwards
 * goes through the four C02 surfaces — ControlApi.execute,
 * orchestrator.registerApproval, EventBus and listSessions/sessionView.
 * No component data-plane file is read directly at runtime.
 *
 * The orchestration fixtures are REUSED read-only from
 * nightwatch/control/fixtures/orchestration-fixtures.json (WorkRequest §5.1
 * allows exactly this); new console fixtures would live under
 * nightwatch/console/fixtures/.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlApi, Orchestrator, SessionStore, EventBus, makeControlIdFactory } from "../../control/lib/index.mjs";

import { openState } from "../../state/index.mjs";
import { RegistryStore } from "../../registry/lib/store.mjs";
import { runImportPipeline } from "../../registry/lib/pipeline.mjs";
import { LibraryStore } from "../../library/lib/store.mjs";
import { PolicyGate } from "../../policy/lib/gate.mjs";
import { PolicyAuditSink } from "../../policy/lib/audit.mjs";
import { ExecutorGateway } from "../../executor/lib/worker.mjs";
import { ExecutorAuditSink } from "../../executor/lib/audit.mjs";
import { startGoldenFaultStub } from "../../executor/lib/stub.mjs";
import { EvidenceStore, FindingStore, makeIdFactory, makeAuditSink as makeEvidenceAuditSink } from "../../evidence/lib/index.mjs";
import { GitHubStub, IssueGateway, makeIssueIdFactory, makeAuditSink as makeIssueAuditSink } from "../../issue/lib/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/console/lib
const CONSOLE_ROOT = join(HERE, "..");
// Fixtures are REUSED read-only from the WP-08 orchestration fixtures file
// (WorkRequest §5.1 allows exactly this reuse).
const FIXTURES = JSON.parse(readFileSync(join(CONSOLE_ROOT, "..", "control", "fixtures", "orchestration-fixtures.json"), "utf8"));

/** Deterministic synthetic case ids (same loader contract as WP-05/WP-08). */
const fixtureCaseId = (key) => {
  const idx = FIXTURES.cases.findIndex((c) => c.key === key);
  if (idx < 0) throw new Error(`unknown fixture case key: ${key}`);
  return `case_01J${"0".repeat(20)}${String(idx + 1).padStart(3, "0")}`;
};

function buildRegistry(rootDir) {
  const registry = new RegistryStore({ rootDir, clock: () => new Date(0).toISOString(), impactLinks: [] });
  registry.reset();
  const imported = runImportPipeline(registry, {
    repoRoot: join(CONSOLE_ROOT, "..", ".."),
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
    owner: "nw-wp09-console",
    purpose: "Synthetic orchestration API contract pin (WP-09 console wiring)",
  });
  if (!imported.ok) throw new Error(`registry import failed: ${JSON.stringify(imported.error)}`);
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

/**
 * Build one full console deployment.
 *
 * @param {object} options
 *   stateDir           — runtime root for this deployment (pipelines, events,
 *                        component stores; gitignored .state pattern)
 *   auditStoreDir      — WP-03 store dir for audit/checkpoints (isolated per
 *                        caller; the shared default is NEVER used by the
 *                        console, so verify reruns cannot pollute it)
 *   defaultEnvironment — "lumi-local" (approved) or the production-locked
 *                        fixture environment (policy-denied publish path)
 *   nowMs              — epoch ms clock injected into every component
 *                        (verify pins it for determinism; the CLI passes the
 *                        real wall clock)
 * @returns {Promise<{dir, stub, registry, library, policyGate, executor,
 *                    evidence, findings, github, issueGateway, ids, events,
 *                    sessions, passState, orchestrator, api, close(): Promise<void>}>}
 */
export async function buildDeployment({ stateDir, auditStoreDir, defaultEnvironment, nowMs }) {
  if (!stateDir || !auditStoreDir) throw new TypeError("buildDeployment requires stateDir and auditStoreDir");
  if (typeof nowMs !== "function") throw new TypeError("buildDeployment requires a nowMs clock");
  const clock = () => new Date(nowMs()).toISOString().replace(/\.\d+Z$/, "Z");

  const stub = await startGoldenFaultStub();
  const registry = buildRegistry(join(stateDir, "registry"));
  const library = buildLibrary(join(stateDir, "library"));
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
  const api = new ControlApi({ orchestrator, nowMs });

  const close = async () => {
    await stub.close();
  };
  return { dir: stateDir, stub, registry, library, policyGate, executor, evidence, findings, github, issueGateway, ids, events, sessions, passState: state, orchestrator, api, close };
}

export { FIXTURES };
