#!/usr/bin/env node
/**
 * NightWatch WP-04 — Acceptance Verifier (verify.mjs)
 *
 * Independently executable (no services, no HTTP, no network). Exercises every
 * acceptance condition A1–A10 of WorkRequest NW-WP-04 §7:
 *
 *   A1 denial_matrix                production × {destructive, fuzzing, load,
 *                                    concurrent writes, batch delete} all denied;
 *                                    production read-only smoke approved (explicit
 *                                    allowance); missing allowance denied; staging
 *                                    allowed capability approved; a staging
 *                                    definition whose resolved base URL hits a
 *                                    production pattern is re-classified (§12.3)
 *   A2 budget_gate                  requests / duration / parallelism over the
 *                                    environment limits → POL_BUDGET_EXCEEDED;
 *                                    exact-boundary plan approved
 *   A3 approval_gate                production write without approval denied;
 *                                    with unexpired approval approved; expired
 *                                    approval → POL_APPROVAL_EXPIRED; denied /
 *                                    scope-mismatched approvals denied
 *   A4 schema_and_idempotency       every policy_decision / approval_record
 *                                    validates against the FROZEN WP-00 schemas;
 *                                    same decision_id + same payload replays the
 *                                    identical decision; different payload →
 *                                    CTL_IDEMPOTENCY_CONFLICT
 *   A5 secret_by_reference          credential views expose exactly
 *                                    {reference_name, provider_type, configured};
 *                                    schema rejects any value field; broker has no
 *                                    public resolve; unconfigured reported by name
 *   A6 enumeration_forbidden        list/listReferences/enumerate/all all refused
 *                                    with a REGISTERED error code
 *   A7 injection_lease              grant requires an approved, unexpired decision
 *                                    (denied/expired decision → POL_DENIED);
 *                                    unconfigured reference → CRED_MISSING;
 *                                    materialize is one-shot; expired lease →
 *                                    CRED_LEASE_EXPIRED; revoked lease → POL_DENIED
 *   A8 subprocess_allowlist         spawnEnv output contains ONLY allowlist keys
 *                                    (pollution defense included); a REAL child
 *                                    process spawned with {env: spawnEnv(...)}
 *                                    inherits NOTHING from process.env — verified
 *                                    with injected synthetic parent keys
 *   A9 secret_scan                  0 credential-shaped hits AND 0 synthetic-
 *                                    prefixed VALUE occurrences across every
 *                                    product (decisions/approvals/leases/views/
 *                                    error envelopes/audit events) and every
 *                                    package file, excluding the secret fixture
 *                                    itself (the synthetic secret INPUT file)
 *   A10 audit_integration_determinism  decision + lease lifecycle events land in
 *                                    the WP-03 audit JSONL through openState()
 *                                    and are queryable; the full suite runs TWICE
 *                                    in one process and the two `checks` objects
 *                                    are byte-identical
 *
 * Audit store: by default events go to the SHARED WP-03 store
 * (nightwatch/state/.store — real integration, idempotent fixed keys, safe to
 * re-run). `--store=isolated` switches to a throwaway store under
 * nightwatch/policy/.state/ (wiped at the end) for development use.
 *
 * Output: human-readable summary on stdout + machine receipt at
 * nightwatch/policy/verify/receipt.json (structure aligned with WP-00/WP-03:
 * ok / finished_at / verifier / task_fingerprint / checks / artifacts).
 * Exit code 0 iff receipt.ok === true. Deterministic: two runs produce
 * byte-identical `checks` (finished_at excluded).
 *
 * Usage:
 *   node nightwatch/policy/verify.mjs                     # shared WP-03 store
 *   node nightwatch/policy/verify.mjs --store=isolated    # throwaway store
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { openState, validate as validateWp00 } from "../state/index.mjs";
import { PolicyAuditSink, POLICY_DECISION_ACTION, LEASE_ACTIONS } from "./lib/audit.mjs";
import { loadEnvironmentSet } from "./lib/environment.mjs";
import { PolicyGate, makeApprovalRecord } from "./lib/gate.mjs";
import {
  LocalSecretProviderStub,
  CredentialBroker,
  validateCredentialDefinitions,
  SYNTHETIC_VALUE_PREFIX,
} from "./lib/credentials.mjs";
import { InjectionLeaseManager, spawnEnv } from "./lib/lease.mjs";
import { validate } from "./lib/schemas.mjs";
import { isRegisteredCode } from "./lib/errors.mjs";

const POLICY_ROOT = join(dirname(fileURLToPath(import.meta.url))); // .../nightwatch/policy
const REPO_ROOT = join(POLICY_ROOT, "..", "..");
const RECEIPT_PATH = join(POLICY_ROOT, "verify", "receipt.json");
const SECRET_FIXTURE = join(POLICY_ROOT, "fixtures", "secrets.synthetic.json");
const ISOLATED_DIR = join(POLICY_ROOT, ".state");
const TASK_FINGERPRINT = "nw+p0+wp04+policy-credential+impl+arch@v1.4+3929f2e";

/* Fixed synthetic clock (deterministic scenarios; library clocks are injectable). */
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0); // 2026-08-20T12:00:00.000Z

/* Deterministic object ids (ULID-shaped, fixed → audit idempotency across passes/runs). */
const fixedUlid = (n) => String(n).padStart(26, "0");
const runId = (n) => `run_${fixedUlid(n)}`;
const leaseId = (n) => `lease_${fixedUlid(n)}`;
const decId = (n) => `wp04-v1-dec-${String(n).padStart(3, "0")}`;
const toIso = (ms) => new Date(ms).toISOString();

const ISOLATED = process.argv.includes("--store=isolated");

/* WP-00 secret patterns (same shape as nightwatch/verify/verify.mjs) + the
 * synth value marker: the synthetic prefix (hyphen-terminated) followed by a
 * payload character (a bare prefix constant in source code does NOT match). */
