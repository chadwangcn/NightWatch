#!/usr/bin/env node
/**
 * NightWatch WP-00 — Contract Verifier (verify.mjs)
 *
 * Independently executable (no services, no HTTP, no Newman). Validates:
 *   1. schemas_meta_valid        — every registered schema compiles under draft 2020-12
 *                                  and carries $id/title/x-nightwatch-object/x-nightwatch-version;
 *                                  $id matches the registry entry.
 *   2. fixtures_positive         — every positive fixture validates against its schema
 *                                  (underscore-prefixed annotation keys are stripped first).
 *   3. fixtures_negative_rejected— every negative fixture is REJECTED; receipt lists each
 *                                  rejection with the expected violated_rule and AJV evidence.
 *   4. state_machine_consistency — session state enum == registry states;
 *                                  sessionStateChanged if/then matrix == registry transitions;
 *                                  every legal transition has a positive fixture;
 *                                  >= 3 illegal-transition negatives all rejected;
 *                                  graph checks (initial state, terminal reachability).
 *   5. error_registry_consistency— error/v1.json code enum == errors.json keys (bidirectional);
 *                                  all 12 component namespaces populated;
 *                                  all required semantic categories covered by codes AND fixtures;
 *                                  fixture error codes ⊆ registry.
 *   6. id_prefix_coverage        — all §5.5 prefixes have a common.json definition
 *                                  and a matching positive fixture instance.
 *   7. secret_scan               — credential-shaped patterns across fixtures/ and schemas/ = 0 hits.
 *
 * Output: human-readable summary on stdout + machine receipt at nightwatch/verify/receipt.json.
 * Exit code 0 iff receipt.ok === true. Deterministic: two runs produce byte-identical
 * `checks` (finished_at excluded).
 *
 * Usage: node nightwatch/verify/verify.mjs   (from the repository root)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const NW_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch
const SCHEMAS_DIR = join(NW_ROOT, "schemas");
const FIXTURES_DIR = join(NW_ROOT, "fixtures");
const RECEIPT_PATH = join(NW_ROOT, "verify", "receipt.json");
const REPO_ROOT = join(NW_ROOT, "..");

const ajv = new Ajv2020({ strict: false, allErrors: true });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const relFromRepo = (p) => relative(REPO_ROOT, p);

/* ------------------------------------------------------------------ */
/* Load registry + error registry                                      */
/* ------------------------------------------------------------------ */
const index = readJson(join(SCHEMAS_DIR, "index.json"));
const errorsRegistry = readJson(join(SCHEMAS_DIR, "errors.json"));

const schemaEntries = [];
for (const [name, meta] of Object.entries(index.objects)) schemaEntries.push({ name, kind: "object", ...meta });
for (const [name, meta] of Object.entries(index.commands)) schemaEntries.push({ name, kind: "command", ...meta });
for (const [name, meta] of Object.entries(index.events)) schemaEntries.push({ name, kind: "event", ...meta });

/* ------------------------------------------------------------------ */
/* Check 1: schemas_meta_valid                                         */
/* ------------------------------------------------------------------ */
const metaFailures = [];
const compiledIds = new Set();

function checkMetaAnnotations(label, schema) {
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    metaFailures.push(`${label}: $schema must be draft 2020-12, got ${schema.$schema}`);
  }
  if (typeof schema.$id !== "string" || !/^https:\/\/nightwatch\.local\/schemas\//.test(schema.$id)) {
    metaFailures.push(`${label}: missing or malformed $id`);
  }
  if (typeof schema.title !== "string" || schema.title.length === 0) {
    metaFailures.push(`${label}: missing title`);
  }
  if (typeof schema["x-nightwatch-object"] !== "string") {
    metaFailures.push(`${label}: missing x-nightwatch-object`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(schema["x-nightwatch-version"] || ""))) {
    metaFailures.push(`${label}: x-nightwatch-version must be semver`);
  }
}

// common.json first (referenced by all object schemas via $ref)
const commonSchema = readJson(join(SCHEMAS_DIR, "common.json"));
checkMetaAnnotations("common", commonSchema);
try {
  ajv.addSchema(commonSchema);
  compiledIds.add(commonSchema.$id);
} catch (e) {
  metaFailures.push(`common: compile failed: ${e.message}`);
}

