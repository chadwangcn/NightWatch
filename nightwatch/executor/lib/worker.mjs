/**
 * NightWatch WP-05 — Executor Gateway (C09, §5.7 / WorkRequest §5.1–5.7)
 *
 * The unified public entry for black-box executions:
 *
 *   submit(request, options) → Promise<{ok, result?, error?}>
 *
 * Pipeline (per WorkRequest §5.1–5.7):
 *   1. execution_request validated against the FROZEN WP-00 schema;
 *   2. audit `execution.submitted` (WP-03 public API, key = exec:action);
 *   3. credential_env_allowlist non-empty ⇒ HARD WP-04 integration:
 *      policy gate (approved required) → injection lease grant → one-shot
 *      materialize → spawnEnv() worker env. gate DENIED ⇒ execution REFUSED
 *      (no worker, zero traffic). Credential VALUES stay in memory only:
 *      they reach request headers and nothing else — never logs, artifacts,
 *      audit events, results or receipts;
 *   4. audit `execution.started`;
 *   5. fixture lifecycle via the public API (Setup → Verify), every created
 *      resource recorded in the Resource Ledger (§12.2);
 *   6. builtin-blackbox worker run (monotonic-clock budget; timeout/cancel
 *      are independent terminal markers, §22.5.4);
 *   7. bounded Cleanup (own timeout; outcome preserved independently) and
 *      residual resources merged into the execution_result;
 *   8. audit `execution.finished` (+ `execution.cancelled` when cancelled);
 *   9. execution_result validated against the frozen schema before return.
 *
 * Cancel semantics: `runHandle.cancel()` flips a cancel token — new steps
 * stop first, the in-flight request is aborted, bounded cleanup runs, and the
 * result carries cancelled=true / exit_code=130.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { validateExecutionRequest, validateExecutionResult } from "./schemas.mjs";
import { validationFailed, makeError, ERROR_CODES } from "./errors.mjs";
import { ExecutorAuditSink } from "./audit.mjs";
import { FixtureCoordinator } from "./fixtures.mjs";
import { runBuiltinExecution, BUILTIN_EXECUTOR_VERSION } from "./builtin.mjs";
import { PolicyGate } from "../../policy/lib/gate.mjs";
import { InjectionLeaseManager, spawnEnv } from "../../policy/lib/lease.mjs";
import { PolicyAuditSink } from "../../policy/lib/audit.mjs";
import { LocalSecretProviderStub, CredentialBroker } from "../../policy/lib/credentials.mjs";
import { loadEnvironmentSet } from "../../policy/lib/environment.mjs";
import { readFileSync } from "node:fs";

const POLICY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policy");

const DEFAULT_ENVIRONMENTS_PATH = join(POLICY_ROOT, "fixtures", "environments.json");
const DEFAULT_SECRETS_PATH = join(POLICY_ROOT, "fixtures", "secrets.synthetic.json");
const DEFAULT_CREDENTIAL_DEFINITIONS_PATH = join(POLICY_ROOT, "fixtures", "credentials.json");

/** Cleanup budget default (bounded cleanup, §22.5.4). */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;

const iso = (ms) => new Date(ms).toISOString();

export class ExecutorGateway {
  /**
   * @param {object} options
   *   stateDir?            — runtime root for ledgers + artifacts (executor .state)
   *   auditSink?           — ExecutorAuditSink (default: shared WP-03 store)
   *   policyAuditSink?     — PolicyAuditSink (default: shared WP-03 store)
   *   environmentsPath?    — §12.1 environment set (default: WP-04 fixture)
   *   secretsPath?         — synthetic secret provider input (default: WP-04 fixture)
   *   cleanupTimeoutMs?    — bounded cleanup budget (default 5000)
   *   clock?               — () => epoch ms
   */
  constructor(options = {}) {
    this.stateDir = options.stateDir;
    this.auditSink = options.auditSink ?? new ExecutorAuditSink();
    this.policyAuditSink = options.policyAuditSink ?? new PolicyAuditSink();
    this.environmentsPath = options.environmentsPath ?? DEFAULT_ENVIRONMENTS_PATH;
    this.secretsPath = options.secretsPath ?? DEFAULT_SECRETS_PATH;
    this.credentialDefinitionsPath = options.credentialDefinitionsPath ?? DEFAULT_CREDENTIAL_DEFINITIONS_PATH;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.clock = options.clock ?? (() => Date.now());
    this._gate = null;
    this._leaseManager = null;
  }

