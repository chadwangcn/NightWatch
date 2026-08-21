#!/usr/bin/env node
/**
 * NightWatch WP-06 — Evidence & Finding Verifier (verify.mjs)
 *
 * Independently executable (no network, no services). Drives the full C11/C12
 * pipeline over the synthetic execution-event fixtures and checks the
 * WorkRequest §7 hard gates A1–A10:
 *
 *   A1  bundle_structure        §14 layout + manifest required fields + Evidence Index
 *   A2  ingest                  events → timeline/cases/observations + case_summary
 *   A3  redaction               credential residue = 0 in sealed store; report has
 *                               positions/counts only; sanitized base URL
 *   A4  secret_scan_blocks_seal encoded-credential run blocked (EVD_SECRET_DETECTED,
 *                               base64-decoded pass, location only — never values)
 *   A5  seal_immutability       post-seal writes rejected (EVD_*), checksum verify,
 *                               tamper detection, non-terminal run seal rejected
 *   A6  observations_schema     every failed/error case → WP-00 observation, valid
 *   A7  six_classifications     confirmed/flaky/environmental/spec-ambiguity/
 *                               inconclusive/duplicate each ≥1 correct decision path
 *   A8  fingerprint_dedup       cross-run aggregation (attempts/failures/rate update),
 *                               same-run merge input, behavior-change relation
 *   A9  schema_and_hypothesis   run/observation/finding pass WP-00; hypothesis
 *                               defaults empty, firewall holds (§14.1)
 *   A10 determinism_and_baseline  secret scan zero hits on sealed bundles; two full
 *                               pipeline passes produce byte-identical stores;
 *                               WP-00/WP-03 baseline receipts ok (fresh baseline
 *                               reruns are the Coordinator-side acceptance step —
 *                               see DeliveryNotice §3/§4)
 *
 * Determinism: fixed clock + counter-based ULIDs (lib/ids.mjs) ⇒ two runs of this
 * verifier produce byte-identical receipt `checks` (top-level finished_at excluded).
 * Runtime state lives under nightwatch/evidence/.state/verify/ (gitignored) and is
 * wiped at every start.
 *
 * Usage: node nightwatch/evidence/verify.mjs   (from the repository root)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvidenceStore,
  FindingStore,
  RunBundle,
  makeIdFactory,
  makeAuditSink,
  buildFingerprint,
  normalizePath,
  classifyFinding,
  assertClassificationLegal,
  scanSecrets,
  evaluateRetention,
  retentionPolicyRecord,
  assertSealedForConsumption,
  redactUrl,
  REDACTED,
  BUNDLE_TOP_FILES,
  BUNDLE_DIRS,
  ERROR_CODES,
  validateRun,
  validateObservation,
  validateFinding,
  validateErrorEnvelope,
} from "./lib/index.mjs";

const EVIDENCE_ROOT = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/evidence
const NW_ROOT = join(EVIDENCE_ROOT, "..");
const REPO_ROOT = join(NW_ROOT, "..");
const STATE_DIR = join(EVIDENCE_ROOT, ".state", "verify");
const RECEIPT_PATH = join(EVIDENCE_ROOT, "verify", "receipt.json");
const FIXTURES = JSON.parse(readFileSync(join(EVIDENCE_ROOT, "fixtures", "execution-events.json"), "utf8"));

/* Fixed clock: every timestamp in stores/receipts derives from this instant. */
const FIXED_MS = Date.parse("2026-08-21T10:00:00Z");
const clock = () => new Date(FIXED_MS).toISOString().replace(/\.\d+Z$/, "Z");

/* Fixture lookups by purpose. */
const byPurpose = Object.fromEntries(FIXTURES.runs.map((r) => [r.purpose, r]));
const SEC = byPurpose["secret-block-encoded-credentials"].run;

/* Edge runs for seal-precondition gates (A5), shaped like fixture specs. */
const { events: _pssEvents, cleanup: _pssCleanup, ...PSS_CTX } = byPurpose["positive-all-pass"].run;
const EDGE_RUNS = [
  {
    purpose: "edge-non-terminal-seal-rejected",
    expect_seal: "blocked",
    run: {
      ...PSS_CTX,
      run_id: "run_01J8WP06RG000000000000EDG1",
      execution_id: "exec_01J8WP06RG0000000000EXEC10",
      status: "running",
      events: [
        {
          case_id: "case_01J8WP06RG0000000000EDGA1",
          result: "passed",
          api_id: "synthetic-widget-api",
          method: "GET",
          path: "/v1/widgets",
          assertion_class: "response-schema",
          status_or_error: "200",
          response_signature: "synthetic-sig-200-list-ok",
          scenario_state: "list-first-page",
        },
      ],
      cleanup: { status: "completed", details: "edge fixture" },
    },
    expectSealReason: "run_not_terminal",
  },
  {
    purpose: "edge-cleanup-not-recorded",
    expect_seal: "blocked",
    run: {
      ...PSS_CTX,
      run_id: "run_01J8WP06RG000000000000EDG2",
      execution_id: "exec_01J8WP06RG0000000000EXEC11",
      status: "completed",
      events: [
        {
          case_id: "case_01J8WP06RG0000000000EDGB1",
          result: "passed",
          api_id: "synthetic-widget-api",
          method: "GET",
          path: "/v1/widgets",
          assertion_class: "response-schema",
          status_or_error: "200",
          response_signature: "synthetic-sig-200-list-ok",
          scenario_state: "list-first-page",
        },
      ],
      cleanup: null,
    },
    expectSealReason: "cleanup_not_recorded",
  },
];

/* Credential-shaped literals from the fixtures: none may survive anywhere in a
 * sealed store (A3); the encoded blobs may exist ONLY inside the intentionally
 * blocked SEC bundle (A4). Indices 9–11 are the SEC-specific values. */
