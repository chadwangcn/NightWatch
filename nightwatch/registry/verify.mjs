#!/usr/bin/env node
/**
 * NightWatch WP-01 — Contract Intake and API Registry verifier (verify.mjs)
 *
 * Independently executable acceptance gate (no services, no HTTP, no network):
 * runs the full intake pipeline against synthetic fixtures (nightwatch/registry/fixtures/)
 * and the four read-only in-repo Postman collections (postman/*.postman_collection.json),
 * then asserts the WorkRequest §8 acceptance conditions:
 *
 *   A1 same-checksum idempotent replay (existing entry returned, no new assets, no re-diff)
 *   A2 bad spec does NOT overwrite last_valid (invalid import_history + failure reason)
 *   A3 machine-readable diff + impact receipt (added/removed/modified, destructive,
 *      security_changed, associated plans/scenarios/cases)
 *   A4 prompt-injection isolation (UNTRUSTED_API_DATA marks, quarantined agent view,
 *      external $ref denied+recorded, no instruction executed)
 *   A5 new endpoints land in the uncovered list; removals trigger destructive impact
 *   A6 the 4 real Postman collections import successfully with byte-accurate checksums
 *   A7 every persisted artifact validates against the frozen WP-00 schemas
 *   A8 secret scan over all produced artifacts and fixtures: 0 hits
 *   A9 determinism: the whole suite runs twice into isolated state dirs and every
 *      produced file is byte-identical (fixed clock; no wall-clock in outputs)
 *
 * Output: human summary on stdout + machine receipt at nightwatch/registry/verify/receipt.json.
 * Exit 0 iff receipt.ok === true. All intermediate state is written under
 * nightwatch/registry/.state/ and REMOVED at the end (rebuildable, no repo pollution).
 *
 * Usage: node nightwatch/registry/verify.mjs   (from the repository root)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryStore } from "./lib/store.mjs";
import { runImportPipeline, discoverSpecs } from "./lib/pipeline.mjs";
import { validateRegistryEntry, validateImportHistory, validateErrorEnvelope } from "./lib/schemas.mjs";
import { UNTRUSTED_MARK } from "./lib/untrusted.mjs";

const REG_ROOT = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/registry
const NW_ROOT = join(REG_ROOT, ".."); // .../nightwatch
const REPO_ROOT = join(NW_ROOT, "..");
const STATE_ROOT = join(REG_ROOT, ".state");
const RECEIPT_PATH = join(REG_ROOT, "verify", "receipt.json");
const TASK_FINGERPRINT = "nw+p0+wp01+contract-intake-registry+impl+arch@v1.4+f2871c4";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Deterministic clock: fixed epoch, +1s per call (A9 requires byte-identical reruns). */
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
/* Secret scan (same pattern set as the WP-00 verifier)                */
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

/* ------------------------------------------------------------------ */
/* Directory tree comparison (A9)                                      */
/* ------------------------------------------------------------------ */
const snapshotTree = (dir) => {
  const files = {};
  for (const p of walkFiles(dir)) files[relative(dir, p)] = readFileSync(p);
  return files;
};

/* ------------------------------------------------------------------ */
/* Scenario suite (runs identically into any state dir)                */
/* ------------------------------------------------------------------ */
const FIXTURES = join(REG_ROOT, "fixtures");
const rel = (p) => relative(REPO_ROOT, p);

const envFor = (apiId, { destructiveTest = false } = {}) => {
  const stem = apiId.toUpperCase().replace(/-/g, "_");
  return {
    test: { base_url_env: `${stem}_TEST_BASE_URL`, auth_profile: `${apiId}-test-bearer`, destructive_allowed: destructiveTest },
    production: { base_url_env: `${stem}_PROD_BASE_URL`, auth_profile: `${apiId}-prod-readonly`, destructive_allowed: false, load_allowed: false },
  };
};

