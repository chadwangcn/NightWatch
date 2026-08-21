#!/usr/bin/env node
/**
 * NightWatch WP-09 — Console Experience verifier (A1–A10).
 *
 * Independent acceptance over the REAL HTTP/SSE surface: each pass wires two
 * full deployments (A: approved lumi-local default; B: production-locked
 * default → policy-denied publish) of REAL WP-01..07 components + the WP-08
 * Control API/Orchestrator, binds each to a 127.0.0.1 console server with a
 * fresh capability token, and drives every user path over plain HTTP.
 *
 *   A1  server startup: 127.0.0.1 binding, token generation, static assets,
 *       all-real in-process wiring
 *   A2  write auth: missing/wrong token → 401 envelope + ZERO side effects;
 *       POST /approvals audited through WP-03
 *   A3  command passthrough: createSession (schema-valid session), sessions
 *       list, sessionView aggregation, unknown id → 404 JSON
 *   A4  SSE: history replay BEFORE live push, sequence-ordered delivery,
 *       ?object_id= filter (forObject semantics), frozen frame format,
 *       zero-secret frames
 *   A5  key user path over HTTP: createSession → startRun (events seen via
 *       SSE) → sessionView sealed run + drafts → approval → publishIssue →
 *       published receipt visible
 *   A6  error & permission visibility: invalid envelope →
 *       CTL_VALIDATION_FAILED; late deadline → CTL_COMMAND_TIMEOUT; publish
 *       without approval → ISS_GATE_FAILED (C13 gate) with complete fields;
 *       production-locked deployment → policy denial + policy_code visible +
 *       ZERO GitHub writes
 *   A7  static boundary: console source import whitelist, no component
 *       data-plane fs reads, UI assets carry no external URLs
 *   A8  path safety: traversal-shaped object ids → 404, whitelist-only
 *       assets, no filesystem side effects, server stays healthy
 *   A9  HTTP-level idempotency: same command_id replay → original receipt
 *       with idempotent_replay=true; identical POST /approvals → audit NOT
 *       double-booked
 *   A10 determinism: two passes → byte-identical checks (time fields
 *       excluded); secret scan zero hits (sources + HTTP/SSE outputs);
 *       WP-00..08 baseline verifiers re-run exit 0 (serial)
 *
 * Usage: node nightwatch/console/verify.mjs   (from the repository root)
 * Runtime state lives under nightwatch/console/.state/ (gitignored) and is
 * wiped at the end (HTTP servers force-closed in finally).
 */
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { request as httpRequest, get as httpGet } from "node:http";

import { ControlApi, Orchestrator, validateSession } from "../control/lib/index.mjs";
import { RegistryStore } from "../registry/lib/store.mjs";
import { LibraryStore } from "../library/lib/store.mjs";
import { PolicyGate } from "../policy/lib/gate.mjs";
import { ExecutorGateway } from "../executor/lib/worker.mjs";
import { EvidenceStore, FindingStore } from "../evidence/lib/index.mjs";
import { IssueGateway, GitHubStub } from "../issue/lib/index.mjs";

import { buildDeployment } from "./lib/wiring.mjs";
import { buildConsoleServer } from "./lib/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/console
const REPO_ROOT = join(HERE, "..", "..");
const STATE_DIR = join(HERE, ".state");
const RECEIPT_PATH = join(HERE, "verify", "receipt.json");
const TASK_FINGERPRINT = "nw+p0+wp09+console-experience+impl+arch@v1.4+895a747";
const FIXTURES = JSON.parse(readFileSync(join(HERE, "..", "control", "fixtures", "orchestration-fixtures.json"), "utf8"));
const CONFIRM_SCENARIO = FIXTURES.scenario_ids.confirm;

/* Fixed clock: every timestamp in stores/events/receipts derives from this
 * instant, so the two passes are byte-identical (time fields excluded). */
const FIXED_MS = Date.parse("2026-08-21T12:00:00Z");
const isoFixed = () => new Date(FIXED_MS).toISOString().replace(/\.\d+Z$/, "Z");
const isoFixedPlus = (ms) => new Date(FIXED_MS + ms).toISOString().replace(/\.\d+Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

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

const SECRET_PATTERNS = [
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/],
  ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\./],
];
const scanText = (text) => {
  const hits = [];
  for (const [label, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ pattern: label, sample: `${m[0].slice(0, 12)}...` });
  }
  return hits;
};

/* ------------------------------------------------------------------ */
/* HTTP / SSE test clients (loopback only)                             */
/* ------------------------------------------------------------------ */
function makeHttpJson(collector) {
  return (port, method, path, { token, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (payload !== null) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          collector.push(text);
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode, text, json, contentType: res.headers["content-type"] ?? "" });
        });
      });
      req.on("error", reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
}

