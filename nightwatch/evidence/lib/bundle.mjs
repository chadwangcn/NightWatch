/**
 * NightWatch WP-06 — Evidence Bundle & Immutable Run Store (C11, §13.2/§13.3/§14/§22.5.4)
 *
 * Layout per run (WorkRequest §5.1, architecture §14):
 *
 *   <storeRoot>/runs/<run_id>/
 *     manifest.json            run object (WP-00 run/v1.json), written at Seal
 *     execution-request.json   what was asked of the executor
 *     environment-snapshot.json  sanitized environment snapshot
 *     timeline.jsonl           ordered timeline (run_started → case_result* → run_finished)
 *     cases.jsonl              per-case execution outcomes (assertion facts)
 *     observations.jsonl       WP-00 observation/v1.json objects (failures only)
 *     requests/  responses/  logs/  metrics/  artifacts/   (redacted payloads)
 *     cleanup.json             cleanup outcome recorded BEFORE seal (§22.5.4)
 *     redaction-report.json    positions + counts, never original values
 *     checksums.sha256         per-file sha256, written last (existence ⇒ sealed)
 *
 * Seal semantics (§22.5.4 / §5.3):
 *   - allowed only when the run reached a TERMINAL outcome AND cleanup state is
 *     recorded; otherwise rejected (EVD_MANIFEST_INVALID);
 *   - a full-bundle secret scan runs first: any hit blocks the seal
 *     (EVD_SECRET_DETECTED, location reported, value never included);
 *   - after seal, every write/append is rejected (EVD_MANIFEST_INVALID with
 *     reason "sealed_bundle_immutable" — DEVIATION: no dedicated sealed-state
 *     code is registered in errors.json, see DeliveryNotice §4);
 *   - sealed bundles verify file-by-file against checksums.sha256 plus a
 *     bundle-level payload digest recorded in manifest.artifacts.
 *
 * Redaction always runs BEFORE any byte is written to the store (§13.3-5).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeError, ERROR_CODES } from "./errors.mjs";
import {
  DEFAULT_REDACTION_PROFILE,
  REDACTION_POLICY_VERSION,
  redactDeep,
  redactUrl,
  buildRedactionReport,
} from "./redaction.mjs";
import { scanSecrets } from "./secret-scan.mjs";
import { validateRun, validateObservation } from "./schemas.mjs";

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

export const BUNDLE_TOP_FILES = [
  "manifest.json",
  "execution-request.json",
  "environment-snapshot.json",
  "timeline.jsonl",
  "cases.jsonl",
  "observations.jsonl",
  "cleanup.json",
  "redaction-report.json",
  "checksums.sha256",
];
export const BUNDLE_DIRS = ["requests", "responses", "logs", "metrics", "artifacts"];
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "timed_out"];
export const CLEANUP_STATUSES = ["completed", "failed", "timed_out", "skipped"];
export const CASE_RESULTS = ["passed", "failed", "error", "skipped"];
export const PAYLOAD_DIGEST_VIRTUAL_PATH = ".bundle/payload-digest";

const pad4 = (n) => String(n).padStart(4, "0");
const prettyJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Deterministic timestamp source injected by callers (verify uses a fixed clock). */
const defaultClock = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
};

export class RunBundle {
  /**
   * @param {string} dir bundle directory (<storeRoot>/runs/<run_id>)
   * @param {object} runContext fixture-shaped run context (ids/pin/env/executor/times)
   * @param {object} [options] {clock}
   */
  constructor(dir, runContext, { clock = defaultClock } = {}) {
    this.dir = dir;
    this.ctx = runContext;
    this.clock = clock;
    this.sealed = existsSync(join(dir, "checksums.sha256"));
    this.timelineSeq = 0;
    this.caseSeq = 0;
    this.redactionEntries = [];
    this.caseCounts = { total: 0, passed: 0, failed: 0, error: 0, skipped: 0 };
    this.observationIds = [];
    this.artifactLedger = [];
    this.cleanupRecorded = existsSync(join(dir, "cleanup.json"));
    this.cleanupStatus = this.cleanupRecorded ? JSON.parse(readFileSync(join(dir, "cleanup.json"), "utf8")).status : undefined;
  }