const RESIDUE_NEEDLES = [
  "synthetic-ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "synthetic-sk-abc123def456ghi789jkl",
  "synthetic-access-token-0001",
  "synthetic-client-secret-0001",
  "synthetic-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "synthetic-bearer-token-alpha-0001",
  "synthetic-bearer-beta-0001",
  "synthetic-nw-tested-api-token-0001",
  "-----BEGIN RSA PRIVATE KEY-----",
  "synthetic-AKIAIOSFODNN7EXAMPLE",
  "c3ludGhldGljLUFLSUFJT1NGT0ROTjdFWEFNUExFWA==",
  "c3ludGhldGljLWdocF9BQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3ODk=",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
};
const relFromRepo = (p) => relative(REPO_ROOT, p);

const listTree = (dir) => walkFiles(dir).map((p) => relative(dir, p)).sort();
const diffTrees = (a, b) => {
  const diffs = [];
  const fa = listTree(a);
  const fb = listTree(b);
  const sa = new Set(fa);
  const sb = new Set(fb);
  for (const f of fa) if (!sb.has(f)) diffs.push(`only-in-first: ${f}`);
  for (const f of fb) if (!sa.has(f)) diffs.push(`only-in-second: ${f}`);
  for (const f of fa) {
    if (!sb.has(f)) continue;
    if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) diffs.push(`content-differs: ${f}`);
  }
  return diffs;
};

/* Check collectors keyed by acceptance gate. */
const R = Object.fromEntries(
  [
    "a1_bundle_structure",
    "a2_ingest",
    "a3_redaction",
    "a4_secret_scan_blocks_seal",
    "a5_seal_immutability",
    "a6_observations_schema",
    "a7_six_classifications",
    "a8_fingerprint_dedup",
    "a9_schema_and_hypothesis",
    "a10_determinism_and_baseline",
  ].map((k) => [k, { failures: [] }])
);
const fail = (block, msg) => R[block].failures.push(msg);
const expect = (block, cond, msg) => {
  if (!cond) fail(block, msg);
  return cond === true;
};

/* ------------------------------------------------------------------ */
/* Pipeline (run twice; pass 2 proves byte-identical stores)           */
/* ------------------------------------------------------------------ */
function runPipeline(tag, auditStoreDir) {
  const ids = makeIdFactory(() => FIXED_MS);
  const store = new EvidenceStore(join(STATE_DIR, `store-${tag}`), { clock });
  const baseSink = makeAuditSink({ storeDir: auditStoreDir });
  const tally = { ok_new: 0, replay: 0, fallback: 0, failed: 0 };
  const sink = {
    record(event) {
      const r = baseSink.record(event);
      if (r.ok && r.fallback) tally.fallback += 1;
      else if (r.ok && r.idempotent_replay) tally.replay += 1;
      else if (r.ok) tally.ok_new += 1;
      else tally.failed += 1;
      return r;
    },
  };
  const findings = new FindingStore(join(STATE_DIR, `findings-${tag}`), { ids, clock, auditSink: sink });

  // Retention policy recorded per store (§5.5, P0: record-only).
  writeFileSync(join(store.rootDir, "retention-policy.json"), `${JSON.stringify(retentionPolicyRecord(), null, 2)}\n`, "utf8");

  const runs = [];
  const ingestRun = (spec) => {
    const { events, cleanup, ...ctx } = spec.run;
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
    let cleanupResult = null;
    if (cleanup) {
      cleanupResult = bundle.recordCleanup(cleanup);
      if (!cleanupResult.ok) throw new Error(`recordCleanup failed for ${ctx.run_id}`);
    }
    const seal = bundle.seal();
    return { purpose: spec.purpose, spec, ctx, events, bundle, obsByCase, cleanupResult, seal };
  };

  for (const spec of FIXTURES.runs) runs.push(ingestRun(spec));
  for (const spec of EDGE_RUNS) runs.push(ingestRun(spec));

  /* Finding submissions: run order fixed; within a run, quartet groups in
   * first-appearance order of the failing signature (attempts = all cases of
   * the same api/method/assertion_class/scenario_state; failures = cases with
   * this exact six-component fingerprint — same-run duplicates merge into one
   * submission, which is the store-level same-run merge input). */
  const submissions = [];
  for (const run of runs) {
    const groups = new Map(); // quartet → { attempts, bySignature: Map }
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
      if (Array.isArray(ev.environmental_signals)) s.signals.push(...ev.environmental_signals);
      if (ev.spec_ambiguity && !s.ambiguity) s.ambiguity = ev.spec_ambiguity;
      const obs = run.obsByCase.get(ev.case_id);
      if (obs) s.observations.push(obs);
    }
    for (const g of groups.values()) {
      for (const s of g.bySignature.values()) {
        const result = findings.submit({
          parts: s.parts,
          attempts: g.attempts,
          failures: s.failures,
          observations: s.observations,
          environmental_signals: [...new Set(s.signals)],
          spec_ambiguity: s.ambiguity,
        });
        if (!result.ok) throw new Error(`finding submit failed (${run.purpose}): ${JSON.stringify(result.error)}`);
        submissions.push({ run: run.purpose, parts: s.parts, attempts: g.attempts, failures: s.failures, result });
      }
    }
  }

  store.buildIndex();
  return { store, findings, sink, tally, runs, submissions, ids };
}

/* ------------------------------------------------------------------ */
/* Execute both passes                                                 */
/* ------------------------------------------------------------------ */
rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
const AUDIT_STORE = join(STATE_DIR, "audit-store");
const pass1 = runPipeline("1", AUDIT_STORE);
const pass2 = runPipeline("2", AUDIT_STORE);