/** Parse one SSE block into {event,id,data,parsed} (comment frames → null). */
function parseSseFrame(block) {
  const out = { event: null, id: null, data: null };
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("id: ")) out.id = line.slice(4);
    else if (line.startsWith("data: ")) out.data = line.slice(6);
  }
  if (!out.event || out.data === null) return null;
  try {
    return { ...out, parsed: JSON.parse(out.data) };
  } catch {
    return null;
  }
}

/** Collect SSE frames until `until(frames)` or timeout; returns {frames, raw}. */
function sseCollect(collector) {
  return (port, path, { until, timeoutMs = 15000 }) =>
    new Promise((resolve) => {
      const frames = [];
      let raw = "";
      let settled = false;
      const finish = (timeout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        collector.push(raw);
        resolve({ frames, raw, timeout });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      const req = httpGet({ host: "127.0.0.1", port, path }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          let idx;
          while ((idx = raw.indexOf("\n\n")) >= 0) {
            const block = raw.slice(0, idx);
            raw = raw.slice(idx + 2);
            const frame = parseSseFrame(block);
            if (frame) frames.push(frame);
          }
          if (until && until(frames)) finish(false);
        });
        res.on("end", () => finish(false));
      });
      req.on("error", () => finish(false));
    });
}

/* ------------------------------------------------------------------ */
/* One full acceptance pass (two deployments: A approved / B locked)   */
/* ------------------------------------------------------------------ */
async function runPass(passName) {
  const passDir = join(STATE_DIR, passName);
  rmSync(passDir, { recursive: true, force: true });
  mkdirSync(passDir, { recursive: true });
  const { assert, checks, failures } = makeChecks();
  const outputTexts = [];
  const httpJson = makeHttpJson(outputTexts);
  const sse = sseCollect(outputTexts);

  let cmdSeq = 0;
  const envelope = (payload, overrides = {}) => ({
    command_id: `cmd-wp09-${passName}-${String((cmdSeq += 1)).padStart(4, "0")}`,
    issued_at: isoFixed(),
    deadline: isoFixedPlus(600_000),
    payload,
    ...overrides,
  });

  /* Deployment A: approved default (lumi-local). */
  const A = await buildDeployment({ stateDir: join(passDir, "deploy-a"), auditStoreDir: join(passDir, "deploy-a", "wp03"), defaultEnvironment: "lumi-local", nowMs: () => FIXED_MS });
  const consoleA = buildConsoleServer({ deployment: A });
  const addrA = await consoleA.listen(0);
  const portA = addrA.port;
  const tokenA = consoleA.token;

  /* Deployment B: production-locked default → publish policy DENIED. */
  const B = await buildDeployment({ stateDir: join(passDir, "deploy-b"), auditStoreDir: join(passDir, "deploy-b", "wp03"), defaultEnvironment: "nw-orch-prod-locked", nowMs: () => FIXED_MS });
  const consoleB = buildConsoleServer({ deployment: B });
  const addrB = await consoleB.listen(0);
  const portB = addrB.port;
  const tokenB = consoleB.token;

  try {
    /* ============== A1: startup / binding / token / assets ========== */
    assert("a1_bind_loopback_only", addrA.address === "127.0.0.1" && addrB.address === "127.0.0.1", { a: addrA.address, b: addrB.address });
    assert("a1_capability_token_generated", typeof tokenA === "string" && tokenA.length >= 32 && tokenA !== tokenB, { length: tokenA.length });
    assert("a1_wiring_real_components", [
      A.registry instanceof RegistryStore,
      A.library instanceof LibraryStore,
      A.policyGate instanceof PolicyGate,
      A.executor instanceof ExecutorGateway,
      A.evidence instanceof EvidenceStore,
      A.findings instanceof FindingStore,
      A.issueGateway instanceof IssueGateway,
      A.github instanceof GitHubStub,
      A.orchestrator instanceof Orchestrator,
      A.api instanceof ControlApi,
    ].every(Boolean));
    const indexPage = await httpJson(portA, "GET", "/");
    const styleCss = await httpJson(portA, "GET", "/assets/style.css");
    const appJs = await httpJson(portA, "GET", "/assets/app.js");
    assert(
      "a1_static_assets_served",
      indexPage.status === 200 && /<html/i.test(indexPage.text) && indexPage.contentType.includes("text/html") &&
        styleCss.status === 200 && styleCss.contentType.includes("text/css") &&
        appJs.status === 200 && appJs.contentType.includes("text/javascript"),
      { index: indexPage.status, css: styleCss.status, js: appJs.status }
    );

    /* ============== A2: write auth boundary ========================= */
    const authProbe = envelope({ workspace_id: "nw-wp09-auth-probe", goal: "unauthorized probe must have zero side effects" });
    const noToken = await httpJson(portA, "POST", "/commands/createSession", { body: authProbe });
    assert("a2_write_without_token_401", noToken.status === 401 && noToken.json?.ok === false && noToken.json.error?.code === "CTL_UNAUTHORIZED" && noToken.json.error?.details?.reason === "missing_bearer_token", { status: noToken.status, code: noToken.json?.error?.code });
    const badToken = await httpJson(portA, "POST", "/commands/createSession", { token: "not-the-token", body: authProbe });
    assert("a2_write_wrong_token_401", badToken.status === 401 && badToken.json?.error?.code === "CTL_UNAUTHORIZED" && badToken.json.error?.details?.reason === "invalid_token");
    const apNoToken = await httpJson(portA, "POST", "/approvals", { body: { approver: "x", decision: "approved", scope: "s", approved_at: isoFixed(), expires_at: isoFixedPlus(3600_000) } });
    assert("a2_approvals_without_token_401", apNoToken.status === 401 && apNoToken.json?.error?.code === "CTL_UNAUTHORIZED");
    const emptyList = await httpJson(portA, "GET", "/sessions");
    assert("a2_zero_side_effects_after_401", emptyList.status === 200 && emptyList.json?.ok === true && emptyList.json.sessions.length === 0 && A.passState.audit.list().length === 0, { sessions: emptyList.json?.sessions?.length, audits: A.passState.audit.list().length });

    /* ============== A3: command passthrough + DTOs ================== */
    const createEnv = envelope({
      workspace_id: "nw-wp09-workspace",
      goal: "WP-09 acceptance: console drives the confirm scenario end to end",
      authorization_boundary: "synthetic local Golden Fault stub only; no production systems",
    });
    const created = await httpJson(portA, "POST", "/commands/createSession", { token: tokenA, body: createEnv });
    assert("a3_create_session_ok", created.status === 200 && created.json?.ok === true && typeof created.json.result?.session_id === "string", { error: created.json?.error });
    const S1 = created.json?.result?.session_id ?? "session_missing";
    assert("a3_session_schema_valid", Boolean(created.json?.result?.session) && validateSession(created.json.result.session).ok);
    const listed = await httpJson(portA, "GET", "/sessions");
    assert("a3_sessions_listed", listed.json?.ok === true && listed.json.sessions.length === 1 && listed.json.sessions[0].session_id === S1 && typeof listed.json.sessions[0].state === "string", { count: listed.json?.sessions?.length });
    const view0 = await httpJson(portA, "GET", `/sessions/${S1}`);
    /* A fresh session aggregates session + four EMPTY arrays: createSession
     * only audits/checkpoints (no EventBus event), so runs/drafts/published/
     * events are all legitimately [] at this point (post-run aggregation is
     * asserted by a5_view_sealed_run_and_drafts below). */
    assert(
      "a3_session_view_aggregates",
      view0.status === 200 && view0.json?.ok === true && view0.json.session?.session_id === S1 && view0.json.session?.state === "discovery" &&
        Array.isArray(view0.json.runs) && Array.isArray(view0.json.drafts) && Array.isArray(view0.json.published) && Array.isArray(view0.json.events) &&
        view0.json.runs.length === 0 && view0.json.drafts.length === 0 && view0.json.published.length === 0 && view0.json.events.length === 0,
      { runs: view0.json?.runs?.length, events: view0.json?.events?.length }
    );
    const ghostId = `session_${"01J"}${"Z".repeat(23)}`;
    const ghost = await httpJson(portA, "GET", `/sessions/${ghostId}`);
    assert("a3_unknown_session_404_json", ghost.status === 404 && ghost.json?.ok === false && ghost.json.error?.code === "CTL_VALIDATION_FAILED" && ghost.json.error?.details?.reason === "session_not_found", { status: ghost.status });

    /* ============== A5/A4: startRun with live SSE =================== */
    const sseLive = sse(portA, "/events", { until: (frames) => frames.some((f) => f.event === "runCompleted"), timeoutMs: 60_000 });
    const startRunEnv = envelope({ session_id: S1, environment: "lumi-local", scenario_id: CONFIRM_SCENARIO });
    const started = await httpJson(portA, "POST", "/commands/startRun", { token: tokenA, body: startRunEnv });
    assert("a5_start_run_ok", started.json?.ok === true, { error: started.json?.error });
    const run1 = started.json?.result?.run ?? null;
    assert("a5_run_shape", Boolean(run1) && run1.outcome === "failed" && run1.case_summary?.total === 9 && run1.case_summary?.failed === 6, { outcome: run1?.outcome, summary: run1?.case_summary });
    const live = await sseLive;
    const liveStarted = live.frames.filter((f) => f.event === "runStarted" && f.parsed.event.object_id === run1?.run_id);
    const liveCompleted = live.frames.filter((f) => f.event === "runCompleted" && f.parsed.event.object_id === run1?.run_id);
    assert("a5_run_events_seen_via_sse", liveStarted.length === 1 && liveCompleted.length === 1, { started: liveStarted.length, completed: liveCompleted.length });

    /* A4: history replay (post-hoc connection, ?object_id= filter). */
    const expectedRunEvents = A.events.forObject(run1.run_id);
    const replay = await sse(portA, `/events?object_id=${encodeURIComponent(run1.run_id)}`, { until: (frames) => frames.length >= expectedRunEvents.length, timeoutMs: 15_000 });
    assert(
      "a4_sse_history_replay_exact",
      JSON.stringify(replay.frames.map((f) => f.id)) === JSON.stringify(expectedRunEvents.map((e) => e.event.event_id)),
      { got: replay.frames.length, expected: expectedRunEvents.length }
    );
    const seqs = replay.frames.map((f) => f.parsed.event.sequence);
    assert("a4_sse_sequence_ordered", seqs.length > 5 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]), { seqs: seqs.slice(0, 6) });
    assert("a4_sse_object_filter", replay.frames.every((f) => f.parsed.event.object_id === run1.run_id) && !replay.frames.some((f) => f.event === "sessionStateChanged"));
    assert(
      "a4_sse_frame_format_frozen",
      replay.frames.every((f) => f.id === f.parsed.event.event_id && f.event === f.parsed.name && typeof f.parsed.event.sequence === "number" && typeof f.parsed.event.occurred_at === "string" && f.parsed.event.event_id.startsWith("evt_"))
    );
    assert("a4_sse_frames_zero_secrets", scanText(replay.raw).length === 0, { hits: scanText(replay.raw) });

    /* A4: replay-then-live on ONE connection. createSession emits NO events,
     * so S2 is created FIRST: the connection's history replay still equals
     * the pre-run snapshot exactly, and every frame beyond that prefix is a
     * LIVE push (startRun drives sessionStateChanged for S2 through the bus
     * after the replay has been delivered). */
    const created2 = await httpJson(portA, "POST", "/commands/createSession", { token: tokenA, body: envelope({ workspace_id: "nw-wp09-s2", goal: "WP-09 A4: live push after history replay on one connection" }) });
    const S2 = created2.json?.result?.session_id;
    const baseIds = A.events.history().map((e) => e.event.event_id);
    const sseBoth = sse(portA, "/events", { until: (frames) => frames.some((f) => f.event === "sessionStateChanged" && f.parsed.event.object_id === S2), timeoutMs: 30_000 });
    await sleep(300); // connection established + history replayed before the run below
    const run2 = await httpJson(portA, "POST", "/commands/startRun", { token: tokenA, body: envelope({ session_id: S2, environment: "lumi-local", scenario_id: CONFIRM_SCENARIO }) });
    const both = await sseBoth;
    assert(
      "a4_sse_replay_then_live",
      run2.json?.ok === true &&
        JSON.stringify(both.frames.slice(0, baseIds.length).map((f) => f.id)) === JSON.stringify(baseIds) &&
        both.frames.slice(baseIds.length).some((f) => f.event === "sessionStateChanged" && f.parsed.event.object_id === S2),
      { base: baseIds.length }
    );

    /* ============== A6 (line 1): publish WITHOUT approval =========== */
    const viewAfterRun = await httpJson(portA, "GET", `/sessions/${S1}`);
    assert(
      "a5_view_sealed_run_and_drafts",
      viewAfterRun.json?.runs?.length === 1 && viewAfterRun.json.runs[0].sealed === true && viewAfterRun.json.drafts?.length === 2 && viewAfterRun.json.drafts.every((d) => d.published === false) &&
        viewAfterRun.json?.events?.length >= 1 && viewAfterRun.json.events.every((e) => e.event.object_id === S1),
      { runs: viewAfterRun.json?.runs?.length, drafts: viewAfterRun.json?.drafts?.length, events: viewAfterRun.json?.events?.length }
    );
    const draft1 = viewAfterRun.json.drafts[0];
    const draft2 = viewAfterRun.json.drafts[1];
    const noApproval = await httpJson(portA, "POST", "/commands/publishIssue", { token: tokenA, body: envelope({ draft_id: draft2.draft_id }) });
    assert(
      "a6_publish_without_approval_c13_gate",
      noApproval.status === 200 && noApproval.json?.ok === false && noApproval.json.error?.code === "ISS_GATE_FAILED" && noApproval.json.error?.details?.gate === "reviewer",
      { code: noApproval.json?.error?.code, gate: noApproval.json?.error?.details?.gate }
    );
    assert(
      "a6_gate_error_fields_complete",
      noApproval.json?.ok === false && ["code", "message", "retryable", "idempotent_replay"].every((k) => k in noApproval.json.error) && typeof noApproval.json.error.details?.gate === "string" && typeof noApproval.json.error.details?.reason === "string"
    );
    assert("a6_no_approval_zero_writes", A.github.writeCount() === 0, { writes: A.github.writeCount() });

    /* ============== A5 (cont.): approval → publish → receipt ======= */
    const approvalBody = {
      approver: FIXTURES.approvals.valid.approver,
      decision: "approved",
      scope: `issue.publish:finding=${draft1.finding_id}`,
      approved_at: isoFixed(),
      expires_at: isoFixedPlus(3_600_000),
      reason: "WP-09 console acceptance: reviewer approves the confirmed finding",
    };
    const approval1 = await httpJson(portA, "POST", "/approvals", { token: tokenA, body: approvalBody });
    assert("a5_approval_registered", approval1.status === 200 && approval1.json?.ok === true && approval1.json.registered === approvalBody.scope && approval1.json.idempotent_replay === false, { body: approval1.json });
    const approvalAudits = A.passState.audit.list().filter((e) => e.action === "approval.register");
    assert("a2_approval_audited_via_wp03", approvalAudits.length === 1 && approvalAudits[0].idempotency_key === `${approvalBody.scope}:${approvalBody.approved_at}` && approvalAudits[0].actor === "C01-console", { count: approvalAudits.length, key: approvalAudits[0]?.idempotency_key });

    const publishEnv = envelope({ draft_id: draft1.draft_id });
    const published = await httpJson(portA, "POST", "/commands/publishIssue", { token: tokenA, body: publishEnv });
    assert("a5_publish_issue_ok", published.json?.ok === true, { error: published.json?.error });
    const receipt = published.json?.result?.receipt ?? null;
    assert("a5_receipt_visible", Boolean(receipt) && typeof receipt.issue_ref === "string" && receipt.gates?.length === 6, { issue_ref: receipt?.issue_ref });
    assert("a5_single_github_write", A.github.writeCount("createIssue") === 1, { writes: A.github.writeCount("createIssue") });
    const viewPublished = await httpJson(portA, "GET", `/sessions/${S1}`);
    assert(
      "a5_published_receipt_in_view",
      viewPublished.json?.published?.length === 1 && viewPublished.json.published[0].draft_id === draft1.draft_id && viewPublished.json.published[0].issue_ref === receipt?.issue_ref && viewPublished.json.drafts.find((d) => d.draft_id === draft1.draft_id)?.published === true && viewPublished.json.session?.state === "published",
      { published: viewPublished.json?.published?.length, state: viewPublished.json?.session?.state }
    );

    /* ============== A6 (line 2): envelope / deadline errors ========= */
    const invalidEnvelope = await httpJson(portA, "POST", "/commands/createSession", {
      token: tokenA,
      body: { command_id: `cmd-wp09-${passName}-invalid`, issued_at: isoFixed(), payload: { workspace_id: "nw-wp09-bad", goal: "missing deadline must fail the envelope schema" } },
    });
    assert("a6_invalid_envelope_ctl", invalidEnvelope.status === 200 && invalidEnvelope.json?.ok === false && invalidEnvelope.json.error?.code === "CTL_VALIDATION_FAILED" && invalidEnvelope.json.error?.details?.reason === "command_schema", { code: invalidEnvelope.json?.error?.code });
    const late = await httpJson(portA, "POST", "/commands/createSession", { token: tokenA, body: envelope({ workspace_id: "nw-wp09-late", goal: "deadline already passed" }, { deadline: isoFixed() }) });
    assert("a6_deadline_timeout_ctl", late.status === 200 && late.json?.ok === false && late.json.error?.code === "CTL_COMMAND_TIMEOUT" && late.json.error?.details?.reason === "deadline_exceeded", { code: late.json?.error?.code });
    const unknownCmd = await httpJson(portA, "POST", "/commands/explodeEverything", { token: tokenA, body: envelope({ any: "thing" }) });
    assert("a6_unknown_command_ctl", unknownCmd.json?.ok === false && unknownCmd.json.error?.code === "CTL_VALIDATION_FAILED" && unknownCmd.json.error?.details?.reason === "unknown_command");
    const badJson = await httpJson(portA, "POST", "/commands/createSession", { token: tokenA, body: undefined });
    /* an EMPTY body is still invalid JSON for the envelope → 400 semantics */
    assert("a6_malformed_body_rejected", badJson.status === 400 && badJson.json?.error?.code === "CTL_VALIDATION_FAILED", { status: badJson.status });

    /* ============== A6 (line 3): policy denial (deployment B) ======= */
    const createdB = await httpJson(portB, "POST", "/commands/createSession", { token: tokenB, body: envelope({ workspace_id: "nw-wp09-denied", goal: "WP-09 A6: production-locked publish denial" }) });
    const SB = createdB.json?.result?.session_id;
    const runB = await httpJson(portB, "POST", "/commands/startRun", { token: tokenB, body: envelope({ session_id: SB, environment: "lumi-local", scenario_id: CONFIRM_SCENARIO }) });
    assert("a6_denied_deployment_run_ok", runB.json?.ok === true, { error: runB.json?.error });
    const viewB = await httpJson(portB, "GET", `/sessions/${SB}`);
    const draftB = viewB.json?.drafts?.[0];
    assert("a6_denied_deployment_draft_built", Boolean(draftB), { drafts: viewB.json?.drafts?.length });
    /* register the reviewer approval too, so the denial provably comes from
     * POLICY (production classification), not from a missing approval. */
    await httpJson(portB, "POST", "/approvals", { token: tokenB, body: { approver: FIXTURES.approvals.valid.approver, decision: "approved", scope: `issue.publish:finding=${draftB.finding_id}`, approved_at: isoFixed(), expires_at: isoFixedPlus(3_600_000), reason: "WP-09: approval present, policy must still deny" } });
    const denied = await httpJson(portB, "POST", "/commands/publishIssue", { token: tokenB, body: envelope({ draft_id: draftB.draft_id }) });
    assert(
      "a6_policy_denied_visible",
      denied.status === 200 && denied.json?.ok === false && denied.json.error?.details?.reason === "policy_denied" && denied.json.error?.details?.policy_code === "POL_DENIED" && typeof denied.json.error?.details?.decision_id === "string",
      { code: denied.json?.error?.code, policy_code: denied.json?.error?.details?.policy_code }
    );
    assert("a6_policy_denied_zero_writes", B.github.writeCount() === 0 && B.github.writeCount("createIssue") === 0 && B.github.writeCount("addComment") === 0, { writes: B.github.writeCount() });
    const viewB2 = await httpJson(portB, "GET", `/sessions/${SB}`);
    assert("a6_policy_denied_state_unchanged", viewB2.json?.session?.state === "issue_review" && viewB2.json?.published?.length === 0, { state: viewB2.json?.session?.state });

    /* ============== A8: path safety ================================= */
    const traversal1 = await httpJson(portA, "GET", "/sessions/..%2F..%2Fetc%2Fpasswd");
    assert("a8_encoded_traversal_session_404", traversal1.status === 404 && traversal1.json?.error?.code === "CTL_VALIDATION_FAILED", { status: traversal1.status });
    const traversal2 = await httpJson(portA, "GET", "/sessions/../../etc/passwd");
    assert("a8_raw_traversal_session_404", traversal2.status === 404 && traversal2.json?.ok === false, { status: traversal2.status });
    const traversal3 = await httpJson(portA, "GET", "/assets/../lib/wiring.mjs");
    assert("a8_asset_traversal_404", traversal3.status === 404 && traversal3.json?.error?.details?.reason === "route_not_found", { status: traversal3.status });
    const traversal4 = await httpJson(portA, "GET", "/assets/../../../etc/passwd");
    assert("a8_asset_escape_404", traversal4.status === 404);
    const evilStream = await sse(portA, "/events?object_id=..%2F..%2Fetc%2Fpasswd", { timeoutMs: 800 });
    assert("a8_object_id_filter_safe", evilStream.frames.every((f) => f.parsed.event.object_id === "..%2F..%2Fetc%2Fpasswd".split("%2F")[0] || f.parsed.event.object_id.includes("..") === false) && evilStream.frames.length === 0, { frames: evilStream.frames.length });
    const healthyAfterProbes = await httpJson(portA, "GET", "/sessions");
    assert("a8_server_healthy_after_probes", healthyAfterProbes.status === 200 && healthyAfterProbes.json?.ok === true);

    /* ============== A9: HTTP-level idempotency ====================== */
    const replayCreate = await httpJson(portA, "POST", "/commands/createSession", { token: tokenA, body: createEnv });
    assert("a9_command_replay_original_receipt", replayCreate.json?.ok === true && replayCreate.json.idempotent_replay === true && replayCreate.json.result?.session_id === S1, { replay: replayCreate.json?.idempotent_replay, sid: replayCreate.json?.result?.session_id });
    const conflictCreate = await httpJson(portA, "POST", "/commands/createSession", { token: tokenA, body: { ...createEnv, payload: { workspace_id: "nw-wp09-conflict", goal: "same command_id, different payload" } } });
    assert("a9_command_conflict_http", conflictCreate.status === 200 && conflictCreate.json?.ok === false && conflictCreate.json.error?.code === "CTL_IDEMPOTENCY_CONFLICT" && conflictCreate.json.error?.details?.reason === "command_payload_mismatch", { code: conflictCreate.json?.error?.code });
    const approval2 = await httpJson(portA, "POST", "/approvals", { token: tokenA, body: approvalBody });
    assert("a9_approval_replay_idempotent", approval2.json?.ok === true && approval2.json.idempotent_replay === true, { body: approval2.json });
    const approvalAuditsAfter = A.passState.audit.list().filter((e) => e.action === "approval.register");
    assert("a9_approval_audit_not_duplicated", approvalAuditsAfter.length === 1, { count: approvalAuditsAfter.length });
    const replayPublish = await httpJson(portA, "POST", "/commands/publishIssue", { token: tokenA, body: publishEnv });
    assert("a9_publish_replay_single_write", replayPublish.json?.ok === true && replayPublish.json.idempotent_replay === true && replayPublish.json.result?.receipt?.issue_ref === receipt?.issue_ref && A.github.writeCount("createIssue") === 1, { writes: A.github.writeCount("createIssue") });
  } finally {
    /* HTTP servers force-closed no matter what (no port leaks). */
    await consoleA.close();
    await consoleB.close();
    await A.close();
    await B.close();
  }

  return { checks, failures, outputs: outputTexts };
}

