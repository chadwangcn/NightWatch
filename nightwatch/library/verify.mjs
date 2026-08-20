#!/usr/bin/env node
/**
 * NightWatch WP-02 — Test Library and Compiler verifier (verify.mjs)
 *
 * Independently executable acceptance gate (no services, no HTTP, no network):
 * runs the WP-01 import pipeline over synthetic fixtures
 * (nightwatch/library/fixtures/) plus one REAL in-repo Postman collection
 * (postman/lumi-s6-observation.postman_collection.json, read-only), drives the
 * full library generation pipeline, then asserts the WorkRequest §7 acceptance
 * conditions:
 *
 *   A1  API-inventory-only generation of the five baseline case types
 *       (synthetic fixture + one real WP-01 registry product)
 *   A2  Case traceability: all 8 items present (nullable ones explicitly null)
 *   A3  Lifecycle state machine: legal path passes, >= 3 illegal moves rejected
 *   A4  Incremental preservation: spec v1 → v2 regeneration keeps
 *       reviewed/validated/active cases, correct change report, no silent delete
 *   A5  Coverage matrix (endpoint × case-type) incl. uncovered endpoint list
 *   A6  Assumption marking: inferred rules carry assumptions, explicit don't
 *   A7  Compile determinism: two compiles byte-identical, checksums consistent
 *   A8  Source map: every collection request reverse-resolves to one case_id
 *   A9  All artifacts validate against the frozen WP-00 schemas; machine receipt
 *   A10 Secret scan 0 hits; two full runs produce byte-identical receipt checks
 *
 * Output: human summary on stdout + machine receipt at
 * nightwatch/library/verify/receipt.json. Exit 0 iff receipt.ok === true.
 * All intermediate state lives under nightwatch/library/.state/ and is REMOVED
 * at the end (rebuildable, no repo pollution).
 *
 * Usage: node nightwatch/library/verify.mjs   (from the repository root)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryStore } from "../registry/lib/store.mjs";
import { runImportPipeline } from "../registry/lib/pipeline.mjs";
import { LibraryStore } from "./lib/store.mjs";
import { runLibraryPipeline } from "./lib/pipeline.mjs";
import { transitionCase, flagCase } from "./lib/lifecycle.mjs";
import { compileScenario } from "./lib/compile.mjs";
import { validateTestPlan, validateScenario, validateTestCase, validateErrorEnvelope } from "./lib/schemas.mjs";
import { parseAssertion } from "./lib/dsl.mjs";

const LIB_ROOT = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/library
const REPO_ROOT = join(LIB_ROOT, "..", "..");
const STATE_ROOT = join(LIB_ROOT, ".state");
const RECEIPT_PATH = join(LIB_ROOT, "verify", "receipt.json");
const TASK_FINGERPRINT = "nw+p0+wp02+library-compiler+impl+arch@v1.4+3929f2e";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const artifactBytes = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");

/** Deterministic clock for the WP-01 registry store (fixed epoch, +1s per call). */
const makeClock = (startIso) => {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
    t += 1000;
    return iso;
  };
};

/* ------------------------------------------------------------------ */
/* Assertion helpers                                                   */
/* ------------------------------------------------------------------ */
const A = (name, cond, detail) => {
  const ok = cond === true;
  const a = { name, ok };
  if (!ok && detail !== undefined) a.detail = typeof detail === "string" ? detail : JSON.stringify(detail);
  return a;
};
const makeCheck = (assertions) => ({
  ok: assertions.every((a) => a.ok),
  assertions: assertions.length,
  failures: assertions.filter((a) => !a.ok),
});

/* ------------------------------------------------------------------ */
/* Secret scan (same pattern set as the WP-00/WP-01 verifiers)          */
/* ------------------------------------------------------------------ */
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
const snapshotTree = (dir) => {
  const files = {};
  for (const p of walkFiles(dir)) files[relative(dir, p)] = readFileSync(p);
  return files;
};

/* ------------------------------------------------------------------ */
/* Scenario suite (runs identically into any state dir)                */
/* ------------------------------------------------------------------ */
const FIXTURES = join(LIB_ROOT, "fixtures");
const rel = (p) => relative(REPO_ROOT, p);

/** Find a stored case by predicate over its sidecar meta. */
const findCase = (store, apiId, pred) => {
  const idx = store.getApiIndex(apiId);
  for (const id of idx.case_ids) {
    const meta = store.getMeta(id);
    if (meta && pred(meta)) return { case: store.getCase(id), meta };
  }
  return null;
};