  _policyStack() {
    if (this._gate === null) {
      const envSet = loadEnvironmentSet(this.environmentsPath);
      if (!envSet.ok) throw new Error(`environment set unreadable: ${envSet.error.message}`);
      // Provider (synthetic values) wrapped in the CredentialBroker — the
      // lease manager only ever sees the broker surface (has/_resolve).
      const provider = new LocalSecretProviderStub({ fixturePath: this.secretsPath });
      const definitions = JSON.parse(readFileSync(this.credentialDefinitionsPath, "utf8"));
      const broker = new CredentialBroker({ provider, definitions });
      this._gate = new PolicyGate({ audit: this.policyAuditSink });
      this._leaseManager = new InjectionLeaseManager({ broker, audit: this.policyAuditSink });
    }
    return { gate: this._gate, leases: this._leaseManager };
  }

  /**
   * Credential path (§5.6 hard integration): gate → lease → materialize →
   * spawnEnv. Returns {ok, workerEnv} on success (values memory-only) or
   * {ok:false, error} — a DENIED decision refuses the execution outright.
   */
  async _resolveCredentials(request, planMeta) {
    const { gate, leases } = this._policyStack();

    const envSet = loadEnvironmentSet(this.environmentsPath);
    if (!envSet.ok) return { ok: false, error: envSet.error };
    const environmentDef = envSet.set.environments.find((e) => e.environment === request.environment);
    if (!environmentDef) {
      return {
        ok: false,
        error: validationFailed(`execution environment "${request.environment}" is not defined in the environment set`, { environment: request.environment }),
      };
    }

    const decisionId = `pol-exec-${request.execution_id}`;
    const decided = gate.decide({
      decision_id: decisionId,
      requested_action: `run.execute:environment=${request.environment}`,
      environment: environmentDef,
      environmentSet: envSet.set,
      plan: {
        requests: planMeta.estimatedRequests,
        duration_seconds: request.timeout_seconds,
        parallelism: 1,
      },
      capabilities: planMeta.capabilities ?? {},
    });
    if (!decided.ok) return { ok: false, error: decided.error };
    if (decided.decision.decision !== "approved") {
      // DENIED ⇒ execution refused: no worker, no traffic (§5.6).
      return {
        ok: false,
        error: makeError(ERROR_CODES.POL_DENIED, decided.decision.reason, { decision_id: decided.decision_id }),
        decision: decided.decision,
      };
    }

    // Lease ids are issued by WP-04 (lease_<ULID26>); the gateway never
    // fabricates its own lease ids.
    const granted = leases.grant({
      run_id: request.run_id,
      allowlist: request.credential_env_allowlist,
      decision: decided.decision,
    });
    if (!granted.ok) return { ok: false, error: granted.error };

    const materialized = [];
    for (const lease of granted.leases) {
      const m = leases.materialize(lease.lease_id);
      if (!m.ok) return { ok: false, error: m.error };
      materialized.push(m.env);
    }
    // Worker env: ONLY the allowlisted keys survive (§13.1 rule 4). The values
    // below NEVER reach logs / artifacts / audit / results / receipts.
    const workerEnv = spawnEnv(materialized, request.credential_env_allowlist);
    return {
      ok: true,
      workerEnv,
      leasesMeta: {
        references: [...request.credential_env_allowlist],
        lease_ids: granted.leases.map((l) => l.lease_id),
      },
      decision: decided.decision,
    };
  }