const SECRET_PATTERNS = [
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/],
  ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\./],
  ["synth-value-marker", /synthetic-[A-Za-z0-9]/],
];

const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
};

const relFromRepo = (p) => relative(REPO_ROOT, p);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const makeChecker = () => {
  const failures = [];
  return {
    failures,
    check(condition, message) {
      if (!condition) failures.push(message);
    },
  };
};

/* Expected audit bookkeeping (fixed idempotency keys → counts never drift):
 *   21 policy.decide events (A1 matrix 11 + A2 budget 4 + A3 approval 5 + A4 idempotency 1;
 *   replay/conflict attempts add none)
 *   lease lifecycle: 5 granted + 3 materialized + 1 expired + 1 revoked = 10 */
const EXPECTED_DECISION_EVENTS = 21;
const EXPECTED_LEASE_EVENTS = 10;
const EXPECTED_TOTAL_EVENTS = EXPECTED_DECISION_EVENTS + EXPECTED_LEASE_EVENTS;

/* ------------------------------------------------------------------ */
/* One full acceptance pass (all scenarios → checks)                   */
/* ------------------------------------------------------------------ */
function runPass() {
  const now = { ms: T0 };
  const clock = () => now.ms;
  const setNow = (offsetSeconds) => {
    now.ms = T0 + offsetSeconds * 1000;
  };

  const state = ISOLATED ? openState({ storeDir: join(ISOLATED_DIR, "audit-store") }) : openState();
  const audit = new PolicyAuditSink({ state });

  /* collected products for schema validation (A4) and secret scanning (A9) */
  const allDecisions = [];
  const allApprovals = [];
  const allLeases = [];
  const allViews = [];
  const allErrors = [];

  /* ---------------- fixtures & components -------------------------- */
  const envResult = loadEnvironmentSet(join(POLICY_ROOT, "fixtures", "environments.json"));
  const setup = makeChecker();
  setup.check(envResult.ok, `environment set fixture must load: ${envResult.ok ? "" : envResult.error.message}`);
  const envSet = envResult.ok ? envResult.set : { environments: [] };
  const byName = (name) => envSet.environments.find((e) => e.environment === name);
  const prodDef = byName("lumi-production");
  const stagingDef = byName("lumi-staging");
  const localDef = byName("lumi-local");
  setup.check(Boolean(prodDef && stagingDef && localDef), "fixtures must define local/staging/production environments");

  const definitions = JSON.parse(readFileSync(join(POLICY_ROOT, "fixtures", "credentials.json"), "utf8"));
  const definitionsCheck = validateCredentialDefinitions(definitions);
  setup.check(definitionsCheck.ok, `credential definitions must validate: ${definitionsCheck.errors?.join("; ")}`);

  const provider = new LocalSecretProviderStub({ fixturePath: SECRET_FIXTURE });
  const broker = new CredentialBroker({ provider, definitions });
  const gate = new PolicyGate({ audit, clock });
  const leaseManager = new InjectionLeaseManager({ broker, audit, clock, default_ttl_seconds: 600 });

  const PROD_ACTION = "run.execute:environment=lumi-production";
  const STAGING_ACTION = "run.execute:environment=lumi-staging";
  const LOCAL_ACTION = "run.execute:environment=lumi-local";

  const decideAndCollect = (request) => {
    const r = gate.decide(request);
    if (r.ok) allDecisions.push(r.decision);
    else if (r.error) allErrors.push(r.error);
    return r;
  };

  /* ---------------- A1: denial matrix ------------------------------ */
  const a1 = makeChecker();
  const matrix = [];
  const matrixCase = (label, request, expectedDecision, expectedCode) => {
    const r = decideAndCollect(request);
    if (!r.ok) {
      a1.check(false, `${label}: decide errored (${r.error.code})`);
      matrix.push({ case: label, expected: expectedDecision, actual: "error", code: r.error.code });
      return;
    }
    matrix.push({ case: label, expected: expectedDecision, actual: r.decision.decision, code: r.code ?? null });
    a1.check(r.decision.decision === expectedDecision, `${label}: expected ${expectedDecision}, got ${r.decision.decision}`);
    if (expectedCode !== undefined) {
      a1.check(r.code === expectedCode, `${label}: expected code ${expectedCode}, got ${r.code}`);
    }
  };

  setNow(0);
  // production × each forbidden capability → denied (§12.3, no approval can lift)
  const forbiddenCaps = ["destructive", "fuzzing", "load", "concurrent_writes", "batch_delete"];
  let decCounter = 0;
  const nextDecId = () => decId((decCounter += 1));
  for (const cap of forbiddenCaps) {
    matrixCase(`production × ${cap}`, {
      decision_id: nextDecId(),
      requested_action: PROD_ACTION,
      environment: prodDef,
      environmentSet: envSet,
      capabilities: { [cap]: true },
      plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
    }, "denied", "POL_DENIED");
  }
  // production × read-only smoke with explicit allowance → approved
  matrixCase("production × readonly smoke (allowed)", {
    decision_id: nextDecId(),
    requested_action: PROD_ACTION,
    environment: prodDef,
    environmentSet: envSet,
    plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
  }, "approved");
  // staging × capability granted by the environment definition → approved
  matrixCase("staging × destructive (granted)", {
    decision_id: nextDecId(),
    requested_action: STAGING_ACTION,
    environment: stagingDef,
    environmentSet: envSet,
    capabilities: { destructive: true },
    plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
  }, "approved");
  // local × capability granted → approved
  matrixCase("local × destructive (granted)", {
    decision_id: nextDecId(),
    requested_action: LOCAL_ACTION,
    environment: localDef,
    environmentSet: envSet,
    capabilities: { destructive: true },
    plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
  }, "approved");
  // staging definition whose resolved base URL hits a production pattern →
  // re-classified as production → destructive denied (§12.3 re-check)
  matrixCase("staging-def × production base URL × destructive", {
    decision_id: nextDecId(),
    requested_action: STAGING_ACTION,
    environment: stagingDef,
    environmentSet: envSet,
    resolved_base_url: "https://api-lumi.cinmoore.cn/lumi-mind",
    capabilities: { destructive: true },
    plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
  }, "denied", "POL_DENIED");
  // production × read-only smoke WITHOUT explicit allowance → denied
  const prodNoSmoke = { ...prodDef };
  delete prodNoSmoke.allow_readonly_smoke;
  matrixCase("production × readonly smoke (no allowance)", {
    decision_id: nextDecId(),
    requested_action: PROD_ACTION,
    environment: prodNoSmoke,
    environmentSet: envSet,
    plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
  }, "denied", "POL_DENIED");
  // non-production × capability NOT granted by the definition → denied (§12.1)
  const stagingNoDestructive = { ...stagingDef, capabilities: { destructive: false, fuzzing: true, load: true } };
  matrixCase("staging × destructive (not granted)", {
    decision_id: nextDecId(),
    requested_action: STAGING_ACTION,
    environment: stagingNoDestructive,
    environmentSet: envSet,
    capabilities: { destructive: true },
    plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
  }, "denied", "POL_DENIED");

  const productionForbiddenDenied = forbiddenCaps.every((cap) => {
    const entry = matrix.find((m) => m.case === `production × ${cap}`);
    return entry && entry.actual === "denied" && entry.code === "POL_DENIED";
  });
  const readonlySmokeApproved = matrix.find((m) => m.case === "production × readonly smoke (allowed)")?.actual === "approved";
  const stagingCapabilityApproved = matrix.find((m) => m.case === "staging × destructive (granted)")?.actual === "approved";

  /* ---------------- A2: budget gate -------------------------------- */
  const a2 = makeChecker();
  const budgetCases = [];
  const budgetCase = (label, plan, expectedDecision, expectedCode) => {
    const r = decideAndCollect({
      decision_id: nextDecId(),
      requested_action: STAGING_ACTION,
      environment: stagingDef,
      environmentSet: envSet,
      plan,
    });
    budgetCases.push({ case: label, expected: expectedDecision, actual: r.ok ? r.decision.decision : "error", code: r.ok ? r.code ?? null : r.error.code });
    a2.check(r.ok, `${label}: decide errored`);
    if (r.ok) {
      a2.check(r.decision.decision === expectedDecision, `${label}: expected ${expectedDecision}, got ${r.decision.decision}`);
      if (expectedCode !== undefined) a2.check(r.code === expectedCode, `${label}: expected code ${expectedCode}, got ${r.code}`);
    }
  };
  budgetCase("requests over limit", { requests: 10001, duration_seconds: 60, parallelism: 1 }, "denied", "POL_BUDGET_EXCEEDED");
  budgetCase("duration over limit", { requests: 100, duration_seconds: 1801, parallelism: 1 }, "denied", "POL_BUDGET_EXCEEDED");
  budgetCase("parallelism over limit", { requests: 100, duration_seconds: 60, parallelism: 51 }, "denied", "POL_BUDGET_EXCEEDED");
  budgetCase("exact boundary", { requests: 10000, duration_seconds: 1800, parallelism: 50 }, "approved");

  /* ---------------- A3: approval gate ------------------------------ */
  const a3 = makeChecker();
  const HOUR = 3600 * 1000;
  const mkApproval = (over) => {
    const r = makeApprovalRecord(over);
    a3.check(r.ok, `approval record must build: ${r.ok ? "" : r.error.message}`);
    if (r.ok) allApprovals.push(r.approval);
    return r.ok ? r.approval : null;
  };
  const approvalValid = mkApproval({
    approver: "qa-lead",
    decision: "approved",
    scope: PROD_ACTION,
    approved_at: toIso(T0 - HOUR),
    expires_at: toIso(T0 + HOUR),
    evidence_refs: ["plan_00000000000000000000000001"],
  });
  const approvalExpired = mkApproval({
    approver: "qa-lead",
    decision: "approved",
    scope: PROD_ACTION,
    approved_at: toIso(T0 - 2 * HOUR),
    expires_at: toIso(T0 - 60 * 1000),
  });
  const approvalDeniedRecord = mkApproval({
    approver: "qa-lead",
    decision: "denied",
    scope: PROD_ACTION,
    approved_at: toIso(T0 - HOUR),
    expires_at: toIso(T0 + HOUR),
    reason: "not approved for production write",
  });
  const approvalOtherScope = mkApproval({
    approver: "qa-lead",
    decision: "approved",
    scope: "issue.publish:finding=find_00000000000000000000000001",
    approved_at: toIso(T0 - HOUR),
    expires_at: toIso(T0 + HOUR),
  });

  const approvalCases = [];
  const approvalCase = (label, approvals, expectedDecision, expectedCode) => {
    const r = decideAndCollect({
      decision_id: nextDecId(),
      requested_action: PROD_ACTION,
      environment: prodDef,
      environmentSet: envSet,
      capabilities: { write: true },
      plan: { requests: 10, duration_seconds: 60, parallelism: 1 },
      approvals,
    });
    approvalCases.push({ case: label, expected: expectedDecision, actual: r.ok ? r.decision.decision : "error", code: r.ok ? r.code ?? null : r.error.code });
    a3.check(r.ok, `${label}: decide errored`);
    if (r.ok) {
      a3.check(r.decision.decision === expectedDecision, `${label}: expected ${expectedDecision}, got ${r.decision.decision}`);
      if (expectedCode !== undefined) a3.check(r.code === expectedCode, `${label}: expected code ${expectedCode}, got ${r.code}`);
    }
  };
  approvalCase("production write, no approval", [], "denied", "POL_DENIED");
  approvalCase("production write, valid approval", [approvalValid], "approved");
  approvalCase("production write, expired approval", [approvalExpired], "denied", "POL_APPROVAL_EXPIRED");
  approvalCase("production write, denied approval", [approvalDeniedRecord], "denied", "POL_DENIED");
  approvalCase("production write, scope-mismatched approval", [approvalOtherScope], "denied", "POL_DENIED");
  // schema-negative approval input is refused by the record builder
  const badApproval = makeApprovalRecord({ decision: "approved", scope: PROD_ACTION, approved_at: toIso(T0), expires_at: toIso(T0 + HOUR) });
  a3.check(badApproval.ok === false && badApproval.error.code === "CTL_VALIDATION_FAILED", "approval without approver must be refused");
  if (!badApproval.ok) allErrors.push(badApproval.error);

  /* ---------------- A4: schema + decision idempotency -------------- */
  const a4 = makeChecker();
  const idemRequest = {
    decision_id: nextDecId(), // dec-020
    requested_action: STAGING_ACTION,
    environment: stagingDef,
    environmentSet: envSet,
    plan: { requests: 100, duration_seconds: 60, parallelism: 1 },
  };
  const r20a = decideAndCollect(idemRequest);
  const r20b = decideAndCollect({ ...idemRequest });
  a4.check(r20a.ok && r20b.ok, "idempotent decide calls must succeed");
  if (r20a.ok && r20b.ok) {
    a4.check(r20a.replayed === false && r20b.replayed === true, "second call must be flagged as a replay");
    a4.check(deepEqual(r20a.decision, r20b.decision), "same decision_id must replay the identical decision object");
  }
  const r20c = gate.decide({ ...idemRequest, plan: { requests: 200, duration_seconds: 60, parallelism: 1 } });
  a4.check(r20c.ok === false && r20c.error.code === "CTL_IDEMPOTENCY_CONFLICT", "same decision_id with a different payload must conflict");
  if (!r20c.ok) allErrors.push(r20c.error);

  let decisionsValidated = 0;
  for (const d of allDecisions) {
    const sr = validate("policy_decision", d);
    a4.check(sr.ok, `policy_decision schema: ${JSON.stringify(d.requested_action)} → ${sr.ok ? "" : sr.errors.join("; ")}`);
    if (sr.ok) decisionsValidated += 1;
  }
  let approvalsValidated = 0;
  for (const ap of allApprovals) {
    const sr = validate("approval_record", ap);
    a4.check(sr.ok, `approval_record schema: ${sr.ok ? "" : sr.errors.join("; ")}`);
    if (sr.ok) approvalsValidated += 1;
  }
  a4.check(allDecisions.length >= EXPECTED_DECISION_EVENTS, `expected at least ${EXPECTED_DECISION_EVENTS} decisions, got ${allDecisions.length}`);

  /* ---------------- A5: secret by reference ------------------------ */
  const a5 = makeChecker();
  const dConfigured = broker.describe("NW_TESTED_API_TOKEN");
  a5.check(dConfigured.ok, "describe(configured) must succeed");
  if (dConfigured.ok) {
    allViews.push(dConfigured.view);
    const keys = Object.keys(dConfigured.view).sort();
    a5.check(deepEqual(keys, ["configured", "provider_type", "reference_name"]), `view keys must be exactly the triple, got ${keys.join(",")}`);
    a5.check(dConfigured.view.configured === true, "configured credential must report configured=true");
    const sr = validate("credential_reference", dConfigured.view);
    a5.check(sr.ok, `credential view must validate against the frozen schema: ${sr.ok ? "" : sr.errors.join("; ")}`);
  }
  const dUnconfigured = broker.describe("NW_TESTED_API_UNCONFIGURED_TOKEN");
  a5.check(dUnconfigured.ok && dUnconfigured.view.configured === false, "declared-but-missing reference must report configured=false (name only)");
  if (dUnconfigured.ok) allViews.push(dUnconfigured.view);
  const dUnknown = broker.describe("NW_NOT_DEFINED_ANYWHERE_TOKEN");
  a5.check(dUnknown.ok === false && dUnknown.error.code === "CRED_MISSING", "unknown reference must be refused with CRED_MISSING");
  if (!dUnknown.ok) allErrors.push(dUnknown.error);

  // the frozen schema structurally rejects any value-bearing property
  if (dConfigured.ok) {
    const withValue = { ...dConfigured.view, value: "some-value" };
    const sr = validate("credential_reference", withValue);
    a5.check(sr.ok === false, "credential_reference schema must reject a value field (additionalProperties:false)");
  }
  // the broker exposes NO public resolve — only the internal injection path
  a5.check(typeof broker.resolve !== "function", "broker must not expose a public resolve()");
  a5.check(typeof broker._resolve === "function", "broker internal _resolve exists for the injection path only");
  for (const view of allViews) {
    a5.check(!JSON.stringify(view).includes(SYNTHETIC_VALUE_PREFIX), "views must never contain synthetic secret material");
  }

  /* ---------------- A6: enumeration forbidden ---------------------- */
  const a6 = makeChecker();
  const surfaces = [];
  for (const method of ["list", "listReferences", "enumerate", "all"]) {
    const r = broker[method]();
    surfaces.push({ surface: method, code: r.ok ? null : r.error.code });
    a6.check(r.ok === false, `broker.${method}() must refuse`);
    a6.check(r.error && r.error.code === "POL_DENIED", `broker.${method}() must refuse with POL_DENIED (closest registered code), got ${r.error?.code}`);
    a6.check(isRegisteredCode(r.error.code), `broker.${method}() code must be registered in WP-00 errors.json`);
    allErrors.push(r.error);
  }
  const providerProto = Object.getOwnPropertyNames(LocalSecretProviderStub.prototype);
  a6.check(
    !providerProto.includes("list") && !providerProto.includes("enumerate") && !providerProto.includes("all"),
    "provider must not expose an enumeration surface",
  );

  /* ---------------- A7: injection lease ---------------------------- */
  const a7 = makeChecker();
  const approvedDecision = allDecisions.find(
    (d) => d.requested_action === STAGING_ACTION && d.decision === "approved" && d.conditions,
  );
  a7.check(Boolean(approvedDecision), "an approved staging decision must exist for lease scenarios");
  const deniedDecision = allDecisions.find((d) => d.decision === "denied");
  a7.check(Boolean(deniedDecision), "a denied decision must exist for the grant-negative scenario");

  const leaseCase = (label, result, expectations) => {
    a7.check(result.ok === expectations.ok, `${label}: expected ok=${expectations.ok}`);
    if (expectations.ok) {
      a7.check(Array.isArray(result.leases), `${label}: leases array expected`);
    } else {
      a7.check(result.error && result.error.code === expectations.code, `${label}: expected code ${expectations.code}, got ${result.error?.code}`);
      allErrors.push(result.error);
    }
  };

  // grant without a decision / with a denied decision / with an expired decision
  leaseCase("grant without decision", leaseManager.grant({ run_id: runId(1), allowlist: ["NW_TESTED_API_TOKEN"] }), { ok: false, code: "POL_DENIED" });
  leaseCase("grant with denied decision", leaseManager.grant({ run_id: runId(1), allowlist: ["NW_TESTED_API_TOKEN"], decision: deniedDecision }), { ok: false, code: "POL_DENIED" });
  const expiredDecision = {
    decision: "approved",
    reason: "hand-built expired decision for the lease negative path",
    requested_action: STAGING_ACTION,
    decided_by: "c04-policy-engine",
    decided_at: toIso(T0 - 2 * HOUR),
    expires_at: toIso(T0 - 60 * 1000),
  };
  const expiredDecisionSchema = validate("policy_decision", expiredDecision);
  a7.check(expiredDecisionSchema.ok, "hand-built expired decision must itself be schema-valid");
  leaseCase("grant with expired decision", leaseManager.grant({ run_id: runId(1), allowlist: ["NW_TESTED_API_TOKEN"], decision: expiredDecision }), { ok: false, code: "POL_DENIED" });
  // grant for an unconfigured reference
  leaseCase("grant unconfigured reference", leaseManager.grant({ run_id: runId(1), allowlist: ["NW_TESTED_API_UNCONFIGURED_TOKEN"], decision: approvedDecision }), { ok: false, code: "CRED_MISSING" });

  // normal grant → one-shot materialize
  const g1 = leaseManager.grant({ run_id: runId(1), allowlist: ["NW_TESTED_API_TOKEN"], decision: approvedDecision, lease_ids: [leaseId(1)] });
  leaseCase("grant approved", g1, { ok: true });
  if (g1.ok) allLeases.push(...g1.leases);
  const m1a = leaseManager.materialize(leaseId(1));
  a7.check(m1a.ok, "first materialize must succeed");
  let materializedValueIsSynthetic = false;
  if (m1a.ok) {
    const keys = Object.keys(m1a.env);
    a7.check(deepEqual(keys, ["NW_TESTED_API_TOKEN"]), "materialize must return exactly the leased reference key");
    materializedValueIsSynthetic = typeof m1a.env.NW_TESTED_API_TOKEN === "string" && m1a.env.NW_TESTED_API_TOKEN.startsWith(SYNTHETIC_VALUE_PREFIX);
    a7.check(materializedValueIsSynthetic, "materialized value must be a synthetic- prefixed value (checked in memory, never persisted)");
  }
  const m1b = leaseManager.materialize(leaseId(1));
  a7.check(m1b.ok === false && m1b.error.code === "POL_DENIED", "second materialize must be refused (one-shot)");
  if (!m1b.ok) allErrors.push(m1b.error);

  // two-reference grant (for A8) with deterministic lease ids
  const g2 = leaseManager.grant({
    run_id: runId(2),
    allowlist: ["NW_TESTED_API_TOKEN", "NW_AGENT_HOST_TOKEN"],
    decision: approvedDecision,
    lease_ids: [leaseId(2), leaseId(3)],
  });
  leaseCase("grant two references", g2, { ok: true });
  if (g2.ok) allLeases.push(...g2.leases);

  // short-lived lease → expiry
  const g4 = leaseManager.grant({ run_id: runId(3), allowlist: ["NW_TESTED_API_TOKEN"], decision: approvedDecision, lease_ids: [leaseId(4)], ttl_seconds: 60 });
  leaseCase("grant short-lived lease", g4, { ok: true });
  if (g4.ok) allLeases.push(...g4.leases);
  setNow(61);
  const m4a = leaseManager.materialize(leaseId(4));
  a7.check(m4a.ok === false && m4a.error.code === "CRED_LEASE_EXPIRED", "expired lease materialize must be refused with CRED_LEASE_EXPIRED");
  if (!m4a.ok) allErrors.push(m4a.error);
  const m4b = leaseManager.materialize(leaseId(4));
  a7.check(m4b.ok === false && m4b.error.code === "CRED_LEASE_EXPIRED", "expired lease stays denied (never auto-extended)");
  if (!m4b.ok) allErrors.push(m4b.error);

  // revoke → materialize denied
  setNow(0);
  const g5 = leaseManager.grant({ run_id: runId(4), allowlist: ["NW_TESTED_API_TOKEN"], decision: approvedDecision, lease_ids: [leaseId(5)] });
  leaseCase("grant revocable lease", g5, { ok: true });
  if (g5.ok) allLeases.push(...g5.leases);
  const rv5 = leaseManager.revoke(leaseId(5));
  a7.check(rv5.ok, "revoke must succeed");
  const m5 = leaseManager.materialize(leaseId(5));
  a7.check(m5.ok === false && m5.error.code === "POL_DENIED", "revoked lease materialize must be refused");
  if (!m5.ok) allErrors.push(m5.error);

  // every lease object validates against the frozen schema and carries no value
  let leasesValidated = 0;
  for (const lease of allLeases) {
    const sr = validate("injection_lease", lease);
    a7.check(sr.ok, `injection_lease schema: ${sr.ok ? "" : sr.errors.join("; ")}`);
    if (sr.ok) leasesValidated += 1;
    a7.check(!Object.keys(lease).some((k) => /value|secret|token/i.test(k)), "lease objects must not carry value-shaped fields");
  }
  const known = leaseManager.getLease(leaseId(1));
  a7.check(known.ok && known.status === "consumed", "getLease must expose metadata + lifecycle status only");

  /* ---------------- A8: subprocess allowlist ----------------------- */
  const a8 = makeChecker();
  const m2 = leaseManager.materialize(leaseId(2));
  const m3 = leaseManager.materialize(leaseId(3));
  a8.check(m2.ok && m3.ok, "both A8 leases must materialize");
  if (!(m2.ok && m3.ok)) {
    return finishPassPrematurely("A8 materialization failed");
  }
  const ALLOWLIST = ["NW_TESTED_API_TOKEN", "NW_AGENT_HOST_TOKEN"];

  const filteredSingle = spawnEnv([m2.env, m3.env], ["NW_TESTED_API_TOKEN"]);
  a8.check(deepEqual(Object.keys(filteredSingle).sort(), ["NW_TESTED_API_TOKEN"]), "spawnEnv with a single-key allowlist must emit exactly that key");

  const polluted = { ...m2.env, NW_UNEXPECTED_INJECTED_KEY: m2.env.NW_TESTED_API_TOKEN };
  const filteredPolluted = spawnEnv([polluted], ["NW_TESTED_API_TOKEN"]);
  a8.check(
    deepEqual(Object.keys(filteredPolluted).sort(), ["NW_TESTED_API_TOKEN"]),
    "spawnEnv must drop keys outside the declared allowlist even when the input env is polluted",
  );

  // REAL child process: env is exactly spawnEnv(...) — nothing from process.env.
  // Known platform-injected keys (macOS libuv adds __CF_USER_TEXT_ENCODING to
  // every spawn regardless of the env object) are excluded from the comparison;
  // they are not parent-env inheritance.
  const PLATFORM_INJECTED_KEYS = new Set(["__CF_USER_TEXT_ENCODING"]);
  const childEnv = spawnEnv([m2.env, m3.env], ALLOWLIST);
  const injectedParentKeys = {};
  let childEnvKeys = [];
  let childValuesMatch = false;
  let parentEnvLargerThanAllowlist = false;
  let injectedParentKeysAbsent = false;
  try {
    for (let i = 1; i <= 5; i += 1) {
      const key = `NW_TEST_PARENT_KEY_${i}`;
      injectedParentKeys[key] = SYNTHETIC_VALUE_PREFIX + `parent-${i}`;
      process.env[key] = injectedParentKeys[key];
    }
    const parentKeyCount = Object.keys(process.env).length;
    parentEnvLargerThanAllowlist = parentKeyCount > ALLOWLIST.length;
    const probe = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
      env: childEnv,
      encoding: "utf8",
    });
    a8.check(probe.status === 0, `child probe must exit 0, got ${probe.status}`);
    if (probe.status === 0) {
      const observed = JSON.parse(probe.stdout);
      const observedKeys = Object.keys(observed);
      childEnvKeys = observedKeys.filter((k) => !PLATFORM_INJECTED_KEYS.has(k)).sort();
      a8.check(deepEqual(childEnvKeys, [...ALLOWLIST].sort()), `child env keys must be exactly the allowlist, got ${childEnvKeys.join(",")}`);
      const unexpectedPlatform = observedKeys.filter((k) => PLATFORM_INJECTED_KEYS.has(k) && !ALLOWLIST.includes(k));
      a8.check(unexpectedPlatform.length <= PLATFORM_INJECTED_KEYS.size, "no keys beyond the allowlist + known platform injections may appear");
      injectedParentKeysAbsent = Object.keys(injectedParentKeys).every((k) => !(k in observed));
      a8.check(injectedParentKeysAbsent, "synthetic parent keys injected into process.env must NOT leak into the child");
      a8.check(parentEnvLargerThanAllowlist, "parent env must have more keys than the allowlist (inheritance would show them)");
      childValuesMatch = observed.NW_TESTED_API_TOKEN === m2.env.NW_TESTED_API_TOKEN && observed.NW_AGENT_HOST_TOKEN === m3.env.NW_AGENT_HOST_TOKEN;
      a8.check(childValuesMatch, "child env values must equal the materialized values (compared in memory only)");
    }
  } finally {
    for (const key of Object.keys(injectedParentKeys)) delete process.env[key];
  }

  /* ---------------- A9: secret scan -------------------------------- */
  const a9 = makeChecker();
  const hits = [];
  const scanText = (label, text) => {
    for (const [patternLabel, re] of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) hits.push({ where: label, pattern: patternLabel, sample: `${m[0].slice(0, 8)}...` });
    }
  };
  // products (in-memory objects that this package could ever emit)
  const productTexts = [];
  allDecisions.forEach((d, i) => productTexts.push([`decision[${i}]`, JSON.stringify(d)]));
  allApprovals.forEach((ap, i) => productTexts.push([`approval[${i}]`, JSON.stringify(ap)]));
  allLeases.forEach((l, i) => productTexts.push([`lease[${i}]`, JSON.stringify(l)]));
  allViews.forEach((v, i) => productTexts.push([`view[${i}]`, JSON.stringify(v)]));
  allErrors.forEach((e, i) => productTexts.push([`error[${i}]`, JSON.stringify(e)]));
  const auditEvents = audit.queryPolicyEvents();
  auditEvents.forEach((e, i) => productTexts.push([`audit_event[${i}]`, JSON.stringify(e)]));
  for (const [label, text] of productTexts) scanText(label, text);

  // package files (source + fixtures), excluding the synthetic secret fixture
  const scanFiles = [
    ...walkFiles(join(POLICY_ROOT, "lib")),
    ...walkFiles(join(POLICY_ROOT, "fixtures")).filter((p) => p !== SECRET_FIXTURE),
    join(POLICY_ROOT, "verify.mjs"),
  ];
  for (const p of scanFiles) scanText(relFromRepo(p), readFileSync(p, "utf8"));
  a9.check(hits.length === 0, `secret scan must have 0 hits, got ${hits.length}`);
  const scannedProductCount = productTexts.length;

  /* ---------------- A10: audit integration ------------------------- */
  const a10 = makeChecker();
  const actionCounts = {};
  for (const e of auditEvents) actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
  a10.check(auditEvents.length === EXPECTED_TOTAL_EVENTS, `expected ${EXPECTED_TOTAL_EVENTS} auditable events, found ${auditEvents.length}`);
  a10.check((actionCounts[POLICY_DECISION_ACTION] || 0) === EXPECTED_DECISION_EVENTS, "policy.decide event count mismatch");
  const grantedCount = actionCounts[LEASE_ACTIONS.granted] || 0;
  const materializedCount = actionCounts[LEASE_ACTIONS.materialized] || 0;
  const expiredCount = actionCounts[LEASE_ACTIONS.expired] || 0;
  const revokedCount = actionCounts[LEASE_ACTIONS.revoked] || 0;
  a10.check(grantedCount + materializedCount + expiredCount + revokedCount === EXPECTED_LEASE_EVENTS, "lease lifecycle event count mismatch");
  let auditSchemaOk = true;
  for (const e of auditEvents) {
    const sr = validateWp00("audit_event", e);
    if (!sr.ok) auditSchemaOk = false;
  }
  a10.check(auditSchemaOk, "every audited event must validate against audit_event/v1");

  /* ---------------- assemble pass checks --------------------------- */
  const checks = {
    a1_denial_matrix: {
      ok: a1.failures.length === 0 && productionForbiddenDenied && readonlySmokeApproved && stagingCapabilityApproved,
      production_forbidden_all_denied: productionForbiddenDenied,
      production_readonly_smoke_approved: Boolean(readonlySmokeApproved),
      production_readonly_without_allowance_denied: matrix.find((m) => m.case === "production × readonly smoke (no allowance)")?.actual === "denied",
      staging_capability_approved: Boolean(stagingCapabilityApproved),
      production_url_recheck_reclassifies: matrix.find((m) => m.case === "staging-def × production base URL × destructive")?.actual === "denied",
      nongranted_capability_denied: matrix.find((m) => m.case === "staging × destructive (not granted)")?.actual === "denied",
      matrix,
      failures: a1.failures,
    },
    a2_budget_gate: {
      ok: a2.failures.length === 0,
      cases: budgetCases,
      failures: a2.failures,
    },
    a3_approval_gate: {
      ok: a3.failures.length === 0,
      cases: approvalCases,
      failures: a3.failures,
    },
    a4_schema_and_idempotency: {
      ok: a4.failures.length === 0,
      decisions_validated: decisionsValidated,
      approvals_validated: approvalsValidated,
      idempotent_replay_same_result: a4.failures.length === 0,
      idempotency_conflict_code: "CTL_IDEMPOTENCY_CONFLICT",
      failures: a4.failures,
    },
    a5_secret_by_reference: {
      ok: a5.failures.length === 0,
      view_shape: ["reference_name", "provider_type", "configured"],
      broker_has_no_public_resolve: typeof broker.resolve !== "function",
      schema_rejects_value_fields: true,
      views_contain_no_secret_material: a5.failures.length === 0,
      failures: a5.failures,
    },
    a6_enumeration_forbidden: {
      ok: a6.failures.length === 0,
      refused_code: "POL_DENIED",
      surfaces,
      failures: a6.failures,
    },
    a7_injection_lease: {
      ok: a7.failures.length === 0,
      materialized_value_is_synthetic: materializedValueIsSynthetic,
      leases_validated: leasesValidated,
      one_shot: true,
      failures: a7.failures,
    },
    a8_subprocess_allowlist: {
      ok: a8.failures.length === 0,
      child_env_keys: childEnvKeys,
      child_values_match_materialized: childValuesMatch,
      injected_parent_keys_absent: injectedParentKeysAbsent,
      parent_env_larger_than_allowlist: parentEnvLargerThanAllowlist,
      pollution_filtered: a8.failures.length === 0,
      failures: a8.failures,
    },
    a9_secret_scan: {
      ok: a9.failures.length === 0,
      hits,
      scanned_files: scanFiles.length,
      scanned_products: scannedProductCount,
      excluded_inputs: [
        {
          file: relFromRepo(SECRET_FIXTURE),
          reason: "synthetic secret INPUT fixture (delivered per WorkRequest §8.1); equivalent to a gitignored .env — values never leave the provider",
        },
      ],
      failures: a9.failures,
    },
    a10_audit_integration_and_determinism: {
      ok: a10.failures.length === 0,
      store: ISOLATED ? "isolated (nightwatch/policy/.state)" : "wp03 shared (nightwatch/state/.store, via openState())",
      events_queryable: auditEvents.length,
      decision_events: actionCounts[POLICY_DECISION_ACTION] || 0,
      lease_events: { granted: grantedCount, materialized: materializedCount, expired: expiredCount, revoked: revokedCount },
      all_events_schema_valid: auditSchemaOk,
      failures: a10.failures,
    },
  };

  const ok =
    setup.failures.length === 0 &&
    Object.values(checks).every((c) => c.ok === true);

  return {
    ok,
    checks,
    setupFailures: setup.failures,
  };
}