  get runId() {
    return this.ctx.run_id;
  }

  #writableGuard(action) {
    if (this.sealed) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.MANIFEST_INVALID, `bundle ${this.ctx.run_id} is sealed; ${action} is forbidden (sealed bundles are immutable)`, {
          reason: "sealed_bundle_immutable",
          run_id: this.ctx.run_id,
          action,
        }),
      };
    }
    return { ok: true };
  }

  #recordRedactions(file, entries) {
    for (const e of entries) this.redactionEntries.push({ file, ...e });
  }

  /**
   * Ingest one synthetic execution event (per-case result with request/response
   * summaries and artifact references). Redaction runs BEFORE any write.
   */
  ingestCaseEvent(event) {
    const guard = this.#writableGuard("ingest execution event");
    if (!guard.ok) return guard;
    if (event === null || typeof event !== "object" || typeof event.case_id !== "string" || !CASE_RESULTS.includes(event.result)) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, "execution event must be an object with case_id and a legal per-case result", {
          reason: "invalid_execution_event",
        }),
      };
    }
    const seq = (this.timelineSeq += 1);
    const caseSeq = (this.caseSeq += 1);
    const refs = [];
    const attempts = Number.isInteger(event.attempts) && event.attempts >= 1 ? event.attempts : 1;
    const failures = event.result === "failed" || event.result === "error" ? attempts : 0;

    const writeSidecar = (subdir, prefix, value) => {
      if (value === undefined) return undefined;
      const report = [];
      const redacted = redactDeep(value, DEFAULT_REDACTION_PROFILE, report);
      const rel = `${subdir}/${prefix}-${pad4(caseSeq)}.json`;
      writeFileSync(join(this.dir, rel), prettyJson(redacted), "utf8");
      this.#recordRedactions(rel, report);
      refs.push(rel);
      return redacted;
    };

    writeSidecar("requests", "req", event.request);
    writeSidecar("responses", "resp", event.response);
    if (Array.isArray(event.logs) && event.logs.length > 0) writeSidecar("logs", "log", { lines: event.logs });
    if (event.metrics !== undefined) writeSidecar("metrics", "metric", event.metrics);

    if (Array.isArray(event.artifacts)) {
      for (const artifact of event.artifacts) {
        if (!/^[A-Za-z0-9._-]+$/.test(artifact.name || "")) {
          return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "artifact name must match [A-Za-z0-9._-]+", { reason: "invalid_artifact_name" }) };
        }
        const report = [];
        const redacted = redactDeep(artifact.content, DEFAULT_REDACTION_PROFILE, report);
        const rel = `artifacts/${artifact.name}`;
        const body = typeof redacted === "string" ? `${redacted}\n` : prettyJson(redacted);
        writeFileSync(join(this.dir, rel), body, "utf8");
        this.#recordRedactions(rel, report);
        this.artifactLedger.push({ name: artifact.name, checksum: sha256hex(body) });
        refs.push(rel);
      }
    }

    appendFileSync(
      join(this.dir, "timeline.jsonl"),
      `${JSON.stringify({
        seq,
        timestamp: this.clock(),
        type: "case_result",
        case_id: event.case_id,
        execution_id: event.execution_id ?? this.ctx.execution_id,
        result: event.result,
        api_id: event.api_id,
        method: event.method,
        path: event.path,
        status_or_error: event.status_or_error,
        refs,
      })}\n`,
      "utf8"
    );
    appendFileSync(
      join(this.dir, "cases.jsonl"),
      `${JSON.stringify({
        case_id: event.case_id,
        execution_id: event.execution_id ?? this.ctx.execution_id,
        result: event.result,
        attempts,
        failures,
        api_id: event.api_id,
        method: event.method,
        path: event.path,
        assertion_class: event.assertion_class,
        status_or_error: event.status_or_error,
        response_signature: event.response_signature,
        scenario_state: event.scenario_state,
        ...(Array.isArray(event.environmental_signals) ? { environmental_signals: event.environmental_signals } : {}),
        ...(event.spec_ambiguity ? { spec_ambiguity: event.spec_ambiguity } : {}),
      })}\n`,
      "utf8"
    );
    this.caseCounts.total += 1;
    this.caseCounts[event.result] += 1;
    return { ok: true, seq, refs };
  }

  /**
   * Record one Observation (WP-00 observation/v1.json). Schema-validated
   * before write; observations only ever describe EXTERNAL symptoms — root
   * cause guesses never enter this record (§14.1).
   */
  recordObservation(observation) {
    const guard = this.#writableGuard("record observation");
    if (!guard.ok) return guard;
    const schemaCheck = validateObservation(observation);
    if (!schemaCheck.ok) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, "observation failed WP-00 schema validation", {
          reason: "observation_schema",
          errors: schemaCheck.errors,
        }),
      };
    }
    appendFileSync(join(this.dir, "observations.jsonl"), `${JSON.stringify(observation)}\n`, "utf8");
    this.observationIds.push(observation.observation_id);
    return { ok: true };
  }

  /** Record the cleanup outcome — MUST precede seal (§22.5.4). */
  recordCleanup({ status, details }) {
    const guard = this.#writableGuard("record cleanup");
    if (!guard.ok) return guard;
    if (!CLEANUP_STATUSES.includes(status)) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "cleanup status must be a legal cleanup_status value", { reason: "invalid_cleanup_status" }) };
    }
    const record = { status, details: details ?? "", recorded_at: this.clock() };
    writeFileSync(join(this.dir, "cleanup.json"), prettyJson(record), "utf8");
    this.cleanupRecorded = true;
    this.cleanupStatus = status;
    return { ok: true, record };
  }

  /**
   * Seal the bundle: preconditions → secret scan → manifest + checksums.
   * After a successful seal the bundle is immutable (all writes rejected).
   */
  seal({ auditSink = null } = {}) {
    const guard = this.#writableGuard("seal");
    if (!guard.ok) return guard;
    if (!TERMINAL_RUN_STATUSES.includes(this.ctx.status)) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.MANIFEST_INVALID, "run has not reached a terminal outcome; seal is forbidden until then", {
          reason: "run_not_terminal",
          status: this.ctx.status,
        }),
      };
    }
    if (!this.cleanupRecorded) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.MANIFEST_INVALID, "cleanup state must be recorded before seal", {
          reason: "cleanup_not_recorded",
        }),
      };
    }

    // Placeholder notes for empty standard directories (§5.1 allows this).
    for (const dir of BUNDLE_DIRS) {
      const full = join(this.dir, dir);
      mkdirSync(full, { recursive: true });
      if (readdirSync(full).length === 0) {
        writeFileSync(join(full, ".placeholder"), "placeholder: this bundle directory is intentionally empty (WorkRequest §5.1)\n", "utf8");
      }
    }

    // Redaction report (positions + counts only).
    writeFileSync(join(this.dir, "redaction-report.json"), prettyJson(buildRedactionReport(this.redactionEntries)), "utf8");

    // Final timeline entry is written BEFORE hashing (timeline is a payload file).
    this.timelineSeq += 1;
    appendFileSync(
      join(this.dir, "timeline.jsonl"),
      `${JSON.stringify({ seq: this.timelineSeq, timestamp: this.clock(), type: "run_finished", result: this.ctx.status })}\n`,
      "utf8"
    );

    // Full-bundle secret scan (after every payload write, before manifest):
    // any hit BLOCKS the seal (value never reported).
    const { hits, scanned_files } = scanSecrets(this.dir);
    if (hits.length > 0) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.SECRET_DETECTED, `secret scan blocked seal: ${hits.length} hit(s) across ${scanned_files} files`, {
          reason: "secret_scan_hit",
          hits, // location + pattern label only, no matched values
        }),
      };
    }

    // Payload = everything except manifest.json and checksums.sha256.
    const payloadFiles = walkFiles(this.dir).filter((p) => {
      const rel = p.slice(this.dir.length + 1);
      return rel !== "manifest.json" && rel !== "checksums.sha256";
    });
    const payloadEntries = payloadFiles
      .map((p) => ({ path: p.slice(this.dir.length + 1), checksum: sha256hex(readFileSync(p)) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const digestMaterial = payloadEntries.map((e) => `${e.checksum}  ${e.path}\n`).join("");
    const payloadDigest = sha256hex(digestMaterial);

    const sanitizedBaseUrl = this.#sanitizedBaseUrl();
    const manifest = {
      run_id: this.ctx.run_id,
      workspace_id: this.ctx.workspace_id,
      session_id: this.ctx.session_id,
      ...(this.ctx.plan_id ? { plan_id: this.ctx.plan_id } : {}),
      ...(this.ctx.scenario_id ? { scenario_id: this.ctx.scenario_id } : {}),
      status: this.ctx.status,
      contract_pin: this.ctx.contract_pin,
      ...(this.ctx.scenario_revision ? { scenario_revision: this.ctx.scenario_revision } : {}),
      ...(Array.isArray(this.ctx.assumptions) ? { assumptions: this.ctx.assumptions } : {}),
      environment_name: this.ctx.environment_name,
      sanitized_base_url: sanitizedBaseUrl,
      ...(this.ctx.deployment_ref ? { deployment_ref: this.ctx.deployment_ref } : {}),
      executor: this.ctx.executor,
      executor_version: this.ctx.executor_version,
      ...(this.ctx.agent_host_type ? { agent_host_type: this.ctx.agent_host_type } : {}),
      started_at: this.ctx.started_at,
      finished_at: this.ctx.finished_at,
      duration_ms: this.ctx.duration_ms,
      case_summary: { ...this.caseCounts },
      artifacts: [...payloadEntries, { path: PAYLOAD_DIGEST_VIRTUAL_PATH, checksum: payloadDigest }],
      redaction_policy_version: REDACTION_POLICY_VERSION,
      cleanup_status: this.cleanupStatus,
    };
    const manifestCheck = validateRun(manifest);
    if (!manifestCheck.ok) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.MANIFEST_INVALID, "sealed manifest failed WP-00 run schema validation", {
          reason: "manifest_schema",
          errors: manifestCheck.errors,
        }),
      };
    }
    writeFileSync(join(this.dir, "manifest.json"), prettyJson(manifest), "utf8");

    const checksumLines = walkFiles(this.dir)
      .filter((p) => p.slice(this.dir.length + 1) !== "checksums.sha256")
      .sort((a, b) => a.slice(this.dir.length + 1).localeCompare(b.slice(this.dir.length + 1)))
      .map((p) => `${sha256hex(readFileSync(p))}  ${p.slice(this.dir.length + 1)}`)
      .join("\n");
    writeFileSync(join(this.dir, "checksums.sha256"), `${checksumLines}\n`, "utf8");
    this.sealed = true;

    if (auditSink) {
      auditSink.record({
        actor: "C11-evidence-pipeline",
        action: "evidence.seal",
        objectType: "run",
        objectId: this.ctx.run_id,
        timestamp: this.clock(),
        idempotencyKey: `${this.ctx.run_id}:seal`,
      });
    }
    return { ok: true, manifest, payload_digest: payloadDigest, checksums_path: "checksums.sha256" };
  }

  /** Sanitized base URL: redact credentials, then strip to scheme://host (schema-safe). */
  #sanitizedBaseUrl() {
    const report = [];
    const redacted = redactUrl(this.ctx.base_url, DEFAULT_REDACTION_PROFILE, report, "$.sanitized_base_url");
    this.#recordRedactions("manifest.json", report);
    const origin = redacted.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i);
    return origin ? origin[0] : redacted;
  }

  /**
   * Verify a sealed bundle: per-file checksums + payload digest + manifest
   * schema. Detects ANY post-seal mutation (§5.3).
   */
  verifySealed() {
    const checksumsPath = join(this.dir, "checksums.sha256");
    if (!existsSync(checksumsPath)) {
      return { ok: false, reason: "not_sealed" };
    }
    const mismatches = [];
    const seen = new Set();
    for (const line of readFileSync(checksumsPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const [hash, rel] = line.split(/\s{2}/);
      seen.add(rel);
      const p = join(this.dir, rel);
      if (!existsSync(p)) {
        mismatches.push({ file: rel, problem: "missing" });
        continue;
      }
      if (sha256hex(readFileSync(p)) !== hash) mismatches.push({ file: rel, problem: "checksum_mismatch" });
    }
    // Files present but NOT covered by checksums (untracked additions).
    for (const p of walkFiles(this.dir)) {
      const rel = p.slice(this.dir.length + 1);
      if (rel !== "checksums.sha256" && !seen.has(rel)) mismatches.push({ file: rel, problem: "untracked_file" });
    }
    const manifest = JSON.parse(readFileSync(join(this.dir, "manifest.json"), "utf8"));
    const schemaCheck = validateRun(manifest);
    if (!schemaCheck.ok) mismatches.push({ file: "manifest.json", problem: "schema_invalid", errors: schemaCheck.errors });
    const digestEntry = manifest.artifacts.find((a) => a.path === PAYLOAD_DIGEST_VIRTUAL_PATH);
    // Bundle-level digest is recomputed from the CURRENT on-disk payload so
    // that ANY post-seal mutation (edit or addition) also breaks it, on top
    // of the per-file checksum checks above.
    const currentPayload = walkFiles(this.dir)
      .filter((p) => {
        const rel = p.slice(this.dir.length + 1);
        return rel !== "manifest.json" && rel !== "checksums.sha256";
      })
      .map((p) => ({ path: p.slice(this.dir.length + 1), checksum: sha256hex(readFileSync(p)) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const material = currentPayload.map((e) => `${e.checksum}  ${e.path}\n`).join("");
    const payloadDigestOk = digestEntry !== undefined && sha256hex(material) === digestEntry.checksum;
    if (!payloadDigestOk) mismatches.push({ file: "manifest.json", problem: "payload_digest_mismatch" });
    return { ok: mismatches.length === 0, mismatches, payload_digest_ok: payloadDigestOk, manifest };
  }

  /** Parsed payload readers (for the Evidence Index / downstream consumers). */
  readTimeline() {
    return readFileSync(join(this.dir, "timeline.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }
  readCases() {
    return readFileSync(join(this.dir, "cases.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }
  readObservations() {
    return readFileSync(join(this.dir, "observations.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }
}

/**
 * Downstream consumption guard (C12/C13 must only reference SEALED evidence,
 * §5.11-6): returns EVD_NOT_SEALED when the bundle is not sealed yet.
 */
export function assertSealedForConsumption(bundle) {
  if (!bundle.sealed) {
    return {
      ok: false,
      error: makeError(ERROR_CODES.NOT_SEALED, `run ${bundle.ctx?.run_id ?? "(unknown)"} is not sealed yet; downstream consumers may only reference sealed evidence`, {
        reason: "bundle_not_sealed",
        run_id: bundle.ctx?.run_id,
      }),
    };
  }
  return { ok: true };
}

export class EvidenceStore {
  /**
   * @param {string} rootDir store root (bundles under <root>/runs/<run_id>)
   * @param {object} [options] {clock}
   */
  constructor(rootDir, { clock = defaultClock } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    mkdirSync(join(rootDir, "runs"), { recursive: true });
    mkdirSync(join(rootDir, "runs-context"), { recursive: true });
  }

  /** Create a run bundle: layout dirs + execution-request + environment snapshot (redacted first). */
  createRun(runContext) {
    const dir = join(this.rootDir, "runs", runContext.run_id);
    if (existsSync(dir)) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `run ${runContext.run_id} already exists in this store`, { reason: "duplicate_run" }) };
    }
    mkdirSync(dir, { recursive: true });
    for (const d of BUNDLE_DIRS) mkdirSync(join(dir, d), { recursive: true });
    for (const f of ["timeline.jsonl", "cases.jsonl", "observations.jsonl"]) writeFileSync(join(dir, f), "", "utf8");
    const bundle = new RunBundle(dir, runContext, { clock: this.clock });
    const redactions = [];

    // Run context sidecar (store-level, OUTSIDE the bundle so it never joins
    // the sealed layout; enables reopening unsealed bundles after a restart).
    // Redacted before write: store-wide secret hygiene covers this file too.
    const ctxReport = [];
    const sanitizedCtx = redactDeep(runContext, DEFAULT_REDACTION_PROFILE, ctxReport);
    writeFileSync(join(this.rootDir, "runs-context", `${runContext.run_id}.json`), prettyJson(sanitizedCtx), "utf8");
    redactions.push(...ctxReport.map((e) => ({ file: `runs-context/${runContext.run_id}.json`, ...e })));

    const execReport = [];
    const executionRequest = redactDeep(
      {
        execution_id: runContext.execution_id,
        executor: runContext.executor,
        executor_version: runContext.executor_version,
        ...(runContext.plan_id ? { plan_id: runContext.plan_id } : {}),
        ...(runContext.scenario_id ? { scenario_id: runContext.scenario_id } : {}),
        ...(runContext.scenario_revision ? { scenario_revision: runContext.scenario_revision } : {}),
        contract_pin: runContext.contract_pin,
        ...(runContext.seed !== undefined ? { seed: runContext.seed } : {}),
        ...(runContext.command_summary ? { command_summary: runContext.command_summary } : {}),
      },
      DEFAULT_REDACTION_PROFILE,
      execReport
    );
    writeFileSync(join(dir, "execution-request.json"), prettyJson(executionRequest), "utf8");
    redactions.push(...execReport.map((e) => ({ file: "execution-request.json", ...e })));

    const envReport = [];
    const snapshot = redactDeep(
      {
        environment_name: runContext.environment_name,
        sanitized_base_url: redactUrl(runContext.base_url, DEFAULT_REDACTION_PROFILE, envReport, "$.sanitized_base_url").match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0] ?? runContext.base_url,
        ...(runContext.deployment_ref ? { deployment_ref: runContext.deployment_ref } : {}),
        captured_at: this.clock(),
        ...(runContext.environment_snapshot ? { variables: runContext.environment_snapshot } : {}),
      },
      DEFAULT_REDACTION_PROFILE,
      envReport
    );
    writeFileSync(join(dir, "environment-snapshot.json"), prettyJson(snapshot), "utf8");
    redactions.push(...envReport.map((e) => ({ file: "environment-snapshot.json", ...e })));
    bundle.redactionEntries.push(...redactions);

    appendFileSync(
      join(dir, "timeline.jsonl"),
      `${JSON.stringify({ seq: (bundle.timelineSeq += 1), timestamp: this.clock(), type: "run_started", run_id: runContext.run_id })}\n`,
      "utf8"
    );
    return { ok: true, bundle };
  }

  /** Open an existing run bundle (sealed state derived from checksums presence). */
  open(runId) {
    const dir = join(this.rootDir, "runs", runId);
    if (!existsSync(dir)) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `run ${runId} not found in this store`, { reason: "run_not_found" }) };
    }
    const manifestPath = join(dir, "manifest.json");
    const ctxSidecar = join(this.rootDir, "runs-context", `${runId}.json`);
    const ctx = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : JSON.parse(readFileSync(ctxSidecar, "utf8"));
    return { ok: true, bundle: new RunBundle(dir, ctx, { clock: this.clock }) };
  }

  /**
   * Build & persist the Evidence Index (WP-07 consumption surface):
   * one entry per run with sealed state, observation ids and bundle refs.
   */
  buildIndex() {
    const runsRoot = join(this.rootDir, "runs");
    const entries = [];
    for (const name of readdirSync(runsRoot).sort()) {
      const dir = join(runsRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      const sealed = existsSync(join(dir, "checksums.sha256"));
      const manifest = existsSync(join(dir, "manifest.json")) ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) : null;
      const observations = existsSync(join(dir, "observations.jsonl"))
        ? readFileSync(join(dir, "observations.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l).observation_id)
        : [];
      entries.push({
        run_id: name,
        sealed,
        ...(manifest ? { status: manifest.status, case_summary: manifest.case_summary } : {}),
        observations,
        bundle_dir: `runs/${name}`,
      });
    }
    const index = { store_version: "nw-evidence-index-v1", generated_at: this.clock(), runs: entries };
    writeFileSync(join(this.rootDir, "index.json"), prettyJson(index), "utf8");
    return { ok: true, index };
  }

  readIndex() {
    return JSON.parse(readFileSync(join(this.rootDir, "index.json"), "utf8"));
  }
}