/* ================================================================== */
/* A1 — Bundle structure, manifest fields, Evidence Index              */
/* ================================================================== */
{
  const sealedRuns = pass1.runs.filter((r) => r.seal.ok);
  expect("a1_bundle_structure", sealedRuns.length === 8, `expected 8 sealed runs, got ${sealedRuns.length}`);
  for (const run of sealedRuns) {
    const dir = run.bundle.dir;
    for (const f of BUNDLE_TOP_FILES) {
      if (!existsSync(join(dir, f))) fail("a1_bundle_structure", `${run.ctx.run_id}: missing top file ${f}`);
    }
    for (const d of BUNDLE_DIRS) {
      if (!statSync(join(dir, d)).isDirectory()) fail("a1_bundle_structure", `${run.ctx.run_id}: missing directory ${d}/`);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const required = [
      "run_id", "workspace_id", "session_id", "plan_id", "scenario_id", "status", "contract_pin",
      "scenario_revision", "assumptions", "environment_name", "sanitized_base_url", "executor",
      "executor_version", "agent_host_type", "started_at", "finished_at", "duration_ms",
      "case_summary", "artifacts", "redaction_policy_version", "cleanup_status",
    ];
    for (const key of required) {
      if (!(key in manifest)) fail("a1_bundle_structure", `${run.ctx.run_id}: manifest missing ${key}`);
    }
    for (const key of ["source_revision", "checksum"]) {
      if (!(key in (manifest.contract_pin ?? {}))) fail("a1_bundle_structure", `${run.ctx.run_id}: contract_pin missing ${key}`);
    }
    for (const key of ["total", "passed", "failed", "error", "skipped"]) {
      if (!(key in (manifest.case_summary ?? {}))) fail("a1_bundle_structure", `${run.ctx.run_id}: case_summary missing ${key}`);
    }
    if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.every((a) => typeof a.path === "string" && typeof a.checksum === "string")) {
      fail("a1_bundle_structure", `${run.ctx.run_id}: artifacts must be {path, checksum}[]`);
    }
    const schemaCheck = validateRun(manifest);
    if (!schemaCheck.ok) fail("a1_bundle_structure", `${run.ctx.run_id}: manifest fails run/v1.json: ${schemaCheck.errors.join("; ")}`);
  }
  // Evidence Index (WP-07 consumption surface)
  const index = pass1.store.readIndex();
  const totalRuns = FIXTURES.runs.length + EDGE_RUNS.length;
  expect("a1_bundle_structure", index.runs.length === totalRuns, `index has ${index.runs.length} runs, expected ${totalRuns}`);
  expect("a1_bundle_structure", index.runs.filter((r) => r.sealed).length === 8, "index sealed count must be 8");
  const secEntry = index.runs.find((r) => r.run_id === SEC.run_id);
  expect("a1_bundle_structure", secEntry !== undefined && secEntry.sealed === false, "SEC run must be indexed as unsealed");
  for (const entry of index.runs) {
    if (!existsSync(join(pass1.store.rootDir, entry.bundle_dir))) fail("a1_bundle_structure", `index bundle_dir missing on disk: ${entry.bundle_dir}`);
    if (entry.sealed && (typeof entry.status !== "string" || !entry.case_summary)) fail("a1_bundle_structure", `sealed index entry incomplete: ${entry.run_id}`);
  }
  // Retention policy recorded (§5.5) + pure evaluation sanity.
  expect("a1_bundle_structure", existsSync(join(pass1.store.rootDir, "retention-policy.json")), "retention policy record missing in store root");
  const laterIso = new Date(FIXED_MS + 91 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  expect("a1_bundle_structure", evaluateRetention(clock(), clock()).action === "retain" && evaluateRetention(clock(), laterIso).action === "delete-eligible", "retention evaluation must flip at retain_days boundary");
}

/* ================================================================== */
/* A2 — Ingest: timeline / cases / observations                        */
/* ================================================================== */
{
  for (const run of pass1.runs) {
    const timeline = run.bundle.readTimeline();
    const cases = run.bundle.readCases();
    const events = run.events;
    expect("a2_ingest", timeline[0].type === "run_started", `${run.purpose}: timeline must start with run_started`);
    const caseEvents = timeline.filter((t) => t.type === "case_result");
    expect("a2_ingest", caseEvents.length === events.length, `${run.purpose}: timeline case_result count ${caseEvents.length} != ${events.length}`);
    for (let i = 0; i < events.length; i += 1) {
      if (caseEvents[i].case_id !== events[i].case_id || caseEvents[i].result !== events[i].result) {
        fail("a2_ingest", `${run.purpose}: timeline case_result ${i} mismatch`);
      }
      for (const ref of timeline[i + 1].refs ?? []) {
        if (!existsSync(join(run.bundle.dir, ref))) fail("a2_ingest", `${run.purpose}: sidecar ref missing ${ref}`);
      }
    }
    expect("a2_ingest", cases.length === events.length, `${run.purpose}: cases.jsonl count ${cases.length} != ${events.length}`);
    for (let i = 0; i < events.length; i += 1) {
      if (cases[i].case_id !== events[i].case_id || cases[i].result !== events[i].result) {
        fail("a2_ingest", `${run.purpose}: cases.jsonl ${i} mismatch`);
      }
    }
    const failingEvents = events.filter((e) => e.result === "failed" || e.result === "error").length;
    expect("a2_ingest", run.bundle.readObservations().length === failingEvents, `${run.purpose}: observations count != failed/error cases`);
    if (run.seal.ok) {
      expect("a2_ingest", timeline[timeline.length - 1].type === "run_finished", `${run.purpose}: sealed timeline must end with run_finished`);
      const manifest = JSON.parse(readFileSync(join(run.bundle.dir, "manifest.json"), "utf8"));
      const expectedCounts = { total: events.length, passed: 0, failed: 0, error: 0, skipped: 0 };
      for (const e of events) expectedCounts[e.result] += 1;
      expect("a2_ingest", JSON.stringify(manifest.case_summary) === JSON.stringify(expectedCounts), `${run.purpose}: case_summary mismatch`);
    }
  }
}

/* ================================================================== */
/* A3 — Redaction: zero residue, report shape, sanitized base URL      */
/* ================================================================== */
{
  const secRunPrefix = `runs/${SEC.run_id}/`; // blocked-by-design: excluded from residue scan
  let filesScanned = 0;
  const residue = [];
  const scanTargets = [
    ...walkFiles(pass1.store.rootDir).map((p) => ({ p, rel: relative(pass1.store.rootDir, p) })),
    ...walkFiles(join(STATE_DIR, "findings-1")).map((p) => ({ p, rel: relative(STATE_DIR, p) })),
  ];
  for (const { p, rel } of scanTargets) {
    if (rel.startsWith(secRunPrefix)) continue;
    filesScanned += 1;
    const text = readFileSync(p, "utf8");
    for (const needle of RESIDUE_NEEDLES) {
      if (text.includes(needle)) residue.push({ file: relFromRepo(p), needle: needle.slice(0, 24) });
    }
  }
  expect("a3_redaction", residue.length === 0, `credential residue in sealed store: ${JSON.stringify(residue)}`);
  expect("a3_redaction", filesScanned > 50, `residue scan covered only ${filesScanned} files`);
  // Redaction report: positions + counts only, no original values.
  const pssRun = pass1.runs.find((r) => r.purpose === "positive-all-pass");
  const reportPath = join(pssRun.bundle.dir, "redaction-report.json");
  expect("a3_redaction", existsSync(reportPath), "redaction-report.json missing");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  expect("a3_redaction", report.total_count > 0, "redaction report must record at least one redaction");
  expect("a3_redaction", Array.isArray(report.redactions) && report.redactions.length > 0, "redaction report entries missing");
  for (const e of report.redactions) {
    for (const field of ["file", "path", "rule", "count"]) {
      if (!(field in e)) fail("a3_redaction", `redaction entry missing ${field}`);
    }
  }
  const reportText = JSON.stringify(report);
  for (const needle of RESIDUE_NEEDLES) {
    if (reportText.includes(needle)) fail("a3_redaction", `redaction report leaks original value: ${needle.slice(0, 24)}`);
  }
  // Sanitized base URL in manifest + environment snapshot values redacted.
  const manifest = JSON.parse(readFileSync(join(pssRun.bundle.dir, "manifest.json"), "utf8"));
  expect("a3_redaction", manifest.sanitized_base_url === "https://synthetic-staging.example.test", `sanitized_base_url malformed: ${manifest.sanitized_base_url}`);
  const envSnap = JSON.parse(readFileSync(join(pssRun.bundle.dir, "environment-snapshot.json"), "utf8"));
  expect("a3_redaction", envSnap.variables.NW_GITHUB_TOKEN === REDACTED && envSnap.variables.NW_TESTED_API_TOKEN === REDACTED, "environment snapshot credential values not redacted");
  // URL redaction unit checks (userinfo + credential query param).
  const urlReport = [];
  const sanitizedUrl = redactUrl("https://user:pass@synthetic.example.test/x?access_token=supersecretvalue123&page=2", undefined, urlReport, "$.url");
  expect("a3_redaction", !sanitizedUrl.includes("user:pass") && !sanitizedUrl.includes("supersecretvalue123") && sanitizedUrl.includes(REDACTED), `redactUrl failed: ${sanitizedUrl}`);
  expect("a3_redaction", sanitizedUrl.includes("page=2"), `redactUrl must keep benign params: ${sanitizedUrl}`);
  expect("a3_redaction", urlReport.length > 0, "redactUrl must report positions");
}

/* ================================================================== */
/* A4 — Secret scan blocks seal (encoded credentials)                  */
/* ================================================================== */
{
  const secRun = pass1.runs.find((r) => r.purpose === "secret-block-encoded-credentials");
  expect("a4_secret_scan_blocks_seal", !secRun.seal.ok, "SEC seal must be blocked");
  const error = secRun.seal.error;
  expect("a4_secret_scan_blocks_seal", error?.code === ERROR_CODES.SECRET_DETECTED, `expected EVD_SECRET_DETECTED, got ${error?.code}`);
  expect("a4_secret_scan_blocks_seal", error?.details?.reason === "secret_scan_hit", "blocked-seal error must carry reason=secret_scan_hit");
  const hits = error?.details?.hits ?? [];
  expect("a4_secret_scan_blocks_seal", hits.length >= 2, `expected ≥2 scan hits, got ${hits.length}`);
  const hitFiles = new Set(hits.map((h) => h.file));
  expect("a4_secret_scan_blocks_seal", hitFiles.has("responses/resp-0001.json") && hitFiles.has("logs/log-0002.json"), `hit files wrong: ${[...hitFiles].join(",")}`);
  const patterns = new Set(hits.map((h) => h.pattern));
  expect("a4_secret_scan_blocks_seal", patterns.has("aws-access-key-id") && patterns.has("github-token"), `hit patterns wrong: ${[...patterns].join(",")}`);
  for (const h of hits) {
    expect("a4_secret_scan_blocks_seal", h.pass === "base64-decoded" && Number.isInteger(h.line) && h.line >= 1 && Number.isInteger(h.column), `hit location malformed: ${JSON.stringify(h)}`);
  }
  const errorText = JSON.stringify(error);
  for (const needle of RESIDUE_NEEDLES.slice(9)) {
    if (errorText.includes(needle)) fail("a4_secret_scan_blocks_seal", `blocked-seal error leaks the secret value: ${needle.slice(0, 20)}`);
  }
  // Bundle remains unsealed; the encoded blobs are still inside it (they were
  // written pre-scan — the seal gate is what stops them from ever being sealed).
  expect("a4_secret_scan_blocks_seal", secRun.bundle.sealed === false, "blocked bundle must stay unsealed");
  expect("a4_secret_scan_blocks_seal", !existsSync(join(secRun.bundle.dir, "checksums.sha256")) && !existsSync(join(secRun.bundle.dir, "manifest.json")), "blocked bundle must have no manifest/checksums");
  expect("a4_secret_scan_blocks_seal", scanSecrets(secRun.bundle.dir).hits.length >= 2, "rescan of blocked bundle must still hit");
  const respText = readFileSync(join(secRun.bundle.dir, "responses/resp-0001.json"), "utf8");
  expect("a4_secret_scan_blocks_seal", respText.includes(RESIDUE_NEEDLES[10]), "encoded negative sample must reach the store for the scan to block (setup proof)");
}

/* ================================================================== */
/* A5 — Seal immutability, checksums, preconditions                    */
/* ================================================================== */
{
  const pssRun = pass1.runs.find((r) => r.purpose === "positive-all-pass");
  const b = pssRun.bundle;
  expect("a5_seal_immutability", b.sealed === true, "PSS bundle must be sealed");
  // Post-seal API writes rejected with EVD_* envelopes (payload never validated — sealed guard fires first).
  const dummyObservation = { observation_id: "obs_00000000000000000000000000" };
  const immutabilityAttempts = [
    ["ingestCaseEvent", () => b.ingestCaseEvent({ case_id: "case_01J8WP06RG0000000000POST1", result: "passed", api_id: "x", method: "GET", path: "/x", assertion_class: "status-code", status_or_error: "200", response_signature: "s", scenario_state: "t" })],
    ["recordObservation", () => b.recordObservation(dummyObservation)],
    ["recordCleanup", () => b.recordCleanup({ status: "completed" })],
    ["sealAgain", () => b.seal()],
  ];
  for (const [label, fn] of immutabilityAttempts) {
    const r = fn();
    const code = r?.error?.code;
    expect("a5_seal_immutability", r?.ok === false && code === ERROR_CODES.MANIFEST_INVALID && r.error.details?.reason === "sealed_bundle_immutable", `post-seal ${label} must be rejected (got ${code})`);
    if (r?.error) {
      const env = validateErrorEnvelope(r.error);
      expect("a5_seal_immutability", env.ok, `post-seal ${label} error envelope invalid: ${env.errors?.join("; ")}`);
    }
  }
  // Sealed verification passes; tampering is detected (on copies).
  expect("a5_seal_immutability", b.verifySealed().ok === true, "sealed bundle must verify cleanly");
  const tamperA = join(STATE_DIR, "tampered-a");
  const tamperB = join(STATE_DIR, "tampered-b");
  cpSync(b.dir, tamperA, { recursive: true });
  cpSync(b.dir, tamperB, { recursive: true });
  writeFileSync(join(tamperA, "timeline.jsonl"), `${readFileSync(join(tamperA, "timeline.jsonl"), "utf8")}{"tamper":true}\n`, "utf8");
  writeFileSync(join(tamperB, "extra-untracked.json"), "{}\n", "utf8");
  const vA = new RunBundle(tamperA, pssRun.ctx).verifySealed();
  const vB = new RunBundle(tamperB, pssRun.ctx).verifySealed();
  expect("a5_seal_immutability", vA.ok === false && vA.mismatches.some((m) => m.file === "timeline.jsonl" && m.problem === "checksum_mismatch"), "mutated payload must fail checksum verify");
  expect("a5_seal_immutability", vA.mismatches.some((m) => m.problem === "payload_digest_mismatch"), "payload digest must detect bundle-level mutation");
  expect("a5_seal_immutability", vB.ok === false && vB.mismatches.some((m) => m.problem === "untracked_file"), "post-seal addition must be flagged untracked");
  expect("a5_seal_immutability", b.verifySealed().ok === true, "original bundle must still verify after tamper copies");
  // Non-terminal / no-cleanup preconditions.
  for (const edge of EDGE_RUNS) {
    const run = pass1.runs.find((r) => r.purpose === edge.purpose);
    expect("a5_seal_immutability", !run.seal.ok && run.seal.error?.code === ERROR_CODES.MANIFEST_INVALID && run.seal.error?.details?.reason === edge.expectSealReason, `${edge.purpose}: expected rejection reason ${edge.expectSealReason}, got ${run.seal.error?.details?.reason}`);
    expect("a5_seal_immutability", run.bundle.sealed === false, `${edge.purpose} must stay unsealed`);
  }
  // Consumption guard + reopen derives sealed state from disk.
  const secBundle = pass1.runs.find((r) => r.purpose === "secret-block-encoded-credentials").bundle;
  const unsealedGuard = assertSealedForConsumption(secBundle);
  expect("a5_seal_immutability", unsealedGuard.ok === false && unsealedGuard.error.code === ERROR_CODES.NOT_SEALED, "unsealed bundle must be rejected for downstream consumption");
  expect("a5_seal_immutability", assertSealedForConsumption(b).ok === true, "sealed bundle must pass consumption guard");
  const reopened = pass1.store.open(pssRun.ctx.run_id);
  expect("a5_seal_immutability", reopened.ok && reopened.bundle.sealed === true, "store.open must derive sealed=true from checksums presence");
}

/* ================================================================== */
/* A6 — Observations recorded & schema-valid                           */
/* ================================================================== */
{
  let total = 0;
  for (const run of pass1.runs) {
    const obs = run.bundle.readObservations();
    total += obs.length;
    const failingCaseIds = new Set(run.events.filter((e) => e.result === "failed" || e.result === "error").map((e) => e.case_id));
    const obsCaseIds = new Set(obs.map((o) => o.case_id));
    expect("a6_observations_schema", failingCaseIds.size === obsCaseIds.size && [...failingCaseIds].every((c) => obsCaseIds.has(c)), `${run.purpose}: observations must map 1:1 to failed/error cases`);
    for (const o of obs) {
      const check = validateObservation(o);
      if (!check.ok) fail("a6_observations_schema", `${run.purpose}: observation ${o.observation_id} fails schema: ${check.errors.join("; ")}`);
      if (o.run_id !== run.ctx.run_id) fail("a6_observations_schema", `${run.purpose}: observation run_id mismatch`);
      expect("a6_observations_schema", !("hypothesis" in o), "observations must never carry hypothesis fields (§14.1)");
    }
  }
  expect("a6_observations_schema", total === 16, `expected 16 observations total, got ${total}`);
}

/* ================================================================== */
/* A7 — Six classifications                                            */
/* ================================================================== */
{
  const byRun = (purpose) => pass1.submissions.filter((s) => s.run === purpose);
  const expectSub = (purpose, idx, status, classification) => {
    const subs = byRun(purpose);
    if (subs.length <= idx) {
      fail("a7_six_classifications", `${purpose}: missing submission #${idx}`);
      return null;
    }
    const s = subs[idx];
    expect("a7_six_classifications", s.result.status === status, `${purpose}#${idx}: status ${s.result.status} != ${status}`);
    expect("a7_six_classifications", s.result.classification === classification, `${purpose}#${idx}: classification ${s.result.classification} != ${classification}`);
    return s;
  };
  expectSub("negative-confirmed", 0, "created", "confirmed");             // attempts 4 = failures 4 ≥ gate 3
  expectSub("flaky-intermittent", 0, "created", "flaky");                 // 0 < failures 2 < attempts 6
  expectSub("environmental-network", 0, "created", "environmental");      // signals/markers/transport precedence
  expectSub("spec-ambiguity", 0, "created", "spec-ambiguity");            // ambiguity precedence over gate
  expectSub("inconclusive-single-attempt", 0, "created", "inconclusive"); // attempts 1 < gate 3
  expectSub("cross-run-reproduction", 0, "merged", "duplicate");          // same fingerprint across runs
  expectSub("behavior-change-new-fingerprint", 0, "created", "confirmed");
  expect("a7_six_classifications", byRun("positive-all-pass").length === 0, "all-pass run must produce no findings");
  // Deterministic classifyFinding precedence spot-checks (pure function).
  const parts = buildFingerprint({ api_id: "a", method: "get", path: "/x", assertion_class: "status-code", status_or_error: "500", response_signature: "s", scenario_state: "t" });
  expect("a7_six_classifications", classifyFinding({ parts, reproduction: { attempts: 5, failures: 5, rate: 1 } }).classification === "confirmed", "gate sanity: 5/5 must be confirmed");
  expect("a7_six_classifications", classifyFinding({ parts, reproduction: { attempts: 2, failures: 2, rate: 1 } }).classification === "inconclusive", "below-gate must be inconclusive");
  expect("a7_six_classifications", classifyFinding({ parts, reproduction: { attempts: 5, failures: 5, rate: 1 }, environmental_signals: ["network"] }).classification === "environmental", "environmental precedence over gate");
  // Forcing an illegal classification is rejected with registered codes.
  const force = assertClassificationLegal({ parts, reproduction: { attempts: 1, failures: 1, rate: 1 } }, "confirmed");
  expect("a7_six_classifications", force.ok === false && force.error.code === ERROR_CODES.CLASSIFICATION_INVALID && validateErrorEnvelope(force.error).ok, "forced confirmed below gate must yield FND_CLASSIFICATION_INVALID");
  const zero = assertClassificationLegal({ parts, reproduction: { attempts: 0, failures: 0, rate: 0 } }, "inconclusive");
  expect("a7_six_classifications", zero.ok === false && zero.error.code === ERROR_CODES.INSUFFICIENT_EVIDENCE, "zero attempts must yield FND_INSUFFICIENT_EVIDENCE");
}

/* ================================================================== */
/* A8 — Fingerprint dedup, aggregation, behavior change                */
/* ================================================================== */
{
  const findings = pass1.findings;
  expect("a8_fingerprint_dedup", findings.list().length === 6, `expected 6 findings, got ${findings.list().length}`);
  const confirmed = pass1.submissions.find((s) => s.run === "negative-confirmed").result.finding;
  const mergedSub = pass1.submissions.find((s) => s.run === "cross-run-reproduction");
  expect("a8_fingerprint_dedup", mergedSub.result.duplicate_of === confirmed.finding_id, "cross-run submission must dedup onto the original finding");
  const after = findings.findByFingerprint(confirmed.fingerprint);
  expect("a8_fingerprint_dedup", after.finding_id === confirmed.finding_id, "same fingerprint must resolve to the same finding object");
  expect("a8_fingerprint_dedup", after.reproduction.attempts === 6 && after.reproduction.failures === 6 && after.reproduction.rate === 1, `aggregated reproduction wrong: ${JSON.stringify(after.reproduction)}`);
  expect("a8_fingerprint_dedup", after.observation_ids.length === 6, `aggregated observation_ids ${after.observation_ids.length} != 6`);
  // Behavior change: new finding related to the prior one.
  const behSub = pass1.submissions.find((s) => s.run === "behavior-change-new-fingerprint");
  expect("a8_fingerprint_dedup", behSub.result.relation?.relation === "behavior_changed_from" && behSub.result.relation?.prior_finding_id === confirmed.finding_id, "behavior change must relate new finding to prior");
  expect("a8_fingerprint_dedup", findings.relationsFor(behSub.result.finding.finding_id).length === 1, "relation must be queryable for the new finding");
  expect("a8_fingerprint_dedup", findings.relationsFor(confirmed.finding_id).length === 1, "relation must be queryable for the prior finding");
  // Path normalization feeds the fingerprint (dynamic segments collapse).
  expect("a8_fingerprint_dedup", normalizePath("/v1/widgets/01J8WP06RG0000000000CASEN1") === "/v1/widgets/{ulid}", "ULID segment must collapse");
  expect("a8_fingerprint_dedup", normalizePath("/v1/widgets/123?x=1") === "/v1/widgets/{id}", "numeric segment + query must collapse");
  expect("a8_fingerprint_dedup", normalizePath("/v1/widgets/550e8400-e29b-41d4-a716-446655440000") === "/v1/widgets/{uuid}", "UUID segment must collapse");
  // Malformed submissions rejected with registered codes.
  const badParts = { ...confirmed.fingerprint };
  delete badParts.response_signature;
  const dummyObs = [{ observation_id: "obs_00000000000000000000000000", run_id: "run_00000000000000000000000000", occurred_at: clock(), fact: { api_id: "a", method: "GET", path: "/x", status_or_error: "500" }, context: {} }];
  const incomplete = findings.submit({ parts: badParts, attempts: 2, failures: 2, observations: dummyObs });
  expect("a8_fingerprint_dedup", incomplete.ok === false && incomplete.error.code === ERROR_CODES.VALIDATION_FAILED && incomplete.error.details?.reason === "fingerprint_incomplete", "five-component fingerprint must be rejected");
  const zeroAttempts = findings.submit({ parts: confirmed.fingerprint, attempts: 0, failures: 0 });
  expect("a8_fingerprint_dedup", zeroAttempts.ok === false && zeroAttempts.error.code === ERROR_CODES.INSUFFICIENT_EVIDENCE, "attempts=0 must be rejected");
  const badCounts = findings.submit({ parts: confirmed.fingerprint, attempts: 2, failures: 3, observations: dummyObs });
  expect("a8_fingerprint_dedup", badCounts.ok === false && badCounts.error.code === ERROR_CODES.VALIDATION_FAILED, "failures>attempts must be rejected");
  expect("a8_fingerprint_dedup", findings.list().length === 6, "rejected submissions must not create findings");
}

/* ================================================================== */
/* A9 — WP-00 schemas + hypothesis firewall                            */
/* ================================================================== */
{
  // Every persisted finding line validates; machine findings never carry a hypothesis.
  const lines = readFileSync(join(STATE_DIR, "findings-1", "findings.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  expect("a9_schema_and_hypothesis", lines.length >= 6, "findings.jsonl must persist findings");
  for (const f of lines) {
    const check = validateFinding(f);
    if (!check.ok) fail("a9_schema_and_hypothesis", `finding ${f.finding_id} fails schema: ${check.errors.join("; ")}`);
    if (f.hypothesis !== "") fail("a9_schema_and_hypothesis", `machine-created finding ${f.finding_id} must default hypothesis to empty`);
  }
  // Explicit hypothesis goes ONLY into the hypothesis field, as an explicit action.
  // Applied symmetrically to BOTH passes so the A10 determinism diff compares
  // like-for-like stores (the acceptance flow itself must be deterministic).
  const flakyFinding = pass1.findings.list().find((f) => f.classification === "flaky");
  const text = "Suspected internal cause (unverified): search serializer may drop the total field under concurrent seed writes; hypothesis only, not a confirmed fact.";
  const hp = pass1.findings.setHypothesis(flakyFinding.finding_id, text);
  expect("a9_schema_and_hypothesis", hp.ok === true, `setHypothesis failed: ${JSON.stringify(hp.error)}`);
  expect("a9_schema_and_hypothesis", hp.finding.hypothesis === text, "hypothesis text must land in the hypothesis field");
  expect("a9_schema_and_hypothesis", hp.finding.classification === "flaky" && hp.finding.reproduction.attempts === 6, "hypothesis update must not touch classification/reproduction");
  const revalidated = validateFinding(hp.finding);
  expect("a9_schema_and_hypothesis", revalidated.ok, `finding with hypothesis must still pass schema: ${revalidated.errors?.join("; ")}`);
  const reread = pass1.findings.list().find((f) => f.finding_id === flakyFinding.finding_id);
  expect("a9_schema_and_hypothesis", reread.hypothesis === text, "hypothesis must persist");
  const flaky2 = pass2.findings.list().find((f) => f.classification === "flaky");
  const hp2 = flaky2 ? pass2.findings.setHypothesis(flaky2.finding_id, text) : null;
  expect("a9_schema_and_hypothesis", hp2?.ok === true, `pass-2 setHypothesis failed: ${JSON.stringify(hp2?.error)}`);
  // Manifests (run objects) re-validated from disk.
  for (const run of pass1.runs.filter((r) => r.seal.ok)) {
    const manifest = JSON.parse(readFileSync(join(run.bundle.dir, "manifest.json"), "utf8"));
    if (!validateRun(manifest).ok) fail("a9_schema_and_hypothesis", `manifest ${run.ctx.run_id} fails run schema on reread`);
  }
}

/* ================================================================== */
/* A10 — Zero-hit scan, determinism, baselines                         */
/* ================================================================== */
{
  // Sealed bundles contain no credential material (the seal gate guarantees it;
  // re-scan independently to prove it).
  let sealedHitTotal = 0;
  let scannedBundles = 0;
  for (const run of pass1.runs.filter((r) => r.seal.ok)) {
    scannedBundles += 1;
    sealedHitTotal += scanSecrets(run.bundle.dir).hits.length;
  }
  expect("a10_determinism_and_baseline", sealedHitTotal === 0, `sealed bundles must scan clean (hits=${sealedHitTotal})`);
  expect("a10_determinism_and_baseline", scannedBundles === 8, `expected 8 sealed bundles scanned, got ${scannedBundles}`);
  // Determinism: two full pipeline passes → byte-identical stores & finding stores.
  const storeDiffs = diffTrees(join(STATE_DIR, "store-1"), join(STATE_DIR, "store-2"));
  const findingDiffs = diffTrees(join(STATE_DIR, "findings-1"), join(STATE_DIR, "findings-2"));
  expect("a10_determinism_and_baseline", storeDiffs.length === 0, `store trees differ: ${storeDiffs.slice(0, 5).join("; ")}`);
  expect("a10_determinism_and_baseline", findingDiffs.length === 0, `finding stores differ: ${findingDiffs.slice(0, 5).join("; ")}`);
  // Audit went through the WP-03 public API (isolated store), idempotently.
  expect("a10_determinism_and_baseline", pass1.tally.failed === 0 && pass1.tally.fallback === 0, `audit must reach the WP-03 store (tally=${JSON.stringify(pass1.tally)})`);
  expect("a10_determinism_and_baseline", pass1.tally.ok_new > 0, "pass 1 must record new audit events");
  expect("a10_determinism_and_baseline", pass2.tally.ok_new === 0 && pass2.tally.replay === pass1.tally.ok_new, `pass 2 must be a pure idempotent replay (tally=${JSON.stringify(pass2.tally)})`);
  // Baseline WP-00/WP-03 receipts are ok (read-only; fresh reruns are the
  // Coordinator-side acceptance step, evidence recorded in DeliveryNotice §3).
  const readReceipt = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const wp00 = readReceipt(join(NW_ROOT, "verify", "receipt.json"));
  const wp03 = readReceipt(join(NW_ROOT, "state", "verify", "receipt.json"));
  expect("a10_determinism_and_baseline", wp00?.ok === true, "baseline WP-00 receipt must exist and be ok");
  expect("a10_determinism_and_baseline", wp03?.ok === true, "baseline WP-03 receipt must exist and be ok");
}

/* ================================================================== */
/* Receipt                                                             */
/* ================================================================== */
const checks = {};
for (const [key, val] of Object.entries(R)) checks[key] = { ok: val.failures.length === 0, failures: val.failures };
checks.a1_bundle_structure.sealed_bundles = 8;
checks.a1_bundle_structure.index_runs = FIXTURES.runs.length + EDGE_RUNS.length;
checks.a2_ingest.ingested_runs = pass1.runs.length;
checks.a2_ingest.ingested_cases = pass1.runs.reduce((acc, r) => acc + r.events.length, 0);
checks.a3_redaction.needles = RESIDUE_NEEDLES.length;
checks.a3_redaction.redaction_report_total = JSON.parse(
  readFileSync(join(pass1.runs.find((r) => r.purpose === "positive-all-pass").bundle.dir, "redaction-report.json"), "utf8")
).total_count;
checks.a4_secret_scan_blocks_seal.blocked_run = SEC.run_id;
checks.a4_secret_scan_blocks_seal.scan_hits = (pass1.runs.find((r) => r.purpose === "secret-block-encoded-credentials").seal.error?.details?.hits ?? []).length;
checks.a5_seal_immutability.tamper_cases = 2;
checks.a6_observations_schema.total_observations = pass1.runs.reduce((acc, r) => acc + r.bundle.readObservations().length, 0);
checks.a7_six_classifications.classifications_exercised = ["confirmed", "flaky", "environmental", "spec-ambiguity", "inconclusive", "duplicate"];
checks.a8_fingerprint_dedup.findings = pass1.findings.list().length;
checks.a8_fingerprint_dedup.relations = pass1.findings.relations.length;
checks.a9_schema_and_hypothesis.hypothesis_firewall = true;
checks.a10_determinism_and_baseline.audit_tally_pass1 = pass1.tally;
checks.a10_determinism_and_baseline.audit_tally_pass2 = pass2.tally;

const ok = Object.values(R).every((v) => v.failures.length === 0);
const receipt = {
  ok,
  finished_at: new Date().toISOString(),
  verifier: "nightwatch/evidence/verify.mjs",
  task_fingerprint: "nw+p0+wp06+evidence-finding+impl+arch@v1.4+a734f71",
  checks,
  artifacts: [relFromRepo(RECEIPT_PATH), relFromRepo(join(EVIDENCE_ROOT, "fixtures", "execution-events.json"))],
  state_dir: relFromRepo(STATE_DIR) + " (runtime only, wiped at every verify start)",
};

mkdirSync(join(EVIDENCE_ROOT, "verify"), { recursive: true });
writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

const line = (s) => process.stdout.write(s + "\n");
line("=== NightWatch WP-06 Evidence & Finding Verification ===");
line(`A1  bundle_structure          : ${checks.a1_bundle_structure.ok ? "ok" : "FAILED"} (${checks.a1_bundle_structure.sealed_bundles} sealed bundles, index ${checks.a1_bundle_structure.index_runs} runs)`);
line(`A2  ingest                    : ${checks.a2_ingest.ok ? "ok" : "FAILED"} (${checks.a2_ingest.ingested_cases} cases across ${checks.a2_ingest.ingested_runs} runs)`);
line(`A3  redaction                 : ${checks.a3_redaction.ok ? "ok" : "FAILED"} (${checks.a3_redaction.needles} needles, ${checks.a3_redaction.redaction_report_total} redactions recorded)`);
line(`A4  secret_scan_blocks_seal   : ${checks.a4_secret_scan_blocks_seal.ok ? "ok" : "FAILED"} (${checks.a4_secret_scan_blocks_seal.scan_hits} encoded hits blocked)`);
line(`A5  seal_immutability         : ${checks.a5_seal_immutability.ok ? "ok" : "FAILED"} (checksums + ${checks.a5_seal_immutability.tamper_cases} tamper cases + preconditions)`);
line(`A6  observations_schema       : ${checks.a6_observations_schema.ok ? "ok" : "FAILED"} (${checks.a6_observations_schema.total_observations} observations)`);
line(`A7  six_classifications       : ${checks.a7_six_classifications.ok ? "ok" : "FAILED"} (6/6 exercised)`);
line(`A8  fingerprint_dedup         : ${checks.a8_fingerprint_dedup.ok ? "ok" : "FAILED"} (${checks.a8_fingerprint_dedup.findings} findings, ${checks.a8_fingerprint_dedup.relations} relation(s))`);
line(`A9  schema_and_hypothesis     : ${checks.a9_schema_and_hypothesis.ok ? "ok" : "FAILED"} (run/observation/finding valid, firewall holds)`);
line(`A10 determinism_and_baseline  : ${checks.a10_determinism_and_baseline.ok ? "ok" : "FAILED"} (0 sealed hits, byte-identical passes, audit idempotent)`);
line("");
for (const [key, val] of Object.entries(R)) {
  if (val.failures.length > 0) line(`${key} failures:\n${JSON.stringify(val.failures, null, 2)}`);
}
line(`receipt: ${relFromRepo(RECEIPT_PATH)}`);
line(ok ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
process.exit(ok ? 0 : 1);