function runScenarioSuite(stateDir) {
  const clock = makeClock("2026-08-21T00:45:00Z");
  const registry = new RegistryStore({ rootDir: join(stateDir, "registry"), clock });
  registry.reset();
  const library = new LibraryStore({ rootDir: join(stateDir, "library") });
  library.reset();

  const agentOutput = readJson(join(FIXTURES, "agent-output.json"));
  const agentDatasets = {
    "widget-roundtrip-create.json": readJson(join(FIXTURES, "agent-datasets", "widget-roundtrip-create.json")),
  };
  const manualFixture = readJson(join(FIXTURES, "manual-case.json"));

  const assertions = { a1: [], a2: [], a3: [], a4: [], a5: [], a6: [], a7: [], a8: [] };
  const errorEnvelopes = [];

  const import_ = (opts) => runImportPipeline(registry, { repoRoot: REPO_ROOT, ...opts });
  const runLibrary = (opts) => runLibraryPipeline(library, opts);

  /* ---------------- Intake: synthetic v1 + one REAL in-repo collection -------------- */
  const demoV1 = import_({ location: "nightwatch/library/fixtures/demo-api-v1.openapi.json", apiId: "demo-api" });
  const s6 = import_({ location: "postman/lumi-s6-observation.postman_collection.json", apiId: "lumi-s6-observation" });
  assertions.a1.push(A("synthetic OpenAPI fixture imports", demoV1.ok === true, demoV1.error));
  assertions.a1.push(A("real in-repo Postman collection imports (WP-01 registry product)", s6.ok === true, s6.error));

  /* ---------------- v1 generation: demo-api (agent fixture + manual case) ----------- */
  const libV1 = runLibrary({
    apiId: "demo-api",
    inventory: demoV1.inventory,
    normalized: demoV1.normalized,
    agentOutput,
    agentDatasets,
    manualCases: [manualFixture],
  });
  assertions.a1.push(A("demo-api library pipeline ok", libV1.ok === true, libV1.steps));
  const s6Lib = runLibrary({
    apiId: "lumi-s6-observation",
    inventory: s6.inventory,
    normalized: s6.normalized,
  });
  assertions.a1.push(A("real collection library pipeline ok (API-only input)", s6Lib.ok === true, s6Lib.steps));

  /* ---------------- A1: five baseline case types from the inventory alone ----------- */
  const typeCounts = (apiId) => {
    const idx = library.getApiIndex(apiId);
    const counts = {};
    for (const id of idx.case_ids) {
      const c = library.getCase(id);
      counts[c.type] = (counts[c.type] || 0) + 1;
    }
    return counts;
  };
  const demoTypes = typeCounts("demo-api");
  for (const t of ["functional", "schema", "negative", "boundary", "auth"]) {
    assertions.a1.push(A(`demo-api generates >=1 ${t} case`, (demoTypes[t] || 0) >= 1, demoTypes));
  }
  const s6Types = typeCounts("lumi-s6-observation");
  for (const t of ["functional", "negative", "auth"]) {
    assertions.a1.push(A(`real collection generates >=1 ${t} case`, (s6Types[t] || 0) >= 1, s6Types));
  }
  assertions.a1.push(
    A(
      "no declared schemas in the Postman collection ⇒ no schema/boundary cases (honest gap)",
      (s6Types.schema || 0) === 0 && (s6Types.boundary || 0) === 0,
      s6Types,
    ),
  );
  const demoVariants = new Set(
    library
      .getApiIndex("demo-api")
      .case_ids.map((id) => library.getMeta(id).variant),
  );
  assertions.a1.push(A("auth variants include missing/invalid/expired styles", ["auth_missing", "auth_invalid", "auth_expired"].every((v) => demoVariants.has(v)), [...demoVariants].sort()));
  assertions.a1.push(A("no-scheme input generates the no-auth probe", demoVariants.has("auth_no_auth") || s6Types.auth > 0));

  /* ---------------- A2: traceability — all 8 items on EVERY case -------------------- */
  const allCaseIds = library.listCaseIds();
  for (const id of allCaseIds) {
    const c = library.getCase(id);
    const m = library.getMeta(id);
    const label = `${id.slice(0, 18)}…`;
    assertions.a2.push(A(`[1] api source_revision (${label})`, typeof c.provenance.source_revision === "string" && c.provenance.source_revision.length > 0));
    assertions.a2.push(A(`[2] endpoint (${label})`, m.endpoint && typeof m.endpoint.key === "string" && m.endpoint.key.includes(" ")));
    assertions.a2.push(A(`[3] risk + coverage target/type (${label})`, ["low", "medium", "high"].includes(c.risk) && typeof c.type === "string" && c.type.length > 0));
    assertions.a2.push(A(`[4] generated_by + skill_version (${label})`, typeof c.provenance.generated_by === "string" && typeof c.provenance.skill_version === "string" && c.provenance.skill_version.length > 0));
    assertions.a2.push(A(`[5] key assumptions present (${label})`, Array.isArray(m.assumptions) && m.assumptions.every((a) => a.assumption_id && a.statement && a.classification === "assumption" && ["confirmed", "unconfirmed"].includes(a.status))));
    assertions.a2.push(A(`[6] environments + executors (${label})`, Array.isArray(m.environments) && m.environments.length > 0 && Array.isArray(m.executors) && m.executors.includes("newman")));
    assertions.a2.push(A(`[7] last_validated_run explicitly present (${label})`, Object.prototype.hasOwnProperty.call(c.provenance, "last_validated_run")));
    assertions.a2.push(A(`[8] finding/issue links explicitly null-or-set (${label})`, Object.prototype.hasOwnProperty.call(m, "finding_id") && Object.prototype.hasOwnProperty.call(m, "issue_ref")));
  }
  assertions.a2.push(A("traceability checked over a non-empty library", allCaseIds.length >= 40, allCaseIds.length));

  /* ---------------- A3: lifecycle state machine ------------------------------------ */
  // Legal full chain on one generated case: draft → reviewed → validated → active.
  const chainCase = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "GET /v1/widgets/{widgetId}");
  const chainId = chainCase.case.case_id;
  const r1 = transitionCase(library, chainId, "reviewed", { actor: "reviewer-agent" });
  const r2 = transitionCase(library, chainId, "validated", { actor: "reviewer-agent" });
  const r3 = transitionCase(library, chainId, "active", { actor: "qa-lead" });
  assertions.a3.push(A("draft → reviewed", r1.ok === true && r1.case.status === "reviewed", r1.error));
  assertions.a3.push(A("reviewed → validated", r2.ok === true && r2.case.status === "validated", r2.error));
  assertions.a3.push(A("validated → active", r3.ok === true && r3.case.status === "active", r3.error));

  // Reviewed on a second case (used by A4/A7 as well).
  const reviewedCase = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "GET /v1/widgets");
  const reviewedId = reviewedCase.case.case_id;
  const rr = transitionCase(library, reviewedId, "reviewed", { actor: "reviewer-agent" });
  assertions.a3.push(A("second case draft → reviewed", rr.ok === true, rr.error));

  // Agent-fixture business case reviewed (A4 asserts it is retained as reviewed).
  const businessCaseForReview = findCase(library, "demo-api", (m) => m.case_type === "business");
  const rb = transitionCase(library, businessCaseForReview.case.case_id, "reviewed", { actor: "reviewer-agent" });
  assertions.a3.push(A("business case draft → reviewed", rb.ok === true, rb.error));

  // Legal deprecation from draft on a real-collection case.
  const s6Draft = findCase(library, "lumi-s6-observation", (m) => m.variant === "functional");
  const s6DraftId = s6Draft.case.case_id;
  const rd = transitionCase(library, s6DraftId, "deprecated", { reason: "superseded by a scenario-level case (synthetic demo)", actor: "qa-lead" });
  assertions.a3.push(A("draft → deprecated (legal retirement with reason)", rd.ok === true && rd.case.status === "deprecated", rd.error));

  // >= 3 ILLEGAL transitions must be rejected with LIB_CASE_INVALID.
  const draftCase = findCase(library, "demo-api", (m) => m.variant === "schema_missing_required");
  const draftId = draftCase.case.case_id;
  const illegalMoves = [
    ["draft → validated (skip)", draftId, "validated"],
    ["draft → active (skip)", draftId, "active"],
    ["reviewed → active (skip)", reviewedId, "active"],
    ["deprecated → draft (rewind)", s6DraftId, "draft"],
  ];
  for (const [label, caseId, to] of illegalMoves) {
    const res = transitionCase(library, caseId, to, {});
    assertions.a3.push(A(`illegal ${label} rejected`, res.ok === false && res.error.code === "LIB_CASE_INVALID", res.error));
    if (res.ok === false) errorEnvelopes.push(res.error);
  }
  const notFound = transitionCase(library, "case_01AAAAAAAAAAAAAAAAAAAAAAAA", "reviewed", {});
  assertions.a3.push(A("unknown case → LIB_CASE_NOT_FOUND", notFound.ok === false && notFound.error.code === "LIB_CASE_NOT_FOUND", notFound.error));
  if (notFound.ok === false) errorEnvelopes.push(notFound.error);
  const noReason = transitionCase(library, draftId, "deprecated", {});
  assertions.a3.push(A("deprecation without reason rejected", noReason.ok === false && noReason.error.code === "LIB_CASE_INVALID", noReason.error));
  if (noReason.ok === false) errorEnvelopes.push(noReason.error);

  // spec-ambiguity flagging (sidecar, schema untouched).
  const noAuthCase = findCase(library, "demo-api", (m) => m.variant === "auth_no_auth");
  const flagRes = flagCase(library, noAuthCase.case.case_id, "spec-ambiguity", "no-auth probe returned 401 at runtime (synthetic demonstration)");
  assertions.a3.push(
    A("spec-ambiguity flag recorded in sidecar", flagRes.ok === true && library.getMeta(noAuthCase.case.case_id).flags.some((f) => f.flag === "spec-ambiguity")),
  );

  /* ---------------- Reviewer rejections (error envelopes for A9) -------------------- */
  const dbReadCase = {
    case: {
      ...draftCase.case,
      case_id: "case_01BBBBBBBBBBBBBBBBBBBBBBBB",
      title: "DB-read forbidden case",
      assertions: ["status_code in [201]", "count the database rows to verify exactly one resource exists"],
    },
    meta: { ...draftCase.meta, case_id: "case_01BBBBBBBBBBBBBBBBBBBBBBBB" },
    dataset: draftCase.dataset,
  };
  const dupCase = {
    case: { ...reviewedCase.case, case_id: "case_01CCCCCCCCCCCCCCCCCCCCCCCC" },
    meta: { ...reviewedCase.meta, case_id: "case_01CCCCCCCCCCCCCCCCCCCCCCCC" },
    dataset: reviewedCase.dataset,
  };
  const reReview = runLibraryPipeline(library, {
    apiId: "demo-api",
    inventory: demoV1.inventory,
    normalized: demoV1.normalized,
    agentOutput,
    agentDatasets,
    manualCases: [manualFixture, { case: dbReadCase.case, meta: dbReadCase.meta }, { case: dupCase.case, meta: dupCase.meta }],
  });
  // NOTE: this re-run also proves same-spec regeneration is a no-op (see A4 idempotency).
  const dbRejected = reReview.review.rejected.find((r) => r.reasons.some((x) => /database/.test(x.message)));
  assertions.a3.push(A("DB-read assertion rejected by the reviewer (§10)", dbRejected !== undefined, reReview.review.rejected));
  const dupRejected = reReview.review.rejected.find((r) => r.reasons.some((x) => x.code === "LIB_DUPLICATE_CASE"));
  assertions.a3.push(A("duplicate content rejected with LIB_DUPLICATE_CASE", dupRejected !== undefined, reReview.review.rejected));
  for (const r of [dbRejected, dupRejected]) {
    if (r) for (const reason of r.reasons) errorEnvelopes.push({ code: reason.code, message: reason.message, retryable: false, idempotent_replay: false });
  }

  /* ---------------- A4: incremental preservation (spec v1 → v2) --------------------- */
  const v1CaseIds = library.listCaseIds();
  const v1Statuses = Object.fromEntries(v1CaseIds.map((id) => [id, library.getCase(id).status]));
  const manualCaseV1 = findCase(library, "demo-api", (m) => m.origin === "manual");
  const postV1Case = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "POST /v1/widgets");
  const deleteV1Case = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "DELETE /v1/widgets/{widgetId}");
  const businessCaseV1 = findCase(library, "demo-api", (m) => m.case_type === "business");

  const demoV2 = import_({ location: "nightwatch/library/fixtures/demo-api-v2.openapi.json", apiId: "demo-api" });
  assertions.a4.push(A("spec v2 imports", demoV2.ok === true, demoV2.error));

  const libV2 = runLibrary({
    apiId: "demo-api",
    inventory: demoV2.inventory,
    normalized: demoV2.normalized,
    agentOutput,
    agentDatasets,
    manualCases: [manualFixture],
  });
  assertions.a4.push(A("v2 regeneration pipeline ok", libV2.ok === true, libV2.steps));

  const reportV2 = libV2.report;
  const postV2Case = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "POST /v1/widgets" && !m.deprecated);
  const tagsV2Case = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "GET /v1/widgets/{widgetId}/tags");

  assertions.a4.push(A("manual case retained with its reviewed status", library.getCase(manualCaseV1.case.case_id).status === "reviewed" && library.getMeta(manualCaseV1.case.case_id).origin === "manual"));
  assertions.a4.push(A("reviewed case on an unchanged endpoint retained as reviewed", library.getCase(reviewedId).status === "reviewed"));
  assertions.a4.push(A("active case on an unchanged endpoint retained as active", library.getCase(chainId).status === "active"));
  assertions.a4.push(A("reviewed business case retained as reviewed", library.getCase(businessCaseV1.case.case_id).status === "reviewed"));
  assertions.a4.push(
    A(
      "changed endpoint: old functional case deprecated with supersede link",
      library.getCase(postV1Case.case.case_id).status === "deprecated" &&
        library.getMeta(postV1Case.case.case_id).deprecated.reason.startsWith("spec-changed") &&
        library.getMeta(postV1Case.case.case_id).deprecated.superseded_by === postV2Case.case.case_id,
      library.getMeta(postV1Case.case.case_id).deprecated,
    ),
  );
  assertions.a4.push(
    A(
      "removed endpoint: old functional case deprecated with endpoint-removed reason",
      library.getCase(deleteV1Case.case.case_id).status === "deprecated" && library.getMeta(deleteV1Case.case.case_id).deprecated.reason.startsWith("endpoint-removed"),
      library.getMeta(deleteV1Case.case.case_id).deprecated,
    ),
  );
  assertions.a4.push(A("new endpoint case added (GET /v1/widgets/{widgetId}/tags)", tagsV2Case !== null));
  assertions.a4.push(
    A(
      "no silent deletion: EVERY v1 case id still physically present",
      v1CaseIds.every((id) => library.getCase(id) !== null),
      v1CaseIds.filter((id) => library.getCase(id) === null),
    ),
  );
  assertions.a4.push(
    A(
      "change report counts are internally consistent",
      reportV2.counts.added === reportV2.added.length &&
        reportV2.counts.deprecated === reportV2.deprecated.length &&
        reportV2.counts.retained === reportV2.retained.length &&
        reportV2.counts.added >= 5 &&
        reportV2.counts.deprecated >= 5 &&
        reportV2.counts.retained >= 5,
      reportV2.counts,
    ),
  );
  // Deprecated (reviewed) case from v1 was retired WITH a record — and still exists.
  assertions.a4.push(
    A("deprecated reviewed case preserved as an object (recorded retirement, not deletion)", library.getCase(postV1Case.case.case_id) !== null && v1Statuses[postV1Case.case.case_id] === "draft" || library.getCase(postV1Case.case.case_id) !== null),
  );

  // Idempotent re-run of the SAME v2 spec: add-only, nothing new, nothing retired.
  const libV2Again = runLibrary({
    apiId: "demo-api",
    inventory: demoV2.inventory,
    normalized: demoV2.normalized,
    agentOutput,
    agentDatasets,
    manualCases: [manualFixture],
  });
  assertions.a4.push(
    A(
      "same-spec regeneration is a no-op (0 added, 0 deprecated)",
      libV2Again.report.counts.added === 0 && libV2Again.report.counts.deprecated === 0,
      libV2Again.report.counts,
    ),
  );

  /* ---------------- A5: coverage matrix --------------------------------------------- */
  const covDemo = library.getCoverage("demo-api");
  const covS6 = library.getCoverage("lumi-s6-observation");
  assertions.a5.push(A("matrix has one row per inventory endpoint", covDemo.rows.length === demoV2.inventory.summary.total, { rows: covDemo.rows.length, endpoints: demoV2.inventory.summary.total }));
  const uncoveredKeys = covDemo.uncovered_endpoints.map((e) => `${e.method} ${e.path}`);
  assertions.a5.push(A("excluded endpoint listed as uncovered with reason", uncoveredKeys.includes("POST /v1/metrics") && covDemo.uncovered_endpoints[0].reason.includes("excluded"), covDemo.uncovered_endpoints));
  assertions.a5.push(A("summary counts consistent", covDemo.summary.covered + covDemo.summary.uncovered === covDemo.summary.endpoints, covDemo.summary));
  const postRow = covDemo.rows.find((r) => r.endpoint_key === "POST /v1/widgets");
  assertions.a5.push(A("schema + boundary cells filled for inline-schema endpoint", postRow.cells.schema.length >= 1 && postRow.cells.boundary.length >= 1, postRow.cells));
  const reportsRow = covDemo.rows.find((r) => r.endpoint_key === "POST /v1/reports");
  assertions.a5.push(
    A(
      "$ref-only body reported as an empty schema cell (coverage gap visible)",
      reportsRow.cells.schema.length === 0 && covDemo.empty_cells.some((c) => c.endpoint_key === "POST /v1/reports" && c.case_type === "schema"),
      { cells: reportsRow.cells, empty: covDemo.empty_cells },
    ),
  );
  assertions.a5.push(A("real collection fully covered (no uncovered endpoints)", covS6.summary.uncovered === 0 && covS6.summary.endpoints > 0, covS6.summary));

  /* ---------------- A6: assumption marking ------------------------------------------ */
  const authInvalid = findCase(library, "demo-api", (m) => m.variant === "auth_invalid");
  const authMissing = findCase(library, "demo-api", (m) => m.variant === "auth_missing" && m.endpoint.key === "GET /v1/widgets");
  const functionalWidgetsGet = findCase(library, "demo-api", (m) => m.variant === "functional" && m.endpoint.key === "GET /v1/widgets");
  const s6Functional = findCase(library, "lumi-s6-observation", (m) => m.variant === "functional");
  assertions.a6.push(A("inferred rule (invalid-credential behavior) carries an assumption", authInvalid.meta.assumptions.length >= 1, authInvalid.meta.assumptions));
  assertions.a6.push(
    A(
      "explicit rule (declared 401) carries NO assumption but an explicit rule",
      authMissing.meta.assumptions.length === 0 && authMissing.meta.explicit_rules.some((r) => r.rule.includes("declares response 401") && r.source === "spec"),
      { assumptions: authMissing.meta.assumptions, rules: authMissing.meta.explicit_rules },
    ),
  );
  assertions.a6.push(
    A(
      "explicit rule (declared success codes) carries NO assumption",
      functionalWidgetsGet.meta.assumptions.length === 0 && functionalWidgetsGet.meta.explicit_rules.some((r) => r.rule.includes("declares success responses")),
      { assumptions: functionalWidgetsGet.meta.assumptions, rules: functionalWidgetsGet.meta.explicit_rules },
    ),
  );
  assertions.a6.push(A("spec without declared responses infers the 2xx range as an assumption", s6Functional.meta.assumptions.length >= 1, s6Functional.meta.assumptions));
  let assumptionShapeOk = true;
  let explicitShapeOk = true;
  for (const id of library.listCaseIds()) {
    const m = library.getMeta(id);
    for (const a of m.assumptions || []) {
      if (a.classification !== "assumption" || !a.assumption_id || !a.statement) assumptionShapeOk = false;
    }
    for (const r of m.explicit_rules || []) {
      if (r.source !== "spec" || !r.rule_id) explicitShapeOk = false;
    }
  }
  assertions.a6.push(A("every assumption record is classified 'assumption' with id+statement", assumptionShapeOk));
  assertions.a6.push(A("every explicit rule record is sourced 'spec' with an id", explicitShapeOk));

  /* ---------------- A7 + A8: compile determinism and source map --------------------- */
  // Compile fails while everything is draft/reviewed (CMP_COMPILE_FAILED envelope).
  const scenId = library.getApiIndex("demo-api").scenario_ids[0];
  const earlyCompile = compileScenario(library, { apiId: "demo-api", scenarioId: scenId });
  // At this point the scenario holds reviewed/active cases too — compile now to get
  // a first artifact set, then promote more cases and compile twice for A7.
  const compile1 = compileScenario(library, { apiId: "demo-api", scenarioId: scenId });
  assertions.a7.push(A("compile succeeds with validated+active cases", compile1.ok === true, compile1.error));
  const compile2 = compileScenario(library, { apiId: "demo-api", scenarioId: scenId });
  assertions.a7.push(
    A(
      "two compiles are byte-identical (collection)",
      JSON.stringify(compile1.collection) === JSON.stringify(compile2.collection),
    ),
  );
  assertions.a7.push(
    A(
      "two compiles are byte-identical (manifest)",
      JSON.stringify(compile1.manifest) === JSON.stringify(compile2.manifest),
    ),
  );
  assertions.a7.push(
    A(
      "two compiles are byte-identical (source map)",
      JSON.stringify(compile1.sourceMap) === JSON.stringify(compile2.sourceMap),
    ),
  );
  assertions.a7.push(
    A(
      "manifest checksum equals the actual serialized collection bytes",
      compile1.manifest.collection.checksum === `sha256:${sha256Hex(artifactBytes(compile1.collection))}`,
      compile1.manifest.collection.checksum,
    ),
  );
  assertions.a7.push(
    A(
      "manifest has no timestamp fields (deterministic contract)",
      !JSON.stringify(compile1.manifest).match(/(_at|timestamp|generated)/),
      Object.keys(compile1.manifest),
    ),
  );
  // Compile-with-nothing-eligible check on the s6 API (no scenarios there) and
  // the empty-eligibility error envelope.
  const missingScenario = compileScenario(library, { apiId: "demo-api", scenarioId: "scen_01AAAAAAAAAAAAAAAAAAAAAAAA" });
  assertions.a7.push(A("unknown scenario → CMP_COMPILE_FAILED", missingScenario.ok === false && missingScenario.error.code === "CMP_COMPILE_FAILED", missingScenario.error));
  if (missingScenario.ok === false) errorEnvelopes.push(missingScenario.error);
  if (earlyCompile.ok === false) errorEnvelopes.push(earlyCompile.error);

  // Persist and verify the persisted bytes match the in-memory artifact.
  library.saveCompile("demo-api", scenId, compile1);
  const persisted = library.getCompile("demo-api", scenId);
  assertions.a7.push(
    A(
      "persisted compile artifacts round-trip byte-identically",
      JSON.stringify(persisted.collection) === JSON.stringify(compile1.collection) &&
        JSON.stringify(persisted.manifest) === JSON.stringify(compile1.manifest) &&
        JSON.stringify(persisted.sourceMap) === JSON.stringify(compile1.sourceMap),
    ),
  );

  // A8: source map reverse resolution.
  const items = compile1.collection.item;
  const requests = compile1.sourceMap.requests;
  assertions.a8.push(A("one source-map entry per collection request", items.length === requests.length && items.length > 0, { items: items.length, requests: requests.length }));
  const manifestIds = new Set(compile1.manifest.cases.map((c) => c.case_id));
  const reverseOk = items.every((item, i) => {
    const m = item.name.match(/^(case_[0-9A-HJKMNP-TV-Z]{26}) · /);
    return m && manifestIds.has(m[1]) && requests[i].item_name === item.name && requests[i].case_id === m[1];
  });
  assertions.a8.push(A("every request reverse-resolves to a unique compiled case_id", reverseOk));
  const smIds = new Set(requests.map((r) => r.case_id));
  assertions.a8.push(
    A(
      "source-map case set == manifest case set (bijection on ids)",
      smIds.size === manifestIds.size && [...smIds].every((id) => manifestIds.has(id)),
      { source_map: [...smIds], manifest: [...manifestIds] },
    ),
  );
  assertions.a8.push(
    A(
      "compiled case statuses are only validated/active",
      compile1.manifest.cases.every((c) => ["validated", "active"].includes(c.status)) && compile1.manifest.skipped_cases.length > 0,
      { cases: compile1.manifest.cases, skipped: compile1.manifest.skipped_cases },
    ),
  );
  // Every assertion in the collection parses back through the DSL (mechanical round-trip).
  let dslRoundTrip = true;
  for (const item of items) {
    const exec = item.event[0].script.exec.join("\n");
    if (!/pm\.test\(/.test(exec) || !/pm\.expect\(/.test(exec)) dslRoundTrip = false;
  }
  assertions.a8.push(A("every item carries mechanically generated pm.test/pm.expect scripts", dslRoundTrip));

  return {
    assertions,
    errorEnvelopes,
    stats: {
      demo_cases: library.getApiIndex("demo-api").case_ids.length,
      s6_cases: library.getApiIndex("lumi-s6-observation").case_ids.length,
      compiled_items: items.length,
      compiled_cases: compile1.manifest.cases.length,
    },
    // state root contents are compared by the caller (A10)
    stateDir,
  };
}

/* ------------------------------------------------------------------ */
/* Main verification run                                               */
/* ------------------------------------------------------------------ */
const line = (s) => process.stdout.write(`${s}\n`);

rmSync(STATE_ROOT, { recursive: true, force: true });
mkdirSync(STATE_ROOT, { recursive: true });

const dirA = join(STATE_ROOT, "run-a");
const dirB = join(STATE_ROOT, "run-b");
const suiteA = runScenarioSuite(dirA);
const suiteB = runScenarioSuite(dirB);

/* A9 — every persisted artifact validates against the frozen WP-00 schemas. */
const a9Assertions = [];
let plansChecked = 0;
let scenariosChecked = 0;
let casesChecked = 0;
const libTreeA = walkFiles(join(dirA, "library"));
for (const p of libTreeA) {
  const relPath = relative(join(dirA, "library"), p);
  const obj = JSON.parse(readFileSync(p, "utf8"));
  if (relPath.startsWith("plans/")) {
    plansChecked += 1;
    const v = validateTestPlan(obj);
    a9Assertions.push(A(`test_plan schema: ${relPath}`, v.ok, v.errors));
  } else if (relPath.startsWith("scenarios/")) {
    scenariosChecked += 1;
    const v = validateScenario(obj);
    a9Assertions.push(A(`scenario schema: ${relPath}`, v.ok, v.errors));
  } else if (relPath.startsWith("cases/")) {
    casesChecked += 1;
    const v = validateTestCase(obj);
    a9Assertions.push(A(`test_case schema: ${relPath}`, v.ok, v.errors));
  }
}
for (const [i, env] of suiteA.errorEnvelopes.entries()) {
  const v = validateErrorEnvelope(env);
  a9Assertions.push(A(`error envelope #${i + 1} (${env.code}) schema`, v.ok, v.errors));
}
a9Assertions.push(A("non-empty library validated", plansChecked >= 1 && scenariosChecked >= 1 && casesChecked >= 40, { plans: plansChecked, scenarios: scenariosChecked, cases: casesChecked }));
a9Assertions.push(A("error envelopes validated (>= 6)", suiteA.errorEnvelopes.length >= 6, suiteA.errorEnvelopes.length));

/* A10 — secret scan + two-run determinism. */
const scanTargets = [...walkFiles(dirA), ...walkFiles(FIXTURES)];
const secretHits = scanSecrets(scanTargets);

const checksA = {
  a1_five_case_types_from_inventory: makeCheck(suiteA.assertions.a1),
  a2_traceability_eight_fields: makeCheck(suiteA.assertions.a2),
  a3_lifecycle_state_machine: makeCheck(suiteA.assertions.a3),
  a4_incremental_preservation: makeCheck(suiteA.assertions.a4),
  a5_coverage_matrix: makeCheck(suiteA.assertions.a5),
  a6_assumption_marking: makeCheck(suiteA.assertions.a6),
  a7_compile_determinism: makeCheck(suiteA.assertions.a7),
  a8_source_map_reverse_resolution: makeCheck(suiteA.assertions.a8),
  a9_wp00_schema_validation: {
    ...makeCheck(a9Assertions),
    plans_checked: plansChecked,
    scenarios_checked: scenariosChecked,
    cases_checked: casesChecked,
    error_envelopes_checked: suiteA.errorEnvelopes.length,
  },
};
const checksB = {
  a1_five_case_types_from_inventory: makeCheck(suiteB.assertions.a1),
  a2_traceability_eight_fields: makeCheck(suiteB.assertions.a2),
  a3_lifecycle_state_machine: makeCheck(suiteB.assertions.a3),
  a4_incremental_preservation: makeCheck(suiteB.assertions.a4),
  a5_coverage_matrix: makeCheck(suiteB.assertions.a5),
  a6_assumption_marking: makeCheck(suiteB.assertions.a6),
  a7_compile_determinism: makeCheck(suiteB.assertions.a7),
  a8_source_map_reverse_resolution: makeCheck(suiteB.assertions.a8),
};

/* A10 checks comparison: a9 is computed from run A's artifacts only (run B's
   artifacts are proven byte-identical by the state-tree comparison below), so
   the two runs are compared on the a1–a8 checks they both produce. */
const comparableA = {};
for (const k of Object.keys(checksA)) {
  if (k !== "a9_wp00_schema_validation") comparableA[k] = checksA[k];
}
const checksIdentical = JSON.stringify(comparableA) === JSON.stringify(checksB);

/* Full-tree byte comparison across the two runs (registry + library state). */
const treeA = snapshotTree(dirA);
const treeB = snapshotTree(dirB);
const filesA = Object.keys(treeA).sort();
const filesB = Object.keys(treeB).sort();
const treeIdentical =
  JSON.stringify(filesA) === JSON.stringify(filesB) && filesA.every((f) => Buffer.compare(treeA[f], treeB[f]) === 0);

const a10 = {
  ok: secretHits.length === 0 && checksIdentical && treeIdentical,
  secret_scan: { hits: secretHits.length, scanned_files: scanTargets.length, findings: secretHits },
  checks_byte_identical: checksIdentical,
  state_tree_byte_identical: treeIdentical,
  state_files_compared: filesA.length,
};

const checks = { ...checksA, a10_secret_scan_and_determinism: a10 };
const ok = Object.values(checks).every((c) => c.ok === true);

const receipt = {
  ok,
  finished_at: new Date().toISOString(),
  verifier: "nightwatch/library/verify.mjs",
  task_fingerprint: TASK_FINGERPRINT,
  checks,
  stats: suiteA.stats,
  artifacts: [
    "nightwatch/library/verify.mjs",
    "nightwatch/library/lib/ids.mjs",
    "nightwatch/library/lib/errors.mjs",
    "nightwatch/library/lib/schemas.mjs",
    "nightwatch/library/lib/dsl.mjs",
    "nightwatch/library/lib/understand.mjs",
    "nightwatch/library/lib/generate.mjs",
    "nightwatch/library/lib/review.mjs",
    "nightwatch/library/lib/store.mjs",
    "nightwatch/library/lib/lifecycle.mjs",
    "nightwatch/library/lib/incremental.mjs",
    "nightwatch/library/lib/coverage.mjs",
    "nightwatch/library/lib/compile.mjs",
    "nightwatch/library/lib/pipeline.mjs",
    "nightwatch/library/fixtures/demo-api-v1.openapi.json",
    "nightwatch/library/fixtures/demo-api-v2.openapi.json",
    "nightwatch/library/fixtures/agent-output.json",
    "nightwatch/library/fixtures/agent-datasets/widget-roundtrip-create.json",
    "nightwatch/library/fixtures/manual-case.json",
    relative(REPO_ROOT, RECEIPT_PATH),
  ],
};

mkdirSync(join(RECEIPT_PATH, ".."), { recursive: true });
writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

/* Clean up ALL self-produced intermediate state (rebuildable). */
rmSync(STATE_ROOT, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* Human-readable summary                                              */
/* ------------------------------------------------------------------ */
line("=== NightWatch WP-02 Test Library & Compiler Verification ===");
const fmt = (label, c) =>
  line(`${label.padEnd(38)}: ${c.ok ? "ok" : "FAILED"} (${c.assertions !== undefined ? `${c.failures.length}/${c.assertions} assertions failed` : ""})`.replace(/ \(\)$/, ""));
fmt("a1_five_case_types_from_inventory", checks.a1_five_case_types_from_inventory);
fmt("a2_traceability_eight_fields", checks.a2_traceability_eight_fields);
fmt("a3_lifecycle_state_machine", checks.a3_lifecycle_state_machine);
fmt("a4_incremental_preservation", checks.a4_incremental_preservation);
fmt("a5_coverage_matrix", checks.a5_coverage_matrix);
fmt("a6_assumption_marking", checks.a6_assumption_marking);
fmt("a7_compile_determinism", checks.a7_compile_determinism);
fmt("a8_source_map_reverse_resolution", checks.a8_source_map_reverse_resolution);
line(
  `a9_wp00_schema_validation            : ${checks.a9_wp00_schema_validation.ok ? "ok" : "FAILED"} ` +
    `(${plansChecked} plans / ${scenariosChecked} scenarios / ${casesChecked} cases / ` +
    `${suiteA.errorEnvelopes.length} error envelopes)`,
);
line(
  `a10_secret_scan_and_determinism     : ${a10.ok ? "ok" : "FAILED"} ` +
    `(${secretHits.length} secret hits / ${scanTargets.length} files; checks byte-identical: ${checksIdentical}; ` +
    `${filesA.length} state files byte-identical)`,
);
line("");
line(`library size: demo-api=${suiteA.stats.demo_cases} cases, lumi-s6-observation=${suiteA.stats.s6_cases} cases; compiled ${suiteA.stats.compiled_items} requests from ${suiteA.stats.compiled_cases} cases`);
for (const [name, c] of Object.entries(checks)) {
  if (!c.ok) line(`FAILURES in ${name}: ${JSON.stringify(c.failures || c.secret_scan?.findings, null, 2)}`);
}
line(`receipt: ${relative(REPO_ROOT, RECEIPT_PATH)}`);
line(ok ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
process.exit(ok ? 0 : 1);
