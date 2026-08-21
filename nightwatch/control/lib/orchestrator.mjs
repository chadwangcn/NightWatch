/**
 * NightWatch WP-08 — QA Orchestrator (C03, §5.11-3 / §7.2 / §7.3)
 *
 * Only manages ORDER; never seizes judgement:
 *   - every component verdict (policy / finding / issue gate) is produced by
 *     the owning component through its real public API and passed through
 *     UNCHANGED — the orchestrator neither rewrites nor swallows error codes;
 *   - the session state machine (§7.2) is the only sequencing authority:
 *     legal transitions emit sessionStateChanged, illegal ones are rejected;
 *   - after every completed step a WP-00 checkpoint (seven §7.2 elements) is
 *     written through the WP-03 public API, so an interrupted session resumes
 *     from the latest checkpoint WITHOUT redoing completed steps (§7.3).
 *
 * startRun chain (all real public APIs):
 *   registry contract pin → library validated cases + compile → policy decide
 *   (denied ⇒ ZERO execution) → executor submit (Execution Contract) →
 *   evidence ingest + seal → finding classification → confirmed-finding drafts.
 *
 * publishIssue chain: issue_review state + confirmed finding → C13 gateway
 * (six gates + idempotency live inside C13); policy denied ⇒ zero publication.
 * Recovery double line (§7.3 恢复不重复发布): the orchestrator's own
 * published-draft bookkeeping AND C13's idempotency registry (deterministic
 * key `<draft_id>:publish`) both guarantee a resumed session never produces a
 * second GitHub write.
 *
 * Step scoping (resume no-redo unit):
 *   registry_pin:<api_id> · library_cases:<scenario_id> · policy_gate:<run_id>
 *   · execute:<run_id> · evidence_ingest:<run_id> · evidence_seal:<run_id>
 *   · finding_classify:<run_id> · issue_drafts:<run_id>
 *   · issue_publish:<draft_id> · retest:<issue_ref>
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { buildFingerprint, fingerprintHash, TERMINAL_RUN_STATUSES } from "../../evidence/lib/index.mjs";
import { compileScenario } from "../../library/lib/compile.mjs";
import { FixtureCoordinator } from "../../executor/lib/fixtures.mjs";
import { makeCancelToken } from "../../executor/lib/builtin.mjs";

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Thrown by the interruption injector (fixture-driven crash simulation). */
export class OrchestrationInterrupted extends Error {
  constructor(step) {
    super(`orchestration interrupted after step "${step}" (injected crash)`);
    this.name = "OrchestrationInterrupted";
    this.step = step;
  }
}

/** Ordered session states for "already at or beyond" resume reasoning. */
const STATE_ORDER = [
  "discovery",
  "library_draft",
  "library_review",
  "environment_ready",
  "running",
  "analyzing",
  "issue_review",
  "published",
  "retest_pending",
  "closed",
];

const atOrBeyond = (current, target) => {
  if (current === "blocked") return true; // side-state of running
  if (current === "inconclusive") current = "published"; // same tier (§7.2)
  const c = STATE_ORDER.indexOf(current);
  const t = STATE_ORDER.indexOf(target);
  return c >= t;
};

/** Map a failed assertion line to an assertion class (§15 fingerprint part). */
function assertionClassOf(line) {
  if (line.startsWith("status.")) return "status-code";
  if (line.startsWith("jsonpath.")) return "body-jsonpath";
  if (line.startsWith("header.")) return "header-value";
  if (line.startsWith("elapsed.")) return "elapsed-time";
  return "assertion";
}

export class Orchestrator {
  /**
   * Every component option is the REAL public instance (Wave 4 rule):
   *   stateDir / ids / clock / events / sessions      — C02/C03 own pieces
   *   checkpoints / audit                             — WP-03 public API
   *   registry (WP-01) / library (WP-02)              — public read APIs
   *   policyGate + environmentSet (WP-04)             — public decide API
   *   executor (WP-05) / evidence + evidenceIds + findings (WP-06)
   *   issueGateway (WP-07) / baseUrl (Golden Fault stub target)
   *   runProfiles — fixture orchestration profiles keyed by scenario_id
   *   defaultEnvironment / timeoutSeconds / cleanupTimeoutMs
   */
  constructor(options) {
    Object.assign(this, options);
    this.pipelinesDir = join(this.stateDir, "pipelines");
    this.publishedPath = join(this.stateDir, "published-drafts.jsonl");
    this.draftsPath = join(this.stateDir, "drafts.jsonl");
    mkdirSync(this.pipelinesDir, { recursive: true });
    if (!existsSync(this.publishedPath)) writeFileSync(this.publishedPath, "", { flag: "wx" });
    if (!existsSync(this.draftsPath)) writeFileSync(this.draftsPath, "", { flag: "wx" });
    this.approvals = []; // host-registered approval records (C02 adapter surface)
    this.cancelTokens = new Map(); // run_id → {cancelled}
    this.stepCalls = new Map(); // step token → invocation count (no-redo evidence)
    this.interruptAfter = null; // fixture: step token triggering the injected crash
    this.faults = new Map(); // fixture: step token → injected component error envelope
    this._retestMode = false; // retest executions do not drive session states
  }

  /**
   * Fixture surface (A8): register a single-component failure to be returned
   * at the given step boundary, exactly as if the owning component had failed.
   * The injected envelope must be a REGISTERED error (EVD_ / EXE_ / FND_ /
   * ISS_ family); it passes through the fault-isolation path unchanged,
   * like any real one.
   */
  injectFault(stepToken, error) {
    this.faults.set(stepToken, error);
    return { ok: true, injected: stepToken, code: error.code };
  }

  clearFault(stepToken) {
    this.faults.delete(stepToken);
  }

  /**
   * Fixture surface (A6): crash the orchestration IN-PROCESS right AFTER the
   * given step token completed (simulating a lost process between steps).
   * Special token form `issue_publish_write:<draft_id>` crashes between the
   * C13 GitHub write and the orchestrator's publish bookkeeping.
   */
  scheduleInterrupt(stepToken) {
    this.interruptAfter = stepToken;
    return { ok: true, interrupt_after: stepToken };
  }

  clearInterrupt() {
    this.interruptAfter = null;
  }

  /* ================================================================ */
  /* Pipeline + bookkeeping persistence                                */
  /* ================================================================ */