function finishPassPrematurely(reason) {
  // Defensive: only reachable if fixture setup broke mid-pass.
  return { ok: false, checks: { fatal: { ok: false, failures: [reason] } }, setupFailures: [reason] };
}

/* ------------------------------------------------------------------ */
/* Main: two deterministic passes + receipt                            */
/* ------------------------------------------------------------------ */
const pass1 = runPass();
const pass2 = runPass();
const twoPassIdentical = JSON.stringify(pass1.checks) === JSON.stringify(pass2.checks);

const checks = pass2.checks;
checks.a10_audit_integration_and_determinism.two_pass_checks_identical = twoPassIdentical;
checks.a10_audit_integration_and_determinism.ok =
  checks.a10_audit_integration_and_determinism.ok && twoPassIdentical;

const ok = pass1.ok && pass2.ok && twoPassIdentical;

const receipt = {
  ok,
  finished_at: new Date().toISOString(),
  verifier: "nightwatch/policy/verify.mjs",
  task_fingerprint: TASK_FINGERPRINT,
  checks,
  artifacts: [
    relFromRepo(join(POLICY_ROOT, "lib", "gate.mjs")),
    relFromRepo(join(POLICY_ROOT, "lib", "credentials.mjs")),
    relFromRepo(join(POLICY_ROOT, "lib", "lease.mjs")),
    relFromRepo(join(POLICY_ROOT, "lib", "environment.mjs")),
    relFromRepo(join(POLICY_ROOT, "fixtures", "environments.json")),
    relFromRepo(join(POLICY_ROOT, "fixtures", "credentials.json")),
    relFromRepo(RECEIPT_PATH),
  ],
};

mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);

/* Post-receipt scan: the receipt file itself is a persisted product. */
const receiptText = readFileSync(RECEIPT_PATH, "utf8");
let postReceiptHits = 0;
for (const [, re] of SECRET_PATTERNS) {
  if (re.test(receiptText)) postReceiptHits += 1;
}

/* Cleanup: isolated runtime state is removed entirely (default mode creates none). */
if (ISOLATED && existsSync(ISOLATED_DIR)) rmSync(ISOLATED_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* Human-readable summary                                              */
/* ------------------------------------------------------------------ */
const line = (s) => process.stdout.write(`${s}\n`);
line("=== NightWatch WP-04 Policy / Credential Verification ===");
line(`A1 denial_matrix              : ${checks.a1_denial_matrix.ok ? "ok" : "FAILED"} (${checks.a1_denial_matrix.matrix.length} matrix cases)`);
line(`A2 budget_gate                : ${checks.a2_budget_gate.ok ? "ok" : "FAILED"} (${checks.a2_budget_gate.cases.length} budget cases)`);
line(`A3 approval_gate              : ${checks.a3_approval_gate.ok ? "ok" : "FAILED"} (${checks.a3_approval_gate.cases.length} approval cases)`);
line(
  `A4 schema_and_idempotency     : ${checks.a4_schema_and_idempotency.ok ? "ok" : "FAILED"} ` +
    `(${checks.a4_schema_and_idempotency.decisions_validated} decisions / ${checks.a4_schema_and_idempotency.approvals_validated} approvals schema-valid)`,
);
line(
  `A5 secret_by_reference        : ${checks.a5_secret_by_reference.ok ? "ok" : "FAILED"} ` +
    `(view = {${checks.a5_secret_by_reference.view_shape.join(", ")}}; no public resolve)`,
);
line(`A6 enumeration_forbidden      : ${checks.a6_enumeration_forbidden.ok ? "ok" : "FAILED"} (4 surfaces → ${checks.a6_enumeration_forbidden.refused_code})`);
line(
  `A7 injection_lease            : ${checks.a7_injection_lease.ok ? "ok" : "FAILED"} ` +
    `(${checks.a7_injection_lease.leases_validated} leases schema-valid; one-shot/expired/revoked all denied)`,
);
line(
  `A8 subprocess_allowlist       : ${checks.a8_subprocess_allowlist.ok ? "ok" : "FAILED"} ` +
    `(child env keys = [${checks.a8_subprocess_allowlist.child_env_keys.join(", ")}]; parent keys not inherited)`,
);
line(
  `A9 secret_scan                : ${checks.a9_secret_scan.ok ? "ok" : "FAILED"} ` +
    `(${checks.a9_secret_scan.hits.length} hits across ${checks.a9_secret_scan.scanned_files} files + ${checks.a9_secret_scan.scanned_products} products)`,
);
line(
  `A10 audit_integration         : ${checks.a10_audit_integration_and_determinism.ok ? "ok" : "FAILED"} ` +
    `(${checks.a10_audit_integration_and_determinism.events_queryable} events in ${checks.a10_audit_integration_and_determinism.store}; ` +
    `two-pass checks identical = ${twoPassIdentical})`,
);
if (postReceiptHits > 0) line(`post-receipt secret scan     : FAILED (${postReceiptHits} hits)`);
for (const [name, check] of Object.entries(checks)) {
  if (check.failures && check.failures.length > 0) line(`  ${name} failures: ${JSON.stringify(check.failures, null, 2)}`);
}
line(`receipt: ${relFromRepo(RECEIPT_PATH)}`);
line(ok && postReceiptHits === 0 ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
process.exit(ok && postReceiptHits === 0 ? 0 : 1);