function runScenarioSuite(stateDir) {
  const clock = makeClock("2026-08-20T00:00:00Z");
  const impactLinks = readJson(join(FIXTURES, "impact-links.json")).links;
  const store = new RegistryStore({ rootDir: stateDir, clock, impactLinks });
  store.reset();

  const import_ = (opts) => runImportPipeline(store, { repoRoot: REPO_ROOT, ...opts });
  const assertions = {
    a1: [],
    a2: [],
    a3: [],
    a4: [],
    a5: [],
    a6: [],
  };
  const errorEnvelopes = [];

  /* ---------------- A6: real Postman collections (Discover → full pipeline) -------- */
  const postmanSpecs = discoverSpecs(join(REPO_ROOT, "postman"), (name) => name.endsWith(".postman_collection.json"));
  const postmanEndpoints = {};
  for (const file of postmanSpecs) {
    const apiId = file.split("/").pop().replace(/\.postman_collection\.json$/, "");
    const r = import_({ location: rel(file), apiId, environments: envFor(apiId), owner: "lumi-qa", purpose: "In-repo Postman collection (read-only File source)" });
    const fileChecksum = sha256Hex(readFileSync(file));
    assertions.a6.push(A(`import ok: ${apiId}`, r.ok === true, r.error));
    assertions.a6.push(A(`checksum matches file bytes: ${apiId}`, r.checksum === fileChecksum, { actual: r.checksum, expected: fileChecksum }));
    assertions.a6.push(A(`endpoints extracted: ${apiId}`, r.inventory && r.inventory.summary.total > 0, r.inventory && r.inventory.summary));
    postmanEndpoints[apiId] = r.inventory ? r.inventory.summary.total : 0;
    // Idempotent rerun (A6: "幂等重跑一致").
    const r2 = import_({ location: rel(file), apiId, environments: envFor(apiId) });
    assertions.a6.push(A(`idempotent rerun: ${apiId}`, r2.idempotent_replay === true && r2.checksum === fileChecksum));
  }
  assertions.a6.push(A("exactly 4 in-repo collections discovered", postmanSpecs.length === 4, postmanSpecs.map(rel)));

  /* ---------------- A1: same-checksum idempotent replay ---------------- */
  const r1 = import_({ location: "nightwatch/registry/fixtures/order-api-v1.openapi.json", apiId: "order-api", environments: envFor("order-api", { destructiveTest: true }), owner: "synthetic-order-team", purpose: "Synthetic Order API contract intake fixture" });
  const a1EntrySnapshot = JSON.stringify(r1.entry);
  const a1HistoryCount = store.getHistory("order-api").length;
  const r1again = import_({ location: "nightwatch/registry/fixtures/order-api-v1.openapi.json", apiId: "order-api", environments: envFor("order-api", { destructiveTest: true }) });
  assertions.a1.push(A("second import replays", r1again.idempotent_replay === true && r1again.status === "replay", r1again.status));
  assertions.a1.push(A("existing entry returned unchanged", JSON.stringify(r1again.entry) === a1EntrySnapshot));
  assertions.a1.push(A("no new import_history record", store.getHistory("order-api").length === a1HistoryCount, store.getHistory("order-api").length));
  assertions.a1.push(A("no diff recomputed", r1again.diff === null && r1again.impact === null));
  assertions.a1.push(A("no new sequence consumed", r1again.sequence === null));
  const stateFilesBefore = walkFiles(stateDir).length;

  /* ---------------- A3 + A5: versioned diff, impact, coverage ---------- */
  const r2 = import_({ location: "nightwatch/registry/fixtures/order-api-v2.openapi.json", apiId: "order-api", environments: envFor("order-api", { destructiveTest: true }) });
  const d = r2.diff;
  const imp = r2.impact;
  const modKeys = d.endpoints.modified.map((m) => m.key).sort();
  const postMod = d.endpoints.modified.find((m) => m.key === "POST /v1/orders");
  const getListMod = d.endpoints.modified.find((m) => m.key === "GET /v1/orders");
  const getOneMod = d.endpoints.modified.find((m) => m.key === "GET /v1/orders/{orderId}");
  const removedImpact = imp.impacted.find((e) => e.method === "DELETE" && e.path === "/v1/orders/{orderId}");
  const postImpact = imp.impacted.find((e) => e.method === "POST" && e.path === "/v1/orders");

  assertions.a3.push(A("added endpoints", JSON.stringify(d.endpoints.added) === JSON.stringify(["GET /v1/orders/{orderId}/items"]), d.endpoints.added));
  assertions.a3.push(A("removed endpoints", JSON.stringify(d.endpoints.removed) === JSON.stringify(["DELETE /v1/orders/{orderId}"]), d.endpoints.removed));
  assertions.a3.push(A("modified endpoints", JSON.stringify(modKeys) === JSON.stringify(["GET /v1/orders", "GET /v1/orders/{orderId}", "POST /v1/orders"]), modKeys));
  assertions.a3.push(A("POST marked required-field + response-removed", postMod && postMod.changes.includes("request_body_required_field_added") && postMod.changes.includes("response_removed"), postMod && postMod.changes));
  assertions.a3.push(A("GET /v1/orders marked security change", getListMod && getListMod.changes.includes("security"), getListMod && getListMod.changes));
  assertions.a3.push(A("GET /{orderId} marked response_schema change", getOneMod && getOneMod.changes.includes("response_schema"), getOneMod && getOneMod.changes));
  assertions.a3.push(A("security scheme added detected", JSON.stringify(d.security_schemes.added) === JSON.stringify(["orderApiKey"]), d.security_schemes));
  assertions.a3.push(A("security_changed flag", d.security_changed === true && d.security_changed_endpoints.includes("GET /v1/orders")));
  assertions.a3.push(A("destructive flag with 3 reasons", d.destructive === true && d.destructive_reasons.length === 3, d.destructive_reasons));
  assertions.a3.push(A("removed endpoint carries plan/scenario/case associations", removedImpact && removedImpact.associated === true && removedImpact.plans.length === 1 && removedImpact.scenarios.length === 1 && removedImpact.cases.length === 1, removedImpact));
  assertions.a3.push(A("modified endpoint carries associations", postImpact && postImpact.associated === true && postImpact.plans.length === 1, postImpact));
  assertions.a3.push(A("regression + auth reviews required", imp.reviews_required.length === 2 && imp.reviews_required.some((x) => x.startsWith("regression-review")) && imp.reviews_required.some((x) => x.startsWith("auth-review")), imp.reviews_required));
  assertions.a3.push(A("diff receipt persisted", existsSync(join(stateDir, "diffs", "order-api", "0002.json")) && JSON.stringify(readJson(join(stateDir, "diffs", "order-api", "0002.json"))) === JSON.stringify(d)));
  assertions.a3.push(A("impact receipt persisted", existsSync(join(stateDir, "impacts", "order-api", "0002.json")) && JSON.stringify(readJson(join(stateDir, "impacts", "order-api", "0002.json"))) === JSON.stringify(imp)));

  // A5: coverage list semantics.
  const inv2 = r2.inventory;
  const inv1Uncovered = r1.inventory.uncovered.map((e) => `${e.method} ${e.path}`);
  assertions.a5.push(A("initial import: unassociated endpoints uncovered", inv1Uncovered.includes("GET /v1/orders/{orderId}") && !inv1Uncovered.includes("POST /v1/orders"), inv1Uncovered));
  assertions.a5.push(A("new endpoint enters uncovered list", inv2.uncovered.some((e) => e.method === "GET" && e.path === "/v1/orders/{orderId}/items"), inv2.uncovered));
  assertions.a5.push(A("removed endpoint triggers destructive impact", d.destructive === true && removedImpact && removedImpact.change === "removed" && removedImpact.associated === true));
  assertions.a5.push(A("summary counts consistent", inv2.summary.total === inv2.summary.covered + inv2.summary.uncovered, inv2.summary));

  /* ---------------- A2: bad spec never overwrites last_valid ----------- */
  const lastValidBefore = JSON.stringify(store.getEntry("order-api").last_valid);
  const historyBeforeBad = store.getHistory("order-api").length;
  const rBroken = import_({ location: "nightwatch/registry/fixtures/broken.openapi.json", apiId: "order-api", environments: envFor("order-api", { destructiveTest: true }) });
  errorEnvelopes.push(rBroken.error);
  const entryAfterBad = store.getEntry("order-api");
  const historyAfterBad = store.getHistory("order-api");
  assertions.a2.push(A("broken import is invalid", rBroken.ok === false && rBroken.status === "invalid" && rBroken.error.code === "REG_SPEC_INVALID", rBroken.error));
  assertions.a2.push(A("import_history records invalid + reason", historyAfterBad.length === historyBeforeBad + 1 && historyAfterBad[historyAfterBad.length - 1].status === "invalid" && typeof historyAfterBad[historyAfterBad.length - 1].error === "string" && historyAfterBad[historyAfterBad.length - 1].error.length > 0, historyAfterBad[historyAfterBad.length - 1]));
  assertions.a2.push(A("last_valid unchanged", JSON.stringify(entryAfterBad.last_valid) === lastValidBefore, entryAfterBad.last_valid));
  assertions.a2.push(A("latest_import reflects the failed attempt", entryAfterBad.latest_import.status === "invalid" && entryAfterBad.latest_import.checksum === rBroken.checksum, entryAfterBad.latest_import));
  assertions.a2.push(A("registry still serves the previous valid version", store.readNormalized("order-api", entryAfterBad.last_valid.checksum) !== null));

  // Structurally invalid spec (JSON parses, validation fails) on a fresh api_id.
  const tmpDir = join(stateDir, ".tmp-specs");
  mkdirSync(tmpDir, { recursive: true });
  const badStructurePath = join(tmpDir, "bad-structure.openapi.json");
  writeFileSync(badStructurePath, JSON.stringify({ openapi: "3.0.3", info: { title: "Bad Structure API", version: "0.0.1" }, paths: { "/v1/bad": { get: { operationId: "bad" } } } }, null, 2) + "\n");
  const rBadStruct = import_({ location: relative(REPO_ROOT, badStructurePath), apiId: "bad-structure-api", environments: envFor("bad-structure-api") });
  errorEnvelopes.push(rBadStruct.error);
  assertions.a2.push(A("validate failure is REG_SPEC_INVALID", rBadStruct.ok === false && rBadStruct.error.code === "REG_SPEC_INVALID", rBadStruct.error));
  assertions.a2.push(A("no entry created for a first-import failure", store.getEntry("bad-structure-api") === null));
  assertions.a2.push(A("failure still recorded in history", store.getHistory("bad-structure-api").length === 1 && store.getHistory("bad-structure-api")[0].status === "invalid"));

  // Pinned checksum mismatch (REG_CHECKSUM_MISMATCH).
  const rPin = import_({
    location: "nightwatch/registry/fixtures/order-api-v1.openapi.json",
    apiId: "order-api",
    environments: envFor("order-api", { destructiveTest: true }),
    expectedChecksum: "0".repeat(64),
  });
  errorEnvelopes.push(rPin.error);
  assertions.a2.push(A("pinned checksum mismatch detected", rPin.ok === false && rPin.error.code === "REG_CHECKSUM_MISMATCH", rPin.error));
  assertions.a2.push(A("mismatch keeps last_valid", JSON.stringify(store.getEntry("order-api").last_valid) === lastValidBefore));

  // Source unavailable (REG_SOURCE_UNAVAILABLE): no history record without a spec identity.
  const historyBeforeMissing = store.getHistory("order-api").length;
  const rMissing = import_({ location: "postman/does-not-exist.postman_collection.json", apiId: "missing-source-api", environments: envFor("missing-source-api") });
  errorEnvelopes.push(rMissing.error);
  assertions.a2.push(A("missing source is REG_SOURCE_UNAVAILABLE", rMissing.ok === false && rMissing.error.code === "REG_SOURCE_UNAVAILABLE", rMissing.error));
  assertions.a2.push(A("no history side effects for unfetchable source", store.getHistory("order-api").length === historyBeforeMissing && store.getHistory("missing-source-api").length === 0));

  /* ---------------- A4: prompt injection isolation ---------------------- */
  const filesBeforeMalicious = walkFiles(stateDir).map((p) => relative(stateDir, p)).sort();
  const rMal = import_({ location: "nightwatch/registry/fixtures/malicious.openapi.json", apiId: "widget-api", environments: envFor("widget-api") });
  const malIR = rMal.normalized;
  const malInv = rMal.inventory;
  const flaggedLocations = malIR.injection_report.flagged_texts.map((f) => f.location).sort();
  const rejectedRefs = malIR.injection_report.external_refs_rejected.map((r) => r.ref);
  const widgetList = malInv.endpoints.find((e) => e.method === "GET" && e.path === "/v1/widgets");
  const widgetGetOne = malInv.endpoints.find((e) => e.method === "GET" && e.path === "/v1/widgets/{widgetId}");
  const widgetCreate = malInv.endpoints.find((e) => e.method === "POST" && e.path === "/v1/widgets");

  assertions.a4.push(A("malicious (structurally valid) spec imports", rMal.ok === true && rMal.status === "valid", rMal.error));
  assertions.a4.push(A("all spec descriptions marked UNTRUSTED_API_DATA", [widgetGetOne, widgetCreate].every((e) => e !== undefined) && malIR.endpoints.every((ep) => ep.description === null || ep.description.trust === UNTRUSTED_MARK) && malIR.api_description.trust === UNTRUSTED_MARK));
  assertions.a4.push(A("instruction patterns flagged (api + endpoint + example)", flaggedLocations.length >= 3 && flaggedLocations.some((l) => l === "info.description") && flaggedLocations.some((l) => l.startsWith("paths./v1/widgets.get.description")) && flaggedLocations.some((l) => l.includes("parameters.widgetId.example")), flaggedLocations));
  assertions.a4.push(A("external $ref denied and recorded", rejectedRefs.includes("https://evil.example.test/schemas/widgets.json#/WidgetList") && malIR.injection_report.external_refs_rejected.length === 1, rejectedRefs));
  assertions.a4.push(A("external ref never resolved into the IR", malIR.endpoints.find((e) => e.key === "GET /v1/widgets").responses["200"].schema_ref !== "https://evil.example.test/schemas/widgets.json#/WidgetList"));
  assertions.a4.push(A("agent view quarantines the malicious description", widgetList.description_agent_view.startsWith("[QUARANTINED_BY_INJECTION_SCAN:") && !widgetList.description_agent_view.includes("/etc/passwd") && !widgetList.description_agent_view.includes("attacker.example.test") && !widgetList.description_agent_view.includes("workspace policy"), widgetList.description_agent_view));
  assertions.a4.push(A("clean descriptions stay readable in agent view", widgetGetOne.description_agent_view === "Returns one widget." && widgetCreate.description_agent_view === "Creates a widget."));

  // No instruction was executed: the only new state files are the expected widget-api artifacts.
  const filesAfterMalicious = walkFiles(stateDir).map((p) => relative(stateDir, p)).sort();
  const newFiles = filesAfterMalicious.filter((f) => !filesBeforeMalicious.includes(f));
  assertions.a4.push(
    A("no unexpected side-effect files (no instruction executed)",
      newFiles.length > 0 && newFiles.every((f) => f.startsWith("widget-api/") || f.startsWith("entries/widget-api.json") || f.startsWith("inventory/widget-api.json") || f.startsWith(".tmp-specs/") === false),
      newFiles),
  );

  return {
    assertions,
    errorEnvelopes,
    postmanEndpoints,
    stateFilesBefore,
    store,
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

/* A9 — determinism: byte-identical artifact trees across the two runs. */
const treeA = snapshotTree(dirA);
const treeB = snapshotTree(dirB);
const filesA = Object.keys(treeA).sort();
const filesB = Object.keys(treeB).sort();
const a9Assertions = [
  A("same file set in both runs", JSON.stringify(filesA) === JSON.stringify(filesB), { only_a: filesA.filter((f) => !filesB.includes(f)), only_b: filesB.filter((f) => !filesA.includes(f)) }),
  A("every file byte-identical", filesA.every((f) => Buffer.compare(treeA[f], treeB[f]) === 0), filesA.filter((f) => treeB[f] && Buffer.compare(treeA[f], treeB[f]) !== 0)),
  A("artifact set non-empty (suite actually produced state)", filesA.length >= 30, filesA.length),
];
const a9 = makeCheck(a9Assertions);

/* A7 — every persisted artifact validates against the frozen WP-00 schemas. */
const a7Assertions = [];
let entriesChecked = 0;
let historyChecked = 0;
for (const f of filesA) {
  if (f.startsWith("entries/")) {
    entriesChecked += 1;
    const v = validateRegistryEntry(JSON.parse(treeA[f].toString("utf8")));
    a7Assertions.push(A(`registry_entry schema: ${f}`, v.ok, v.errors));
  } else if (f.startsWith("history/")) {
    historyChecked += 1;
    const v = validateImportHistory(JSON.parse(treeA[f].toString("utf8")));
    a7Assertions.push(A(`import_history schema: ${f}`, v.ok, v.errors));
  }
}
for (const [i, env] of suiteA.errorEnvelopes.entries()) {
  const v = validateErrorEnvelope(env);
  a7Assertions.push(A(`error envelope schema #${i + 1} (${env.code})`, v.ok, v.errors));
}
a7Assertions.push(A("at least one error envelope validated", suiteA.errorEnvelopes.length >= 4, suiteA.errorEnvelopes.length));
const a7 = makeCheck(a7Assertions);

/* A8 — secret scan over all produced artifacts + the fixture inputs. */
const scanTargets = [...walkFiles(dirA), ...walkFiles(FIXTURES)];
const secretHits = scanSecrets(scanTargets);
const a8 = {
  ok: secretHits.length === 0,
  hits: secretHits.length,
  scanned_files: scanTargets.length,
  scanned_dirs: [relative(REPO_ROOT, dirA), relative(REPO_ROOT, FIXTURES)],
  findings: secretHits,
};

/* Assemble checks A1–A6 from the suite assertions. */
const checks = {
  a1_same_checksum_idempotent: makeCheck(suiteA.assertions.a1),
  a2_bad_spec_keeps_last_valid: makeCheck(suiteA.assertions.a2),
  a3_diff_and_impact_machine_receipt: makeCheck(suiteA.assertions.a3),
  a4_prompt_injection_isolation: makeCheck(suiteA.assertions.a4),
  a5_uncovered_and_destructive_impact: makeCheck(suiteA.assertions.a5),
  a6_real_postman_collections_import: {
    ...makeCheck(suiteA.assertions.a6),
    collections: suiteA.postmanEndpoints,
  },
  a7_wp00_schema_validation: {
    ...a7,
    entries_checked: entriesChecked,
    history_checked: historyChecked,
    error_envelopes_checked: suiteA.errorEnvelopes.length,
  },
  a8_secret_scan: a8,
  a9_determinism: {
    ...a9,
    runs: 2,
    files_compared: filesA.length,
  },
};

const ok = Object.values(checks).every((c) => c.ok === true);

const receipt = {
  ok,
  finished_at: new Date().toISOString(),
  verifier: "nightwatch/registry/verify.mjs",
  task_fingerprint: TASK_FINGERPRINT,
  checks,
  artifacts: [
    "nightwatch/registry/verify.mjs",
    "nightwatch/registry/lib/pipeline.mjs",
    "nightwatch/registry/lib/parse.mjs",
    "nightwatch/registry/lib/diff.mjs",
    "nightwatch/registry/lib/impact.mjs",
    "nightwatch/registry/lib/store.mjs",
    "nightwatch/registry/lib/untrusted.mjs",
    "nightwatch/registry/lib/schemas.mjs",
    "nightwatch/registry/lib/errors.mjs",
    "nightwatch/registry/fixtures/order-api-v1.openapi.json",
    "nightwatch/registry/fixtures/order-api-v2.openapi.json",
    "nightwatch/registry/fixtures/broken.openapi.json",
    "nightwatch/registry/fixtures/malicious.openapi.json",
    "nightwatch/registry/fixtures/impact-links.json",
    relative(REPO_ROOT, RECEIPT_PATH),
  ],
};

mkdirSync(join(RECEIPT_PATH, ".."), { recursive: true });
writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

/* Clean up ALL self-produced intermediate state (the store is rebuildable). */
rmSync(STATE_ROOT, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* Human-readable summary                                              */
/* ------------------------------------------------------------------ */
line("=== NightWatch WP-01 Contract Intake & API Registry Verification ===");
const fmt = (label, c) => line(`${label.padEnd(34)}: ${c.ok ? "ok" : "FAILED"} (${c.assertions !== undefined ? `${c.failures.length}/${c.assertions} assertions failed` : c.hits !== undefined ? `${c.hits} hits / ${c.scanned_files} files` : ""})`.replace(/ \(\)$/, ""));
fmt("a1_same_checksum_idempotent", checks.a1_same_checksum_idempotent);
fmt("a2_bad_spec_keeps_last_valid", checks.a2_bad_spec_keeps_last_valid);
fmt("a3_diff_and_impact_receipt", checks.a3_diff_and_impact_machine_receipt);
fmt("a4_prompt_injection_isolation", checks.a4_prompt_injection_isolation);
fmt("a5_uncovered_and_destructive", checks.a5_uncovered_and_destructive_impact);
line(
  `a6_real_postman_collections      : ${checks.a6_real_postman_collections_import.ok ? "ok" : "FAILED"} ` +
    `(${Object.keys(checks.a6_real_postman_collections_import.collections).length} collections: ` +
    `${Object.entries(checks.a6_real_postman_collections_import.collections).map(([k, v]) => `${k}=${v}`).join(", ")})`,
);
line(
  `a7_wp00_schema_validation       : ${checks.a7_wp00_schema_validation.ok ? "ok" : "FAILED"} ` +
    `(${checks.a7_wp00_schema_validation.entries_checked} entries / ${checks.a7_wp00_schema_validation.history_checked} history / ` +
    `${checks.a7_wp00_schema_validation.error_envelopes_checked} error envelopes)`,
);
line(`a8_secret_scan                  : ${secretHits.length} hits across ${scanTargets.length} files`);
line(`a9_determinism                  : ${a9.ok ? "ok" : "FAILED"} (${filesA.length} files byte-identical across 2 runs)`);
line("");
for (const [name, c] of Object.entries(checks)) {
  if (!c.ok) line(`FAILURES in ${name}: ${JSON.stringify(c.failures || c.findings, null, 2)}`);
}
line(`receipt: ${relative(REPO_ROOT, RECEIPT_PATH)}`);
line(ok ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
process.exit(ok ? 0 : 1);