  #pipelinePath(sessionId) {
    return join(this.pipelinesDir, `${sessionId}.json`);
  }

  #loadPipeline(sessionId) {
    const p = this.#pipelinePath(sessionId);
    if (!existsSync(p)) {
      return {
        session_id: sessionId,
        runs: [],
        active_run_id: null,
        completed_steps: [],
        next_checkpoint_sequence: 1,
        key_decisions: [],
      };
    }
    return JSON.parse(readFileSync(p, "utf8"));
  }

  #savePipeline(pipeline) {
    writeFileSync(this.#pipelinePath(pipeline.session_id), `${JSON.stringify(pipeline, null, 2)}\n`, "utf8");
  }

  #appendJsonl(path, record) {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** Orchestration-layer publish guard: draft_id → receipt records. */
  publishedDrafts() {
    if (!existsSync(this.publishedPath)) return [];
    return readFileSync(this.publishedPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }

  /** Drafts built from confirmed findings (FULL WP-00 draft objects persisted
   *  so publish replays present the byte-identical payload to C13). */
  #drafts() {
    if (!existsSync(this.draftsPath)) return [];
    return readFileSync(this.draftsPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }

  findDraft(draftId) {
    return this.#drafts().find((d) => d.draft_id === draftId) ?? null;
  }

  /** All draft records (C02 display DTO surface). */
  allDrafts() {
    return this.#drafts();
  }

  /** Pipeline of one session (C02 display DTO surface). */
  pipelineOf(sessionId) {
    return this.#loadPipeline(sessionId);
  }

  /* ================================================================ */
  /* Checkpoints (§7.2 seven elements, WP-03 public API)               */
  /* ================================================================ */

  #checkpoint(pipeline, session, { pending, blocking = "" }) {
    const keyDecisions = pipeline.key_decisions ?? [];
    const checkpoint = {
      session_id: session.session_id,
      sequence: pipeline.next_checkpoint_sequence,
      goal: session.goal,
      authorization_boundary: session.authorization_boundary ?? "inherited from the session goal (no explicit boundary recorded)",
      confirmed: {
        apis: [...new Set(pipeline.runs.flatMap((r) => (r.api_id ? [r.api_id] : [])))],
        environments: [...new Set(pipeline.runs.map((r) => r.environment).filter(Boolean))],
        scenarios: [...new Set(pipeline.runs.map((r) => r.scenario_id).filter(Boolean))],
        executors: [...new Set(pipeline.runs.map((r) => r.executor).filter(Boolean))],
      },
      completed_steps: pipeline.completed_steps.map((s) => ({ step: s.token, output_checksum: s.output_checksum })),
      pending_tasks: pending.map((task) => ({ task, blocking_reason: blocking })),
      credential_variables_used: [],
      next_allowed_actions: blocking
        ? ["resumeSession (unblock and continue from this checkpoint)"]
        : pending.length > 0
          ? ["resumeSession (continue pending tasks)"]
          : ["publishIssue (confirmed findings in issue_review)", "retestIssue (after published)"],
      key_decisions: keyDecisions,
      idempotency_key: `${session.session_id}:ckpt:${pipeline.next_checkpoint_sequence}`,
      created_at: this.clock(),
    };
    const written = this.checkpoints.write(checkpoint);
    if (!written.ok) return written;
    pipeline.next_checkpoint_sequence += 1;
    // Persist the advanced sequence together with the write: WP-03 rejects
    // duplicate sequences ("history is never overwritten"), so a reloaded
    // pipeline must never propose an already-used one.
    this.#savePipeline(pipeline);
    return { ok: true, checkpoint };
  }

  #auditStep(sessionId, stepToken, objectType, objectId) {
    return this.audit.record({
      actor: "C03-orchestrator",
      action: `orchestration.step:${stepToken.split(":")[0]}`,
      target: { object_type: objectType, object_id: objectId },
      timestamp: this.clock(),
      idempotency_key: `${sessionId}:${stepToken}`,
    });
  }

  /** Record one completed step: invocation count + audit + checkpoint + event. */
  #completeStep(pipeline, session, run, stepToken, checksumPayload, pendingAfter) {
    this.stepCalls.set(stepToken, (this.stepCalls.get(stepToken) ?? 0) + 1);
    const audited = this.#auditStep(session.session_id, stepToken, run ? "run" : "session", run ? run.run_id : session.session_id);
    if (!audited.ok) return audited;
    const token = { token: stepToken, output_checksum: `sha256:${sha256hex(String(checksumPayload))}`, at: this.clock() };
    if (!pipeline.completed_steps.some((s) => s.token === stepToken)) pipeline.completed_steps.push(token);
    this.#savePipeline(pipeline);
    const ckpt = this.#checkpoint(pipeline, session, { pending: pendingAfter });
    if (!ckpt.ok) return ckpt;
    const stepEvent = this.events.emit("runStepRecorded", {
      object_id: run.run_id,
      object_type: "run",
      payload: {
        step: stepToken,
        step_index: pipeline.completed_steps.length - 1,
        status: "passed",
        output_checksum: token.output_checksum,
      },
    });
    if (!stepEvent.ok) return stepEvent;
    const interruptAlias = stepToken.split(":")[0];
    if (this.interruptAfter === stepToken || this.interruptAfter === interruptAlias) {
      this.interruptAfter = null;
      throw new OrchestrationInterrupted(stepToken);
    }
    return { ok: true };
  }

  #transitionTo(session, toState, reason = "") {
    if (this._retestMode) return { ok: true, session }; // retest runs leave session states alone
    if (session.state === toState || atOrBeyond(session.state, toState)) return { ok: true, session };
    return this.sessions.transition(session, toState, reason);
  }

  /**
   * Fixture-driven single-component failure at a step boundary (§5.5): the
   * injected envelope is returned exactly like a real component failure —
   * session blocked with the code+reason, artifacts left intact.
   * Registered keys may be the exact scoped token (`execute:<run_id>`) or the
   * phase alias (`execute`) — the latter fires at the next step of that phase
   * (run ids are not known before the run starts).
   * @returns {{handled: true, result: {ok: false, error: object}} | {handled: false}}
   */
  #faultAt(stepToken, pipeline, session, run, pendingAfter) {
    const injected = this.faults.get(stepToken) ?? this.faults.get(stepToken.split(":")[0]);
    if (!injected) return { handled: false };
    this.faults.delete(stepToken);
    this.faults.delete(stepToken.split(":")[0]);
    return { handled: true, result: this.#failWithBlock(pipeline, session, run, injected, pendingAfter) };
  }

  /**
   * Fault isolation (§5.5): blocked with reason when legally reachable
   * (running → blocked); artifacts already on disk are NEVER rolled back;
   * the component error envelope passes through UNCHANGED.
   */
  #failWithBlock(pipeline, session, run, error, pendingAfter) {
    let current = session;
    const reason = `${error.code}: ${error.message}`;
    if (current.state === "running") {
      const blocked = this.sessions.transition(current, "blocked", reason);
      if (blocked.ok) current = blocked.session;
    }
    if (run) pipeline.active_run_id = run.run_id;
    this.#savePipeline(pipeline);
    this.#checkpoint(pipeline, current, { pending: pendingAfter, blocking: reason });
    return { ok: false, error };
  }

  /* ================================================================ */
  /* createSession                                                     */
  /* ================================================================ */

  createSession({ workspace_id, goal, authorization_boundary }) {
    const session = {
      session_id: this.ids.sessionId(),
      workspace_id,
      goal,
      state: "discovery",
      ...(authorization_boundary ? { authorization_boundary } : {}),
      created_at: this.clock(),
      updated_at: this.clock(),
    };
    const saved = this.sessions.save(session);
    if (!saved.ok) return saved;
    const pipeline = this.#loadPipeline(session.session_id);
    pipeline.key_decisions = [{ decision: "session created in discovery", rationale: "initial state per §7.2" }];
    this.#savePipeline(pipeline);
    const ckpt = this.#checkpoint(pipeline, session, { pending: ["startRun"] });
    if (!ckpt.ok) return ckpt;
    this.#auditStep(session.session_id, "session:create", "session", session.session_id);
    return { ok: true, session_id: session.session_id, session };
  }

  /* ================================================================ */
  /* startRun (§5.11-3 chain)                                           */
  /* ================================================================ */

  async startRun({ session_id, environment, scenario_id }) {
    let session = this.sessions.load(session_id);
    if (!session) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `session ${session_id} not found`, { reason: "session_not_found" }) };
    }
    if (session.state === "blocked") {
      const unblocked = this.sessions.transition(session, "running", "resume from blocked");
      if (!unblocked.ok) return unblocked;
      session = unblocked.session;
    }
    const envName = environment ?? this.defaultEnvironment;
    const scenarioId = scenario_id ?? Object.keys(this.runProfiles)[0];
    const profile = this.runProfiles[scenarioId];
    if (!profile) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `no run profile registered for scenario ${scenarioId}`, { reason: "scenario_not_registered" }) };
    }
    const environmentDef = this.environmentSet.environments.find((e) => e.environment === envName);
    if (!environmentDef) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `environment "${envName}" is not defined in the environment set`, { reason: "environment_not_defined" }) };
    }

    const pipeline = this.#loadPipeline(session_id);
    // Resume target: the most recent run of this scenario whose per-run steps
    // are NOT all completed (covers both `interrupted` runs and runs whose
    // execute finished but ingest/seal/classify/drafts did not — §7.3 no-redo).
    const runStepsDone = (r) =>
      ["execute", "evidence_ingest", "evidence_seal", "finding_classify", "issue_drafts"].every((phase) =>
        pipeline.completed_steps.some((s) => s.token === `${phase}:${r.run_id}`));
    let run = [...pipeline.runs].reverse().find((r) => r.scenario_id === scenarioId && !runStepsDone(r));
    if (!run) {
      run = {
        run_id: this.ids.runId(),
        execution_id: null,
        supersedes_run_id: null,
        scenario_id: scenarioId,
        api_id: profile.api_id,
        environment: envName,
        seed: profile.seed ?? 7,
        repetitions: profile.repetitions ?? 1,
        executor: "curl",
        status: "interrupted",
        started_at: this.clock(),
        finished_at: null,
        case_summary: null,
        outcome: null,
      };
      pipeline.runs.push(run);
    }
    pipeline.active_run_id = run.run_id;
    // Every run object carries the contract pin: retries/retests create fresh
    // runs AFTER the registry step completed, so they inherit the pin from a
    // prior run of the same scenario (or read it from the registry entry).
    // The evidence manifest (WP-00 run/v1) requires it on every sealed run.
    if (!run.contract_pin) {
      const prior = [...pipeline.runs].reverse().find((r) => r.scenario_id === scenarioId && r.contract_pin);
      if (prior) run.contract_pin = prior.contract_pin;
      else {
        const entry = this.registry.getEntry(profile.api_id);
        if (entry?.last_valid) run.contract_pin = { source_revision: entry.last_valid.revision, checksum: entry.last_valid.checksum };
      }
      this.#savePipeline(pipeline);
    }

    const T = {
      registry: `registry_pin:${profile.api_id}`,
      library: `library_cases:${scenarioId}`,
      policy: `policy_gate:${run.run_id}`,
      execute: `execute:${run.run_id}`,
      ingest: `evidence_ingest:${run.run_id}`,
      seal: `evidence_seal:${run.run_id}`,
      classify: `finding_classify:${run.run_id}`,
      drafts: `issue_drafts:${run.run_id}`,
    };
    const ORDER = [T.registry, T.library, T.policy, T.execute, T.ingest, T.seal, T.classify, T.drafts];
    const done = (token) => pipeline.completed_steps.some((s) => s.token === token);
    const rest = (token) => ORDER.slice(ORDER.indexOf(token) + 1);

    /* ---- Step 1: registry contract pin (WP-01 public read API) ----- */
    if (!done(T.registry)) {
      const entry = this.registry.getEntry(profile.api_id);
      if (!entry || !entry.last_valid) {
        return this.#failWithBlock(pipeline, session, run, makeError(ERROR_CODES.VALIDATION_FAILED, `registry has no last_valid contract pin for api "${profile.api_id}" (execution refused; zero traffic)`, { reason: "contract_pin_missing", api_id: profile.api_id }), rest(T.registry));
      }
      run.contract_pin = { source_revision: entry.last_valid.revision, checksum: entry.last_valid.checksum };
      this.#savePipeline(pipeline);
      const step = this.#completeStep(pipeline, session, run, T.registry, JSON.stringify(run.contract_pin), rest(T.registry));
      if (!step.ok) return step;
    }

    /* ---- Step 2: library validated cases + compile (WP-02) --------- */
    if (!done(T.library)) {
      const scenario = this.library.getScenario(scenarioId);
      if (!scenario) {
        return this.#failWithBlock(pipeline, session, run, makeError(ERROR_CODES.VALIDATION_FAILED, `scenario ${scenarioId} not found in the library`, { reason: "scenario_not_found" }), rest(T.library));
      }
      for (const caseId of scenario.case_ids) {
        const oneCase = this.library.getCase(caseId);
        if (!oneCase || !["validated", "active"].includes(oneCase.status)) {
          return this.#failWithBlock(pipeline, session, run, makeError(ERROR_CODES.VALIDATION_FAILED, `case ${caseId} missing or not validated/active in the library`, { reason: "case_not_validated", case_id: caseId }), rest(T.library));
        }
      }
      const compiled = compileScenario(this.library, { apiId: profile.api_id, scenarioId });
      if (!compiled.ok) {
        return this.#failWithBlock(pipeline, session, run, compiled.error, rest(T.library));
      }
      const toDraft = await this.#transitionTo(session, "library_draft", "library cases loaded and validated");
      if (!toDraft.ok) return toDraft;
      session = toDraft.session;
      const toReview = await this.#transitionTo(session, "library_review", "scenario compiled");
      if (!toReview.ok) return toReview;
      session = toReview.session;
      const manifestPayload = JSON.stringify(compiled.collection.item.map((i) => i.name).sort());
      const step = this.#completeStep(pipeline, session, run, T.library, manifestPayload, rest(T.library));
      if (!step.ok) return step;
    }

    /* ---- Step 3: policy decide (WP-04 public API) ------------------ */
    if (!done(T.policy)) {
      const fault = this.#faultAt(T.policy, pipeline, session, run, [T.policy, ...rest(T.policy)]);
      if (fault.handled) return fault.result;
      const caseCount = this.library.getScenario(scenarioId)?.case_ids.length ?? 1;
      const decided = this.policyGate.decide({
        decision_id: `pol-run-${run.run_id}`,
        requested_action: `run.execute:environment=${envName}`,
        environment: environmentDef,
        environmentSet: this.environmentSet,
        plan: { requests: run.repetitions * caseCount, duration_seconds: this.timeoutSeconds ?? 30, parallelism: 1 },
      });
      if (!decided.ok) {
        return this.#failWithBlock(pipeline, session, run, decided.error, rest(T.policy));
      }
      if (decided.decision.decision !== "approved") {
        // DENIED ⇒ zero execution (§5.11-3): no executor call, no traffic.
        const denied = makeError(ERROR_CODES.VALIDATION_FAILED, `policy denied the execution: ${decided.decision.reason}`, {
          reason: "policy_denied",
          policy_code: decided.code ?? "POL_DENIED",
          decision_id: decided.decision_id,
        });
        return this.#failWithBlock(pipeline, session, run, denied, rest(T.policy));
      }
      const toEnvReady = await this.#transitionTo(session, "environment_ready", `environment ${envName} approved by policy`);
      if (!toEnvReady.ok) return toEnvReady;
      session = toEnvReady.session;
      const step = this.#completeStep(pipeline, session, run, T.policy, JSON.stringify({ decision_id: decided.decision_id, decision: "approved" }), rest(T.policy));
      if (!step.ok) return step;
    }

    /* ---- Step 4: executor submit (WP-05 public API) ---------------- */
    if (!done(T.execute)) {
      const compiled = compileScenario(this.library, { apiId: run.api_id, scenarioId });
      if (!compiled.ok) return this.#failWithBlock(pipeline, session, run, compiled.error, rest(T.execute));
      const scenario = this.library.getScenario(scenarioId);
      const executionId = `exec_${run.run_id.slice(4)}`;
      run.execution_id = executionId;
      // §22.5.4 token: `cancelled` gates NEW steps; `aborters` terminate the
      // in-flight worker when cancelRun() invokes token.cancel().
      const cancelToken = makeCancelToken();
      this.cancelTokens.set(run.run_id, cancelToken);
      const toRunning = await this.#transitionTo(session, "running", `run ${run.run_id} executing`);
      if (!toRunning.ok) return toRunning;
      session = toRunning.session;
      // §5.5 fault-isolation injection point: the session is RUNNING here, so
      // an injected single-component failure blocks it with the reason kept.
      const fault = this.#faultAt(T.execute, pipeline, session, run, [T.execute, ...rest(T.execute)]);
      if (fault.handled) return fault.result;
      this.#savePipeline(pipeline);
      const startedEvent = this.events.emit("runStarted", {
        object_id: run.run_id,
        object_type: "run",
        payload: { started_at: this.clock(), environment: envName, execution_id: executionId, scenario_id: scenarioId },
      });
      if (!startedEvent.ok) return startedEvent;
      const submitted = await this.executor.submit(
        {
          execution_id: executionId,
          run_id: run.run_id,
          executor: "curl",
          executor_version: "builtin-blackbox@1.0.0",
          scenario_ref: `${scenarioId}/r${pipeline.runs.indexOf(run) + 1}`,
          environment: envName,
          timeout_seconds: this.timeoutSeconds ?? 30,
          repetitions: run.repetitions,
          seed: run.seed,
          credential_env_allowlist: [],
          artifact_policy: "full-on-failure",
          idempotency_key: `${run.run_id}:execute`,
          deadline: new Date(Date.parse(this.clock()) + 600_000).toISOString(),
        },
        {
          baseUrl: this.baseUrl,
          compiled,
          cases: this.#casesMap(scenarioId),
          datasets: {},
          ...(profile.fixtures ? { fixtures: profile.fixtures } : {}),
          estimatedRequests: run.repetitions * (scenario?.case_ids.length ?? 1),
          cancelToken,
          cleanupTimeoutMs: this.cleanupTimeoutMs,
        }
      );
      if (!submitted.ok) {
        return this.#failWithBlock(pipeline, session, run, submitted.error, rest(T.execute));
      }
      const result = submitted.result;
      run.case_summary = this.#caseSummary(result.case_results);
      run.outcome = this.#outcomeOf(result);
      run.status = run.outcome;
      run.finished_at = this.clock();
      run.cancelled = Boolean(result.cancelled);
      run.timed_out = Boolean(result.timed_out);
      run.cleanup_status = result.cleanup.status;
      run.execution_details = submitted.details.caseRuns;
      this.#savePipeline(pipeline);
      const completedEvent = this.events.emit("runCompleted", {
        object_id: run.run_id,
        object_type: "run",
        payload: {
          outcome: run.outcome,
          case_summary: run.case_summary,
          finished_at: run.finished_at,
          duration_ms: result.duration_ms,
          cleanup_status: result.cleanup.status,
        },
      });
      if (!completedEvent.ok) return completedEvent;
      const step = this.#completeStep(pipeline, session, run, T.execute, JSON.stringify(run.case_summary), rest(T.execute));
      if (!step.ok) return step;
    }

    /* ---- Step 5: evidence ingest (WP-06 public API) ---------------- */
    if (!done(T.ingest)) {
      const toAnalyzing = await this.#transitionTo(session, "analyzing", `evidence ingest for run ${run.run_id}`);
      if (!toAnalyzing.ok) return toAnalyzing;
      session = toAnalyzing.session;
      const opened = this.evidence.open(run.run_id);
      let bundle;
      if (opened.ok) {
        bundle = opened.bundle;
      } else {
        const created = this.evidence.createRun({
          run_id: run.run_id,
          execution_id: run.execution_id,
          workspace_id: session.workspace_id,
          session_id: session.session_id,
          plan_id: undefined,
          scenario_id: scenarioId,
          scenario_revision: this.library.getScenario(scenarioId)?.revision ?? "r1",
          status: TERMINAL_RUN_STATUSES.includes(run.outcome) ? run.outcome : "failed",
          contract_pin: run.contract_pin,
          environment_name: envName,
          // Logical (deterministic) URL for the sealed manifest; the live stub
          // URL never enters evidence — it would break the A10 byte-compare
          // (ephemeral port) and adds nothing a sanitized origin must keep.
          base_url: this.evidenceBaseUrl ?? this.baseUrl,
          executor: "curl",
          executor_version: "builtin-blackbox@1.0.0",
          agent_host_type: "builtin",
          seed: run.seed,
          started_at: run.started_at,
          finished_at: run.finished_at ?? this.clock(),
          duration_ms: run.duration_ms ?? 0,
          command_summary: `orchestrated run ${run.run_id} via builtin-blackbox`,
        });
        if (!created.ok) return this.#failWithBlock(pipeline, session, run, created.error, rest(T.ingest));
        bundle = created.bundle;
      }
      const details = run.execution_details ?? [];
      const caseEvents = [];
      const observations = [];
      let repetition = 0;
      for (const caseRun of details) {
        repetition += 1;
        const oneCase = this.#casesMap(scenarioId).get(caseRun.case_id);
        const last = [...caseRun.evidence].reverse().find((e) => e.status_code !== undefined);
        const failedAssertion = caseRun.evidence.flatMap((e) => e.assertions ?? []).find((a) => a.passed === false);
        const event = {
          case_id: caseRun.case_id,
          execution_id: run.execution_id,
          result: caseRun.status,
          api_id: oneCase?.api_id ?? run.api_id,
          method: last?.method ?? oneCase?.steps?.[0]?.request?.method ?? "GET",
          path: last?.path ?? oneCase?.steps?.[0]?.request?.path ?? "/",
          assertion_class: failedAssertion ? assertionClassOf(failedAssertion.raw) : "assertion",
          status_or_error: caseRun.error ?? String(last?.status_code ?? "unknown"),
          response_signature: `sig:${last?.status_code ?? "none"}:${failedAssertion?.raw ?? caseRun.error ?? "clean"}`,
          scenario_state: `${scenarioId}:base`,
        };
        const ingested = bundle.ingestCaseEvent(event);
        if (!ingested.ok) return this.#failWithBlock(pipeline, session, run, ingested.error, rest(T.ingest));
        caseEvents.push(event);
        if (caseRun.status === "failed" || caseRun.status === "error") {
          const observation = {
            observation_id: this.evidenceIds.observationId(),
            run_id: run.run_id,
            execution_id: run.execution_id,
            case_id: caseRun.case_id,
            occurred_at: this.clock(),
            fact: {
              api_id: event.api_id,
              method: event.method,
              path: event.path,
              status_or_error: event.status_or_error,
              response_signature: event.response_signature,
            },
            context: { scenario_id: scenarioId, scenario_state: event.scenario_state, seed: run.seed, repetition },
            evidence_ref: (ingested.refs ?? []).find((r) => r.startsWith("responses/")) ?? "cases.jsonl",
          };
          const recorded = bundle.recordObservation(observation);
          if (!recorded.ok) return this.#failWithBlock(pipeline, session, run, recorded.error, rest(T.ingest));
          observations.push(observation);
          const obsEvent = this.events.emit("observationRecorded", {
            object_id: observation.observation_id,
            object_type: "observation",
            payload: {
              run_id: run.run_id,
              summary: `${event.method} ${event.path} → ${event.status_or_error} (${failedAssertion?.raw ?? caseRun.error ?? "failure"})`,
              execution_id: run.execution_id,
              case_id: caseRun.case_id,
            },
          });
          if (!obsEvent.ok) return obsEvent;
        }
      }
      const cleanupRecorded = bundle.recordCleanup({ status: run.cleanup_status ?? "skipped", details: `orchestrated cleanup for ${run.run_id}` });
      if (!cleanupRecorded.ok) return this.#failWithBlock(pipeline, session, run, cleanupRecorded.error, rest(T.ingest));
      run.case_events = caseEvents;
      run.observations = observations.map((o) => o.observation_id);
      this.#savePipeline(pipeline);
      const step = this.#completeStep(pipeline, session, run, T.ingest, JSON.stringify(caseEvents.map((e) => [e.case_id, e.result])), rest(T.ingest));
      if (!step.ok) return step;
    }

    /* ---- Step 6: evidence seal (WP-06 public API) ------------------ */
    if (!done(T.seal)) {
      const opened = this.evidence.open(run.run_id);
      if (!opened.ok) return this.#failWithBlock(pipeline, session, run, opened.error, rest(T.seal));
      const sealed = opened.bundle.seal();
      if (!sealed.ok) return this.#failWithBlock(pipeline, session, run, sealed.error, rest(T.seal));
      run.sealed = true;
      this.evidence.buildIndex();
      this.#savePipeline(pipeline);
      const step = this.#completeStep(pipeline, session, run, T.seal, `sealed:${run.run_id}`, rest(T.seal));
      if (!step.ok) return step;
    }

    /* ---- Step 7: finding classification (WP-06 FindingStore) ------- */
    if (!done(T.classify)) {
      const fault = this.#faultAt(T.classify, pipeline, session, run, [T.classify, ...rest(T.classify)]);
      if (fault.handled) return fault.result;
      const groups = this.#groupFindingCandidates(run);
      const classified = [];
      for (const group of groups) {
        const submitted = this.findings.submit({
          parts: group.parts,
          attempts: group.attempts,
          failures: group.failures,
          observations: group.observations,
        });
        if (!submitted.ok) return this.#failWithBlock(pipeline, session, run, submitted.error, rest(T.classify));
        if (submitted.status === "created") {
          const fcEvent = this.events.emit("findingClassified", {
            object_id: submitted.finding.finding_id,
            object_type: "finding",
            payload: {
              classification: submitted.finding.classification,
              reproduction: submitted.finding.reproduction,
              fingerprint_digest: fingerprintHash(submitted.finding.fingerprint),
            },
          });
          if (!fcEvent.ok) return fcEvent;
          classified.push(submitted.finding);
        }
      }
      run.finding_ids = classified.map((f) => f.finding_id);
      this.#savePipeline(pipeline);
      const step = this.#completeStep(pipeline, session, run, T.classify, JSON.stringify(run.finding_ids), rest(T.classify));
      if (!step.ok) return step;
    }

    /* ---- Step 8: confirmed-finding drafts (WP-07 buildDraft) ------- */
    if (!done(T.drafts) && !this._retestMode) {
      for (const findingId of run.finding_ids ?? []) {
        const finding = this.#findingById(findingId);
        if (!finding || finding.classification !== "confirmed") continue;
        const built = this.issueGateway.buildDraft({ finding });
        if (!built.ok) return this.#failWithBlock(pipeline, session, run, built.error, rest(T.drafts));
        this.#appendJsonl(this.draftsPath, { draft_id: built.draft.draft_id, finding_id: findingId, draft: built.draft, built_at: this.clock() });
        const dEvent = this.events.emit("issueDrafted", {
          object_id: built.draft.draft_id,
          object_type: "issue_draft",
          payload: { finding_id: findingId, summary: `confirmed failure on ${finding.fingerprint.normalized_method_path}` },
        });
        if (!dEvent.ok) return dEvent;
      }
      const step = this.#completeStep(pipeline, session, run, T.drafts, JSON.stringify(this.#drafts().map((d) => d.draft_id)), []);
      if (!step.ok) return step;
    } else if (!done(T.drafts) && this._retestMode) {
      const step = this.#completeStep(pipeline, session, run, T.drafts, "retest-mode:no-drafts", []);
      if (!step.ok) return step;
    }

    const toReview = await this.#transitionTo(session, "issue_review", "findings classified; awaiting publish decision");
    if (!toReview.ok) return toReview;
    session = toReview.session;
    pipeline.active_run_id = null;
    this.#savePipeline(pipeline);
    return { ok: true, run, session, drafts: this.#drafts().map((d) => d.draft_id) };
  }

  #casesMap(scenarioId) {
    const scenario = this.library.getScenario(scenarioId);
    const map = new Map();
    if (!scenario) return map;
    for (const caseId of scenario.case_ids) {
      const oneCase = this.library.getCase(caseId);
      if (oneCase) map.set(caseId, oneCase);
    }
    return map;
  }

  #caseSummary(caseResults) {
    const summary = { total: caseResults.length, passed: 0, failed: 0, error: 0, skipped: 0 };
    for (const r of caseResults) summary[r.status] += 1;
    return summary;
  }

  #outcomeOf(result) {
    if (result.cancelled) return "cancelled";
    if (result.timed_out) return "timed_out";
    if (result.failures > 0) return "failed";
    return "completed";
  }

  #findingById(findingId) {
    const snap = this.findings.latest.get(findingId);
    if (!snap) return null;
    const { environmental_signals_snapshot, spec_ambiguity_snapshot, ...finding } = snap;
    return finding;
  }

  /** Quartet grouping (api|method_path|assertion_class|scenario_state) with
   *  real observation objects hydrated through the WP-06 public open API. */
  #groupFindingCandidates(run) {
    const opened = this.evidence.open(run.run_id);
    const allObservations = opened.ok ? opened.bundle.readObservations() : [];
    const observationQueue = [...(run.observations ?? [])];
    const groups = new Map();
    for (const ev of run.case_events ?? []) {
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
      const obsId = observationQueue.shift();
      const full = allObservations.find((o) => o.observation_id === obsId);
      if (full) s.observations.push(full);
    }
    const out = [];
    for (const g of groups.values()) {
      for (const s of g.bySignature.values()) {
        out.push({ parts: s.parts, attempts: g.attempts, failures: s.failures, observations: s.observations });
      }
    }
    return out;
  }

  /* ================================================================ */
  /* publishIssue (C13 orchestration)                                  */
  /* ================================================================ */

  async publishIssue({ draft_id }) {
    let session = this.#sessionOfDraft(draft_id);
    if (!session) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `draft ${draft_id} not found in any session of this orchestrator`, { reason: "draft_not_found" }) };
    }
    if (session.state === "blocked") {
      const unblocked = this.sessions.transition(session, "running", "resume from blocked");
      if (!unblocked.ok) return unblocked;
      session = unblocked.session;
    }
    if (session.state !== "issue_review") {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, `publishIssue requires session state issue_review (current: ${session.state})`, { reason: "wrong_session_state", current_state: session.state }),
      };
    }
    const draftRecord = this.findDraft(draft_id);
    const finding = this.#findingById(draftRecord.finding_id);
    if (!finding || finding.classification !== "confirmed") {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, `publishIssue requires a confirmed finding (draft ${draft_id} → ${draftRecord.finding_id}: ${finding?.classification ?? "missing"})`, { reason: "finding_not_confirmed" }),
      };
    }
    const pipeline = this.#loadPipeline(session.session_id);
    const stepToken = `issue_publish:${draft_id}`;
    if (pipeline.completed_steps.some((s) => s.token === stepToken)) {
      const existing = this.publishedDrafts().find((p) => p.draft_id === draft_id);
      if (existing) return { ok: true, replay: true, receipt: existing.receipt };
    }

    // Policy decision for the publish action (WP-04 public API).
    const publishEnv = this.environmentSet.environments.find((e) => e.environment === this.defaultEnvironment) ?? this.environmentSet.environments[0];
    const decided = this.policyGate.decide({
      decision_id: `pol-publish-${draft_id}`,
      requested_action: `issue.publish:finding=${finding.finding_id}`,
      environment: publishEnv,
      environmentSet: this.environmentSet,
      plan: { requests: 1, duration_seconds: 60, parallelism: 1 },
    });
    if (!decided.ok) return this.#failWithBlock(pipeline, session, null, decided.error, [stepToken]);
    if (decided.decision.decision !== "approved") {
      const denied = makeError(ERROR_CODES.VALIDATION_FAILED, `policy denied the publish: ${decided.decision.reason}`, { reason: "policy_denied", policy_code: decided.code ?? "POL_DENIED", decision_id: decided.decision_id });
      return this.#failWithBlock(pipeline, session, null, denied, [stepToken]);
    }

    // Rebuild the draft from the CURRENT finding state through the C13 public
    // buildDraft API (draft_id preserved): cross-run aggregation (§15) merges
    // retry/retest observations and reproduction attempts into the SAME
    // finding AFTER the draft record was first persisted, and C13's
    // evidence-completeness + minimal-reproduction gates demand the draft
    // cover the finding's FULL aggregated evidence. The rebuild is a pure
    // function of (finding, evidence index), so a resumed publish presents
    // the byte-identical draft fingerprint and replays through C13
    // idempotency (§7.3 恢复不重复发布).
    const rebuilt = this.issueGateway.buildDraft({ finding, overrides: { draft_id } });
    if (!rebuilt.ok) return this.#failWithBlock(pipeline, session, null, rebuilt.error, [stepToken]);

    // Deterministic idempotency key `<draft_id>:publish` (C13 §5.3) — the
    // second recovery line after this orchestrator's own bookkeeping.
    const idempotencyKey = `${draft_id}:publish`;
    // Pre-publish checkpoint: if the process dies between the GitHub write
    // and our bookkeeping, resumeSession finds `issue_publish:<draft_id>` as
    // a pending task and replays through C13 idempotency (§7.3 恢复不重复发布).
    this.#checkpoint(pipeline, session, { pending: [stepToken] });
    const published = this.issueGateway.publish({
      draft: rebuilt.draft,
      finding,
      idempotency_key: idempotencyKey,
      policy_decision: decided.decision,
      approvals: this.approvals.filter((a) => a.scope === `issue.publish:finding=${finding.finding_id}`),
    });
    if (!published.ok) {
      // C13 verdict passed through UNCHANGED (gates/policy/idempotency own it).
      return this.#failWithBlock(pipeline, session, null, published.error, [stepToken]);
    }
    // --- injected crash point: GitHub write happened, bookkeeping not yet ---
    if (this.interruptAfter === `issue_publish_write:${draft_id}`) {
      this.interruptAfter = null;
      throw new OrchestrationInterrupted(`issue_publish_write:${draft_id}`);
    }
    // Recovery guard: a resumed publish replays through C13 idempotency and
    // must not append a second bookkeeping record for the same draft.
    if (!this.publishedDrafts().some((p) => p.draft_id === draft_id)) this.#appendJsonl(this.publishedPath, {
      draft_id,
      finding_id: finding.finding_id,
      receipt: published.receipt,
      issue_ref: published.receipt.issue_ref,
      idempotency_key: idempotencyKey,
      published_at: this.clock(),
      replay: published.replay === true,
    });
    const pEvent = this.events.emit("issuePublished", {
      object_id: published.receipt.receipt_id,
      object_type: "publish_receipt",
      payload: { draft_id, issue_ref: published.receipt.issue_ref, gates_passed: true },
    });
    if (!pEvent.ok) return pEvent;
    const audited = this.#auditStep(session.session_id, stepToken, "publish_receipt", published.receipt.receipt_id);
    if (!audited.ok) return audited;
    pipeline.completed_steps.push({ token: stepToken, output_checksum: `sha256:${sha256hex(JSON.stringify(published.receipt))}`, at: this.clock() });
    this.#savePipeline(pipeline);
    this.#checkpoint(pipeline, session, { pending: [] });
    const toPublished = await this.#transitionTo(session, "published", `issue ${published.receipt.issue_ref} published`);
    if (!toPublished.ok) return toPublished;
    return { ok: true, receipt: published.receipt, replay: published.replay === true, session: toPublished.session };
  }

  #sessionOfDraft(draftId) {
    const record = this.findDraft(draftId);
    if (!record) return null;
    for (const session of this.sessions.list()) {
      const pipeline = this.#loadPipeline(session.session_id);
      if (pipeline.runs.some((r) => (r.finding_ids ?? []).includes(record.finding_id))) return session;
    }
    return null;
  }

  /* ================================================================ */
  /* retestIssue (§5.5)                                                */
  /* ================================================================ */

  async retestIssue({ issue_ref, session_id }) {
    let session = session_id ? this.sessions.load(session_id) : this.#sessionOfIssueRef(issue_ref);
    if (!session) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `no session found for retest of ${issue_ref}`, { reason: "session_not_found" }) };
    }
    if (!["published", "inconclusive"].includes(session.state)) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, `retestIssue requires session state published/inconclusive (current: ${session.state})`, { reason: "wrong_session_state", current_state: session.state }),
      };
    }
    const toRetest = await this.#transitionTo(session, "retest_pending", `retest scheduled for ${issue_ref}`);
    if (!toRetest.ok) return toRetest;
    session = toRetest.session;
    const pipeline = this.#loadPipeline(session.session_id);
    const publishedRecord = this.publishedDrafts().find((p) => p.issue_ref === issue_ref);
    const finding = publishedRecord ? this.#findingById(publishedRecord.finding_id) : null;
    if (!finding) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `no published finding maps to issue ${issue_ref}`, { reason: "issue_not_linked" }) };
    }
    const scenarioId = pipeline.runs.find((r) => (r.finding_ids ?? []).includes(finding.finding_id))?.scenario_id;
    // Retest execution: real chain, but session states stay in retest_pending
    // (§7.2 has no retest_pending → running transition; the retest is a
    // run-level activity, not a second session lifecycle).
    this._retestMode = true;
    let retestRun;
    try {
      retestRun = await this.startRun({ session_id: session.session_id, environment: this.defaultEnvironment, scenario_id: scenarioId });
    } finally {
      this._retestMode = false;
    }
    if (!retestRun.ok) return retestRun;
    const attached = this.issueGateway.attachRetest({
      finding: this.#findingById(finding.finding_id),
      issue_ref,
      new_evidence: [
        {
          run_id: retestRun.run.run_id,
          evidence_refs: retestRun.run.observations ?? [],
          summary: `retest run ${retestRun.run.run_id} outcome=${retestRun.run.outcome}`,
        },
      ],
      conclusion: `retest executed via orchestrated run ${retestRun.run.run_id}: ${retestRun.run.case_summary.failed} failed of ${retestRun.run.case_summary.total} case events`,
      idempotency_key: `${finding.finding_id}:retest:${retestRun.run.run_id}`,
    });
    if (!attached.ok) {
      return this.#failWithBlock(pipeline, session, retestRun.run, attached.error, [`retest:${issue_ref}`]);
    }
    this.#auditStep(session.session_id, `retest:${issue_ref}`, "github_issue", issue_ref);
    return { ok: true, run: retestRun.run, comment: attached.comment, issue_ref, session };
  }

  #sessionOfIssueRef(issueRef) {
    const record = this.publishedDrafts().find((p) => p.issue_ref === issueRef);
    if (!record) return null;
    return this.#sessionOfDraft(record.draft_id);
  }

  /* ================================================================ */
  /* cancelRun / retryRun / resumeSession (§7.3)                       */
  /* ================================================================ */

  cancelRun({ run_id, reason }) {
    const token = this.cancelTokens.get(run_id);
    if (!token) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `run ${run_id} has no active execution to cancel`, { reason: "run_not_active" }) };
    }
    // §22.5.4 order through the WP-05 public token: stop NEW steps, then
    // terminate in-flight workers, then (executor-side) bounded cleanup.
    if (typeof token.cancel === "function") token.cancel();
    else token.cancelled = true;
    const audited = this.audit.record({
      actor: "C03-orchestrator",
      action: "run.cancel",
      target: { object_type: "run", object_id: run_id },
      timestamp: this.clock(),
      idempotency_key: `${run_id}:cancel`,
    });
    if (!audited.ok) return audited;
    return { ok: true, cancelled: true, run_id, code: ERROR_CODES.COMMAND_CANCELLED, reason: reason ?? "cancelled by command" };
  }

  async retryRun({ run_id }) {
    const pipelineOf = this.#pipelineOfRun(run_id);
    if (!pipelineOf) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `run ${run_id} not found in any session`, { reason: "run_not_found" }) };
    }
    const { pipeline, run } = pipelineOf;
    const session = this.sessions.load(pipeline.session_id);
    if (session.state === "blocked") {
      const unblocked = this.sessions.transition(session, "running", `retry of ${run_id}`);
      if (!unblocked.ok) return unblocked;
    }
    // Idempotent reclaim of the failed run's leftovers through the WP-05
    // fixture ledger public behaviour (orphans → idempotent DELETE 204/404).
    const reclaim = await this.#reclaimFixtures(run);
    // A fresh run object referencing the original (run objects are immutable;
    // retry = new object + supersedes reference).
    pipeline.runs = pipeline.runs.map((r) => (r.run_id === run.run_id ? { ...r, status: r.outcome ?? r.status } : r));
    const fresh = {
      run_id: this.ids.runId(),
      execution_id: null,
      supersedes_run_id: run.run_id,
      scenario_id: run.scenario_id,
      api_id: run.api_id,
      environment: run.environment,
      seed: run.seed,
      repetitions: run.repetitions,
      executor: "curl",
      status: "interrupted",
      started_at: this.clock(),
      finished_at: null,
      case_summary: null,
      outcome: null,
    };
    pipeline.runs.push(fresh);
    pipeline.active_run_id = fresh.run_id;
    this.#savePipeline(pipeline);
    const started = await this.startRun({ session_id: pipeline.session_id, environment: run.environment, scenario_id: run.scenario_id });
    if (!started.ok) return started;
    return { ok: true, retried_from: run.run_id, reclaim, run: started.run, session: started.session };
  }

  async #reclaimFixtures(priorRun) {
    if (!priorRun.execution_id || !this.executor.stateDir) return { status: "skipped", detail: "no prior execution ledger", attempts: 0 };
    const coordinator = new FixtureCoordinator({
      executionId: priorRun.execution_id,
      ledgerDir: join(this.executor.stateDir, "fixtures"),
      baseUrl: this.baseUrl,
      clock: () => Date.parse(this.clock()),
    });
    const orphans = coordinator.orphanResources();
    if (orphans.length === 0) return { status: "clean", detail: "prior ledger has no orphan resources (setup already cleaned or never left orphans)", attempts: 0 };
    const cleanup = await coordinator.cleanup({ timeout_ms: this.cleanupTimeoutMs ?? 5000 });
    return { status: cleanup.status, detail: `reclaimed ${orphans.length} orphan resource(s) via idempotent DELETE`, attempts: cleanup.attempts, residual: cleanup.residual_resources };
  }

  #pipelineOfRun(runId) {
    for (const session of this.sessions.list()) {
      const pipeline = this.#loadPipeline(session.session_id);
      const run = pipeline.runs.find((r) => r.run_id === runId);
      if (run) return { pipeline, run };
    }
    return null;
  }

  /**
   * resumeSession (§7.3): latest valid checkpoint → rebuild progress →
   * continue pending tasks WITHOUT redoing completed steps. A publish that
   * already reached GitHub replays through C13 idempotency (zero new writes).
   */
  async resumeSession({ session_id, from_checkpoint_sequence }) {
    const session = this.sessions.load(session_id);
    if (!session) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `session ${session_id} not found`, { reason: "session_not_found" }) };
    }
    const resumed = this.checkpoints.resume({ session_id, from_checkpoint_sequence });
    if (!resumed.ok) return { ok: false, error: resumed.error, diagnostics: resumed.diagnostics };
    const pipeline = this.#loadPipeline(session_id);
    // Trust the checkpoint's completed set (crash may have lost the tail).
    pipeline.completed_steps = (pipeline.completed_steps ?? []).filter((s) => resumed.checkpoint.completed_steps.some((c) => c.step === s.token));
    this.#savePipeline(pipeline);
    let current = session;
    if (current.state === "blocked") {
      const unblocked = this.sessions.transition(current, "running", "resumeSession unblocked the session");
      if (!unblocked.ok) return unblocked;
      current = unblocked.session;
    }
    const taskTokens = resumed.checkpoint.pending_tasks.map((t) => t.task);
    const runPending = taskTokens.filter((t) => t !== "startRun" && !t.startsWith("issue_publish:"));
    if (runPending.length > 0) {
      const activeRun = [...pipeline.runs].reverse().find(Boolean);
      const continued = await this.startRun({ session_id, environment: activeRun.environment, scenario_id: activeRun.scenario_id });
      if (!continued.ok) return { ok: false, error: continued.error, recovered_from_sequence: resumed.sequence };
      return { ok: true, recovered_from_sequence: resumed.sequence, run: continued.run, session: continued.session, resumed_tasks: runPending };
    }
    const publishPending = taskTokens.find((t) => t.startsWith("issue_publish:"));
    if (publishPending) {
      const draftId = publishPending.split(":")[1];
      const republished = await this.publishIssue({ draft_id: draftId });
      if (!republished.ok) return { ok: false, error: republished.error, recovered_from_sequence: resumed.sequence };
      return { ok: true, recovered_from_sequence: resumed.sequence, resumed_task: publishPending, replay: republished.replay === true, receipt: republished.receipt };
    }
    return { ok: true, recovered_from_sequence: resumed.sequence, session: current, resumed_tasks: [] };
  }

  /* ================================================================ */
  /* Host adapter surface (C02; not among the seven commands)           */
  /* ================================================================ */

  /**
   * Fixture surface (A6 编排层防线): materialize a PRESET published state
   * for a draft (published-drafts bookkeeping + completed_steps entry),
   * exactly as if this orchestrator had published it in a previous life.
   * A later publishIssue for that draft hits the orchestration-layer state
   * line and replays the recorded receipt with ZERO C13 writes.
   */
  recordPresetPublish(draftId, receipt) {
    const draftRecord = this.findDraft(draftId);
    if (!draftRecord) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `draft ${draftId} not found for the preset publish materialization`, { reason: "draft_not_found" }) };
    }
    const session = this.#sessionOfDraft(draftId);
    if (!session) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `no session owns draft ${draftId}`, { reason: "session_not_found" }) };
    }
    const pipeline = this.#loadPipeline(session.session_id);
    const token = `issue_publish:${draftId}`;
    if (!pipeline.completed_steps.some((s) => s.token === token)) {
      pipeline.completed_steps.push({ token, output_checksum: `sha256:${sha256hex(JSON.stringify(receipt))}`, at: this.clock() });
      this.#savePipeline(pipeline);
    }
    if (!this.publishedDrafts().some((p) => p.draft_id === draftId)) {
      this.#appendJsonl(this.publishedPath, {
        draft_id: draftId,
        finding_id: draftRecord.finding_id,
        receipt,
        issue_ref: receipt.issue_ref,
        idempotency_key: `${draftId}:publish`,
        published_at: receipt.published_at ?? this.clock(),
        replay: true,
        preset: true,
      });
    }
    return { ok: true, draft_id: draftId, issue_ref: receipt.issue_ref };
  }

  registerApproval(record) {
    this.approvals.push(record);
    return { ok: true, registered: record.scope };
  }

  /** Host-driven inconclusive closure (§7.2 issue_review → inconclusive). */
  async markInconclusive(session_id, rationale) {
    const session = this.sessions.load(session_id);
    if (!session) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `session ${session_id} not found`, { reason: "session_not_found" }) };
    }
    return this.sessions.transition(session, "inconclusive", rationale ?? "no confirmed finding; closed as inconclusive");
  }
}