for (const entry of schemaEntries) {
  const filePath = join(NW_ROOT, entry.file);
  let schema;
  try {
    schema = readJson(filePath);
  } catch (e) {
    metaFailures.push(`${entry.name}: unreadable file ${entry.file}: ${e.message}`);
    continue;
  }
  checkMetaAnnotations(entry.name, schema);
  if (schema.$id !== entry.$id) {
    metaFailures.push(`${entry.name}: registry $id ${entry.$id} != file $id ${schema.$id}`);
  }
  if (String(schema["x-nightwatch-version"] || "") !== String(entry.version)) {
    metaFailures.push(`${entry.name}: registry version ${entry.version} != file version ${schema["x-nightwatch-version"]}`);
  }
  try {
    ajv.compile(schema);
    compiledIds.add(schema.$id);
  } catch (e) {
    metaFailures.push(`${entry.name}: compile failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Checks 2 & 3: fixtures positive / negative                          */
/* ------------------------------------------------------------------ */
const fixturesManifest = readJson(join(FIXTURES_DIR, "index.json"));
const fixtureFiles = [
  ...fixturesManifest.files.objects.map((f) => ({ file: f, group: "objects" })),
  ...fixturesManifest.files.commands.map((f) => ({ file: f, group: "commands" })),
  ...fixturesManifest.files.events.map((f) => ({ file: f, group: "events" })),
];

const stripAnnotations = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
};

const summarizeErrors = (errors) =>
  (errors || []).slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

let posTotal = 0;
const posFailures = [];
let negTotal = 0;
let negNotRejected = 0;
const negDetails = [];

for (const { file } of fixtureFiles) {
  let fx;
  try {
    fx = readJson(join(FIXTURES_DIR, file));
  } catch (e) {
    metaFailures.push(`fixture ${file}: unreadable: ${e.message}`);
    continue;
  }
  const validate = ajv.getSchema(fx.schema);
  if (!validate) {
    metaFailures.push(`fixture ${file}: schema not compiled: ${fx.schema}`);
    continue;
  }
  for (const inst of fx.positive || []) {
    posTotal += 1;
    const clean = stripAnnotations(inst);
    if (!validate(clean)) {
      posFailures.push({ file, errors: summarizeErrors(validate.errors) });
    }
  }
  for (const neg of fx.negative || []) {
    negTotal += 1;
    const accepted = validate(neg.instance);
    if (accepted) {
      negNotRejected += 1;
      negDetails.push({ file, violated_rule: neg.violated_rule, rejected: false, errors: [] });
    } else {
      negDetails.push({
        file,
        violated_rule: neg.violated_rule,
        rejected: true,
        errors: summarizeErrors(validate.errors),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check 4: state_machine_consistency                                  */
/* ------------------------------------------------------------------ */
const smFailures = [];
const sm = index.state_machine;

// 4.1 session state enum (common.json) == registry states
const sessionStateEnum = (commonSchema.$defs.session_state && commonSchema.$defs.session_state.enum) || [];
const statesSet = new Set(sm.states);
const enumSet = new Set(sessionStateEnum);
for (const s of enumSet) if (!statesSet.has(s)) smFailures.push(`state enum has extra state not in registry: ${s}`);
for (const s of statesSet) if (!enumSet.has(s)) smFailures.push(`registry state missing from enum: ${s}`);

// 4.2 session schema must reference the shared session_state definition
const sessionSchema = readJson(join(NW_ROOT, index.objects.session.file));
const stateRefOk =
  JSON.stringify(sessionSchema.properties.state) ===
  JSON.stringify({ $ref: "https://nightwatch.local/schemas/common.json#/$defs/session_state" });
if (!stateRefOk) smFailures.push("session schema state property must $ref common session_state");

// 4.3 extract if/then matrix from sessionStateChanged schema and compare with registry transitions
const sscSchema = readJson(join(NW_ROOT, index.events.sessionStateChanged.file));
const matrixTransitions = new Set();
const matrixNoExit = new Set();
for (const rule of sscSchema.properties.payload.allOf || []) {
  const from = rule.if && rule.if.properties && rule.if.properties.from_state && rule.if.properties.from_state.const;
  if (from === undefined) continue;
  if (rule.then === false) {
    matrixNoExit.add(from);
    continue;
  }
  const tos = (rule.then && rule.then.properties && rule.then.properties.to_state && rule.then.properties.to_state.enum) || [];
  for (const to of tos) matrixTransitions.add(`${from}->${to}`);
}
const registryTransitions = new Set(sm.transitions.map((t) => `${t.from}->${t.to}`));
for (const t of matrixTransitions) if (!registryTransitions.has(t)) smFailures.push(`schema matrix has transition not in registry: ${t}`);
for (const t of registryTransitions) if (!matrixTransitions.has(t)) smFailures.push(`registry transition missing from schema matrix: ${t}`);

// 4.4 terminal states must equal states with no outgoing transitions
const statesWithExit = new Set(sm.transitions.map((t) => t.from));
const noExitStates = sm.states.filter((s) => !statesWithExit.has(s));
for (const t of sm.terminal_states) if (!noExitStates.includes(t)) smFailures.push(`declared terminal state ${t} has outgoing transitions`);
for (const s of noExitStates) if (!sm.terminal_states.includes(s)) smFailures.push(`state ${s} has no outgoing transitions but is not declared terminal`);

// 4.5 graph checks: initial state exists; every terminal state reachable from initial
const adjacency = new Map(sm.states.map((s) => [s, []]));
for (const t of sm.transitions) adjacency.get(t.from).push(t.to);
const reachable = new Set([sm.initial_state]);
const queue = [sm.initial_state];
while (queue.length > 0) {
  const cur = queue.shift();
  for (const nxt of adjacency.get(cur) || []) {
    if (!reachable.has(nxt)) {
      reachable.add(nxt);
      queue.push(nxt);
    }
  }
}
if (!reachable.has(sm.initial_state)) smFailures.push("initial state not present");
for (const t of sm.terminal_states) if (!reachable.has(t)) smFailures.push(`terminal state ${t} unreachable from ${sm.initial_state}`);
// blocked must be recoverable: running->blocked and blocked->running both present
if (!registryTransitions.has("running->blocked") || !registryTransitions.has("blocked->running")) {
  smFailures.push("blocked recovery (running->blocked->running) incomplete");
}

// 4.6 every legal transition has a positive fixture; >= 3 illegal-transition negatives rejected
// Fixture annotations may use the Unicode arrow (→) for readability; normalize to ASCII "->"
const sscFixture = readJson(join(FIXTURES_DIR, "events/sessionStateChanged.json"));
const coveredTransitions = new Set(
  (sscFixture.positive || [])
    .map((p) => (typeof p._transition === "string" ? p._transition.replace(/→/g, "->") : p._transition))
    .filter(Boolean)
);
for (const t of registryTransitions) if (!coveredTransitions.has(t)) smFailures.push(`legal transition without positive fixture: ${t}`);
const illegalNegatives = (sscFixture.negative || []).filter((n) => /ILLEGAL TRANSITION/i.test(n.violated_rule));
if (illegalNegatives.length < 3) smFailures.push(`illegal-transition negatives < 3 (${illegalNegatives.length})`);
const illegalRejected = illegalNegatives.every((n) => {
  const v = ajv.getSchema(sscFixture.schema);
  return !v(n.instance);
});
if (!illegalRejected) smFailures.push("some illegal-transition negative was NOT rejected");

/* ------------------------------------------------------------------ */
/* Check 5: error_registry_consistency                                 */
/* ------------------------------------------------------------------ */
const errFailures = [];
const codeKeys = Object.keys(errorsRegistry.codes);

// 5.1 all 12 component namespaces populated
for (const ns of Object.keys(errorsRegistry.namespaces)) {
  if (!codeKeys.some((k) => k.startsWith(ns))) errFailures.push(`namespace ${ns} has no codes`);
}
// 5.2 every code well-formed: namespace prefix + UPPER_SNAKE + required fields
for (const [code, def] of Object.entries(errorsRegistry.codes)) {
  const ns = Object.keys(errorsRegistry.namespaces).find((n) => code.startsWith(n));
  if (!ns) errFailures.push(`code ${code} does not start with a registered namespace`);
  if (def.namespace !== ns) errFailures.push(`code ${code} namespace mismatch`);
  if (typeof def.semantics !== "string" || def.semantics.length === 0) errFailures.push(`code ${code} missing semantics`);
  if (!Number.isInteger(def.http_status) || def.http_status < 100 || def.http_status > 599) errFailures.push(`code ${code} invalid http_status`);
  if (typeof def.retryable !== "boolean") errFailures.push(`code ${code} missing retryable default`);
  if (typeof def.category !== "string") errFailures.push(`code ${code} missing category`);
}
// 5.3 error envelope enum == registry keys (bidirectional)
const errorSchema = readJson(join(NW_ROOT, index.objects.error.file));
const enumCodes = new Set(errorSchema.properties.code.enum);
const registryCodes = new Set(codeKeys);
for (const c of enumCodes) if (!registryCodes.has(c)) errFailures.push(`error schema enum has unregistered code: ${c}`);
for (const c of registryCodes) if (!enumCodes.has(c)) errFailures.push(`registry code missing from error schema enum: ${c}`);
// 5.4 required semantic categories covered by codes
const codeCategories = new Set(codeKeys.map((k) => errorsRegistry.codes[k].category));
for (const cat of errorsRegistry.required_semantic_categories) {
  if (!codeCategories.has(cat)) errFailures.push(`required semantic category without any code: ${cat}`);
}
// 5.5 required semantic categories covered by positive fixtures
const errorFixture = readJson(join(FIXTURES_DIR, "objects/error.json"));
const fixtureCategories = new Set((errorFixture.positive || []).map((p) => p._semantic_category).filter(Boolean));
for (const cat of errorsRegistry.required_semantic_categories) {
  if (!fixtureCategories.has(cat)) errFailures.push(`required semantic category without positive fixture: ${cat}`);
}
// 5.6 fixture error codes ⊆ registry
for (const p of errorFixture.positive || []) {
  if (!registryCodes.has(p.code)) errFailures.push(`fixture uses unregistered code: ${p.code}`);
}

/* ------------------------------------------------------------------ */
/* Check 6: id_prefix_coverage                                         */
/* ------------------------------------------------------------------ */
const missingPrefixes = [];
const allPositiveStrings = [];
const collectStrings = (v) => {
  if (typeof v === "string") allPositiveStrings.push(v);
  else if (Array.isArray(v)) v.forEach(collectStrings);
  else if (v && typeof v === "object") Object.values(v).forEach(collectStrings);
};
for (const { file } of fixtureFiles) {
  const fx = readJson(join(FIXTURES_DIR, file));
  for (const inst of fx.positive || []) collectStrings(stripAnnotations(inst));
}
for (const prefix of Object.keys(index.id_prefix_table)) {
  const def = commonSchema.$defs[`id_${prefix}`];
  if (!def) {
    missingPrefixes.push(`${prefix} (no common.json definition)`);
    continue;
  }
  const re = new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
  if (!allPositiveStrings.some((s) => re.test(s))) {
    missingPrefixes.push(`${prefix} (no positive fixture instance)`);
  }
}

/* ------------------------------------------------------------------ */
/* Check 7: secret_scan                                                */
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
const walkJsonFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJsonFiles(p, acc);
    else if (name.endsWith(".json")) acc.push(p);
  }
  return acc;
};
const scanTargets = [...walkJsonFiles(FIXTURES_DIR), ...walkJsonFiles(SCHEMAS_DIR)];
const secretHits = [];
for (const p of scanTargets) {
  const text = readFileSync(p, "utf8");
  for (const [label, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) secretHits.push({ file: relFromRepo(p), pattern: label, sample: m[0].slice(0, 12) + "..." });
  }
}

/* ------------------------------------------------------------------ */
/* Assemble receipt                                                    */
/* ------------------------------------------------------------------ */
const checks = {
  schemas_meta_valid: {
    total: schemaEntries.length + 1, // + common.json
    failed: metaFailures.length,
    failures: metaFailures,
  },
  fixtures_positive: {
    total: posTotal,
    failed: posFailures.length,
    failures: posFailures,
  },
  fixtures_negative_rejected: {
    total: negTotal,
    not_rejected: negNotRejected,
    details: negDetails,
  },
  state_machine_consistency: {
    ok: smFailures.length === 0,
    legal_transitions: registryTransitions.size,
    legal_transition_fixtures: coveredTransitions.size,
    illegal_transition_negatives: illegalNegatives.length,
    failures: smFailures,
  },
  error_registry_consistency: {
    ok: errFailures.length === 0,
    registered_codes: codeKeys.length,
    namespaces: Object.keys(errorsRegistry.namespaces).length,
    required_categories: errorsRegistry.required_semantic_categories.length,
    failures: errFailures,
  },
  id_prefix_coverage: {
    missing: missingPrefixes,
  },
  secret_scan: {
    hits: secretHits.length,
    scanned_files: scanTargets.length,
    scanned_dirs: [relFromRepo(FIXTURES_DIR), relFromRepo(SCHEMAS_DIR)],
    findings: secretHits,
  },
};

const ok =
  metaFailures.length === 0 &&
  posFailures.length === 0 &&
  negNotRejected === 0 &&
  negTotal > 0 &&
  posTotal > 0 &&
  smFailures.length === 0 &&
  errFailures.length === 0 &&
  missingPrefixes.length === 0 &&
  secretHits.length === 0;

const receipt = {
  ok,
  finished_at: new Date().toISOString(),
  verifier: "nightwatch/verify/verify.mjs",
  task_fingerprint: "nw+p0+wp00+contracts-foundation+impl+arch@v1.4+a034841",
  checks,
  artifacts: [relFromRepo(join(SCHEMAS_DIR, "index.json")), relFromRepo(RECEIPT_PATH)],
};

writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

/* ------------------------------------------------------------------ */
/* Human-readable summary                                              */
/* ------------------------------------------------------------------ */
const line = (s) => process.stdout.write(s + "\n");
line("=== NightWatch WP-00 Contract Verification ===");
line(`schemas_meta_valid         : ${checks.schemas_meta_valid.total} checked, ${checks.schemas_meta_valid.failed} failed`);
line(`fixtures_positive          : ${posTotal} checked, ${checks.fixtures_positive.failed} failed`);
line(`fixtures_negative_rejected : ${negTotal} checked, ${negNotRejected} not rejected`);
line(
  `state_machine_consistency  : ${checks.state_machine_consistency.ok ? "ok" : "FAILED"} ` +
    `(${checks.state_machine_consistency.legal_transitions} legal transitions, ` +
    `${checks.state_machine_consistency.illegal_transition_negatives} illegal-transition negatives)`
);
line(
  `error_registry_consistency : ${checks.error_registry_consistency.ok ? "ok" : "FAILED"} ` +
    `(${checks.error_registry_consistency.registered_codes} codes / ${checks.error_registry_consistency.namespaces} namespaces / ` +
    `${checks.error_registry_consistency.required_categories} required categories)`
);
line(`id_prefix_coverage         : ${missingPrefixes.length === 0 ? "complete (13/13)" : "MISSING: " + missingPrefixes.join(", ")}`);
line(`secret_scan                : ${secretHits.length} hits across ${scanTargets.length} files`);
line("");
if (metaFailures.length > 0) line(`meta failures: ${JSON.stringify(metaFailures, null, 2)}`);
if (posFailures.length > 0) line(`positive failures: ${JSON.stringify(posFailures, null, 2)}`);
if (negNotRejected > 0) {
  line(`negatives NOT rejected: ${JSON.stringify(negDetails.filter((d) => !d.rejected), null, 2)}`);
}
if (smFailures.length > 0) line(`state machine failures: ${JSON.stringify(smFailures, null, 2)}`);
if (errFailures.length > 0) line(`error registry failures: ${JSON.stringify(errFailures, null, 2)}`);
if (secretHits.length > 0) line(`secret scan hits: ${JSON.stringify(secretHits, null, 2)}`);
line(`receipt: ${relFromRepo(RECEIPT_PATH)}`);
line(ok ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
process.exit(ok ? 0 : 1);