/* ------------------------------------------------------------------ */
/* A7: static boundary scan (console sources + UI assets)              */
/* ------------------------------------------------------------------ */
function staticBoundaryScan() {
  const violations = [];
  const read = (rel) => readFileSync(join(HERE, rel), "utf8");

  const allowedImports = {
    "server.mjs": ["node:fs", "node:path", "node:url", "./lib/wiring.mjs", "./lib/http.mjs"],
    "lib/wiring.mjs": [
      "node:fs", "node:path", "node:url",
      "../../control/lib/index.mjs",
      "../../state/index.mjs",
      "../../registry/lib/store.mjs", "../../registry/lib/pipeline.mjs",
      "../../library/lib/store.mjs",
      "../../policy/lib/gate.mjs", "../../policy/lib/audit.mjs",
      "../../executor/lib/worker.mjs", "../../executor/lib/audit.mjs", "../../executor/lib/stub.mjs",
      "../../evidence/lib/index.mjs",
      "../../issue/lib/index.mjs",
    ],
    "lib/http.mjs": ["node:http", "node:fs", "node:crypto", "node:path", "node:url", "../../policy/lib/gate.mjs"],
  };

  for (const [rel, allowed] of Object.entries(allowedImports)) {
    const text = read(rel);
    for (const m of text.matchAll(/from\s*["']([^"']+)["']/g)) {
      if (!allowed.includes(m[1])) violations.push(`${rel}: unexpected import "${m[1]}"`);
    }
    for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!allowed.includes(m[1])) violations.push(`${rel}: unexpected dynamic import "${m[1]}"`);
    }
    /* No direct component data-plane writes from console sources; the only
     * filesystem reads are the read-only fixtures (wiring) and the fixed
     * public/ asset whitelist (http). */
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/\b(writeFileSync|appendFileSync|rmSync|unlinkSync)\s*\(/.test(line) && rel !== "server.mjs") {
        violations.push(`${rel}:${i + 1} direct write to the filesystem`);
      }
      if (/\breadFileSync\s*\(/.test(line)) {
        if (rel === "lib/wiring.mjs" && !line.includes("orchestration-fixtures.json")) violations.push(`${rel}:${i + 1} unexpected readFileSync`);
        if (rel === "lib/http.mjs" && !line.includes("publicDir")) violations.push(`${rel}:${i + 1} unexpected readFileSync`);
        if (rel === "server.mjs") violations.push(`${rel}:${i + 1} unexpected readFileSync`);
      }
    });
  }

  /* UI assets: no external URLs of any kind (no CDN, no http(s), no
   * protocol-relative src/href). */
  for (const rel of ["public/index.html", "public/assets/app.js", "public/assets/style.css"]) {
    const text = read(rel);
    if (/https?:\/\//i.test(text)) violations.push(`${rel}: external URL found`);
    if (/(\ssrc|\shref)\s*=\s*["']\/\//i.test(text)) violations.push(`${rel}: protocol-relative URL found`);
  }

  return violations;
}

/* ------------------------------------------------------------------ */
/* main: two deterministic passes + static scan + baselines + receipt  */
/* ------------------------------------------------------------------ */
async function main() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  const pass1 = await runPass("pass1");
  const pass2 = await runPass("pass2");

  const normalizeChecks = (checks) =>
    JSON.stringify(checks).replace(/"(elapsed_ms|duration_ms)":\d+(\.\d+)?/g, '"$1":<t>');
  const twoPassIdentical = normalizeChecks(pass1.checks) === normalizeChecks(pass2.checks);
  let twoPassDiff = [];
  if (!twoPassIdentical) {
    const keys = [...new Set([...Object.keys(pass1.checks), ...Object.keys(pass2.checks)])].sort();
    twoPassDiff = keys.filter((k) => normalizeChecks({ [k]: pass1.checks[k] }) !== normalizeChecks({ [k]: pass2.checks[k] }));
  }
  const checks = { ...pass2.checks };
  checks.a10_determinism = { ok: twoPassIdentical, two_pass_checks_identical: twoPassIdentical };

  /* A7: static boundary scan. */
  const violations = staticBoundaryScan();
  checks.a7_static_boundary = { ok: violations.length === 0, violations, scanned_sources: ["server.mjs", "lib/wiring.mjs", "lib/http.mjs", "public/index.html", "public/assets/app.js", "public/assets/style.css"] };

  /* A10: baseline re-runs (serial — shared .state audit stores). */
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
    ["wp08", join(REPO_ROOT, "nightwatch", "control", "verify.mjs")],
  ]) {
    const run = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000 });
    baselines[id] = run.status;
  }
  checks.a10_baselines_rerun = { ok: Object.values(baselines).every((code) => code === 0), exit_codes: baselines };

  /* A10: secret scan — delivered sources + every HTTP/SSE output captured. */
  const walkFiles = (dir, acc = []) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkFiles(p, acc);
      else acc.push(p);
    }
    return acc;
  };
  const sourceFiles = [...walkFiles(join(HERE, "lib")), ...walkFiles(join(HERE, "public")), join(HERE, "server.mjs"), join(HERE, "verify.mjs")];
  const sourceScan = [];
  for (const p of sourceFiles) {
    for (const hit of scanText(readFileSync(p, "utf8"))) sourceScan.push({ file: relative(REPO_ROOT, p), ...hit });
  }
  const outputScan = [];
  for (const text of [...pass1.outputs, ...pass2.outputs]) {
    for (const hit of scanText(text)) outputScan.push({ surface: "http/sse-output", ...hit });
  }
  checks.a10_secret_scan = { ok: sourceScan.length === 0 && outputScan.length === 0, source_hits: sourceScan, output_hits: outputScan, scanned_files: sourceFiles.length, scanned_outputs: pass1.outputs.length + pass2.outputs.length };

  const ok = pass1.failures.length === 0 && pass2.failures.length === 0 && twoPassIdentical &&
    violations.length === 0 && sourceScan.length === 0 && outputScan.length === 0 &&
    checks.a10_baselines_rerun.ok;

  const receipt = {
    ok,
    finished_at: new Date().toISOString(),
    verifier: "nightwatch/console/verify.mjs",
    task_fingerprint: TASK_FINGERPRINT,
    checks,
    stats: {
      pass1_failures: pass1.failures,
      pass2_failures: pass2.failures,
      deployments_per_pass: 2,
      http_outputs_scanned: pass1.outputs.length + pass2.outputs.length,
    },
    secret_scan: { source_hits: sourceScan, output_hits: outputScan, scanned_files: sourceFiles.length },
    artifacts: {
      receipt: relative(REPO_ROOT, RECEIPT_PATH),
      runtime_state: "nightwatch/console/.state (deleted on completion)",
      ui_entrypoint: "node nightwatch/console/server.mjs (token printed to stderr)",
    },
    notes: [
      "Frozen error mapping: transport auth failures → HTTP 401 + CTL_UNAUTHORIZED envelope; unknown routes/ids and malformed bodies → 404/405/400 + CTL_VALIDATION_FAILED envelope; every ControlApi/component business error → HTTP 200 + {ok:false,error} passed through verbatim",
      "SSE frame format frozen as: event: <name> | id: <event_id> | data: {name,event}; history() replay precedes live subscribe on every connection",
      "POST /approvals audits through the WP-03 public API with idempotency key = scope + approved_at (timestamp taken from the record, so identical retries replay)",
      "console deployments audit into their own isolated WP-03 store dir (never the shared nightwatch/state/.store)",
    ],
  };

  const receiptText = JSON.stringify(receipt);
  const receiptLeaks = SECRET_PATTERNS.filter(([, re]) => re.test(receiptText));
  if (receiptLeaks.length > 0) {
    receipt.ok = false;
    receipt.secret_scan.source_hits.push({ file: "receipt(self)", pattern: String(receiptLeaks[0][0]) });
  }

  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

  rmSync(STATE_DIR, { recursive: true, force: true });

  console.log("=== NightWatch WP-09 Console Experience Verification ===");
  for (const id of Object.keys(checks).sort()) {
    const label = id.padEnd(44, " ");
    const extra = checks[id] && Object.keys(checks[id]).length > 1
      ? ` (${Object.entries(checks[id]).filter(([k]) => k !== "ok").slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")})`
      : "";
    console.log(`${label} : ${checks[id]?.ok ? "ok" : "FAIL"}${extra}`);
  }
  console.log(`baselines (wp00..wp08)                          : ${Object.values(baselines).join("/")}`);
  if (twoPassDiff.length > 0) console.log(`two-pass divergent checks: ${twoPassDiff.join(", ")}`);
  if (violations.length > 0) for (const v of violations) console.log(`boundary violation: ${v}`);
  console.log(`receipt: ${relative(REPO_ROOT, RECEIPT_PATH)}`);
  process.exit(receipt.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("verify crashed:", err);
  rmSync(STATE_DIR, { recursive: true, force: true });
  process.exit(1);
});