  /**
   * Submit one execution through the unified contract.
   *
   * @param {object} request WP-00 execution_request
   * @param {object} options
   *   baseUrl      — target (Golden Fault API stub) base URL; the schema has
   *                  no URL field by design — environment names + external
   *                  resolution keep executors environment-neutral
   *   compiled     — WP-02 compile output {collection, manifest, sourceMap}
   *   cases        — Map<case_id, test_case> validated cases
   *   datasets?    — { [ref]: object }
   *   fixtures?    — { setupCount?: number, setupOverrides?: Array<{cleanup_path}> }
   *   capabilities? — WP-04 decide capabilities (e.g. {write:true})
   * @returns {Promise<{ok: true, result: object, details: object}
   *           | {ok: false, error: object}>}
   *   The returned handle is ALSO a cancellable run: submit() resolves with
   *   {cancel} exposed via options.onStarted token — see verify usage. For
   *   cancellation pass options.cancelToken ({cancelled:boolean}) and flip it
   *   from outside while awaiting.
   */
  async submit(request, options = {}) {
    const schemaCheck = validateExecutionRequest(request);
    if (!schemaCheck.ok) {
      return { ok: false, error: validationFailed("execution_request failed the frozen WP-00 schema", { errors: schemaCheck.errors }) };
    }

    const auditedSubmit = this.auditSink.append({ execution_id: request.execution_id, action: "submitted", timestamp: iso(this.clock()) });
    if (!auditedSubmit.ok) return { ok: false, error: auditedSubmit.error };

    let workerEnv = {};
    let leasesMeta = { references: [], lease_ids: [] };
    let decision = null;
    if (request.credential_env_allowlist.length > 0) {
      const planMeta = {
        estimatedRequests: options.estimatedRequests ?? request.repetitions * (options.compiled?.collection.item.length ?? 1),
        capabilities: options.capabilities ?? {},
      };
      const cred = await this._resolveCredentials(request, planMeta);
      if (!cred.ok) return { ok: false, error: cred.error };
      workerEnv = cred.workerEnv;
      leasesMeta = cred.leasesMeta;
      decision = cred.decision;
    }

    const auditedStart = this.auditSink.append({ execution_id: request.execution_id, action: "started", timestamp: iso(this.clock()) });
    if (!auditedStart.ok) return { ok: false, error: auditedStart.error };

    // Fixture lifecycle through the public API (§12.2): Plan (implicit) →
    // Allocate Namespace → Setup → Verify; Cleanup runs after the worker.
    let fixture = null;
    let fixtureSetup = { ok: true, created: [] };
    if (options.fixtures && options.fixtures.setupCount > 0 && this.stateDir) {
      fixture = new FixtureCoordinator({
        executionId: request.execution_id,
        ledgerDir: join(this.stateDir, "fixtures"),
        baseUrl: options.baseUrl,
        clock: this.clock,
      });
      fixtureSetup = await fixture.setup({ count: options.fixtures.setupCount });
      if (!fixtureSetup.ok) return { ok: false, error: fixtureSetup.error };
      // Cleanup-path overrides for bounded-cleanup scenarios (injected AFTER
      // the public-API setup as SUPERSEDING ledger entries — bookkeeping stays
      // append-only and real).
      const overrides = options.fixtures.setupOverrides ?? [];
      const allocated = fixture.orphanResources();
      for (let i = 0; i < Math.min(overrides.length, allocated.length); i += 1) {
        if (overrides[i] && overrides[i].cleanup_path) {
          fixture.overrideCleanupPath(allocated[i].resource_id, overrides[i].cleanup_path);
        }
      }
    }

    let run;
    try {
      run = await runBuiltinExecution({
        request,
        compiled: options.compiled,
        cases: options.cases,
        datasets: options.datasets ?? {},
        baseUrl: options.baseUrl,
        workerEnv,
        cancelToken: options.cancelToken ?? { cancelled: false },
        stateDir: this.stateDir,
        leasesMeta,
      });
    } catch (e) {
      return {
        ok: false,
        error: { code: "EXE_WORKER_FAILED", message: `builtin worker failed abnormally: ${e.message}` },
      };
    }

    // Bounded cleanup (§22.5.4): its own budget; timed-out/failed cleanup is
    // preserved as an independent outcome, never swallowed.
    let cleanupOutcome = { status: "skipped", residual_resources: [] };
    if (fixture) {
      cleanupOutcome = await fixture.cleanup({ timeout_ms: options.cleanupTimeoutMs ?? this.cleanupTimeoutMs });
    }

    const result = { ...run.result, cleanup: { status: cleanupOutcome.status, residual_resources: cleanupOutcome.residual_resources } };

    if (result.cancelled) {
      this.auditSink.append({ execution_id: request.execution_id, action: "cancelled", timestamp: iso(this.clock()) });
    }
    this.auditSink.append({ execution_id: request.execution_id, action: "finished", timestamp: iso(this.clock()) });

    const resultCheck = validateExecutionResult(result);
    if (!resultCheck.ok) {
      return { ok: false, error: validationFailed("execution_result failed the frozen WP-00 schema", { errors: resultCheck.errors }) };
    }

    return {
      ok: true,
      result,
      details: { caseRuns: run.details, nonces: run.nonces, interruptionReason: run.interruptionReason, cleanupOutcome, fixtureCreated: fixtureSetup.created.length, decision },
    };
  }
}

export { BUILTIN_EXECUTOR_VERSION };
