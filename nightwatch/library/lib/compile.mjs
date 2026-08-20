/**
 * NightWatch WP-02 — Library Compiler (C07, architecture §5.5/WorkRequest §5.5).
 *
 * Deterministically compiles the validated+active cases of ONE scenario into a
 * Newman-executable Postman Collection v2.1.0 plus:
 *   - a compile manifest (input case list / versions / checksums / compiler
 *     version — NO timestamps, so identical inputs give identical manifests);
 *   - a source map (every request in the collection reverse-resolves to
 *     exactly one case_id).
 *
 * Determinism contract (A7): same input ⇒ byte-identical collection/manifest/
 * source map. Achieved by sorted traversal, fixed key order, canonical
 * serialization and zero wall-clock/UUID-v4/random content.
 *
 * The compiler performs NO risk judgement and NEVER alters Expected: test
 * scripts are mechanically translated from the case's assertion DSL lines
 * (lib/dsl.mjs) — nothing else.
 */
import { parseAssertion, toNewmanLines, appliesToStep } from "./dsl.mjs";
import { compileFailed, staticCheckFailed, caseNotFound } from "./errors.mjs";
import { bytesChecksum, deriveId } from "./ids.mjs";

const COMPILER_VERSION = "nightwatch-library-compiler@1";
const COLLECTION_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const serializeArtifact = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");

/** Deterministic postman-style UUID (8-4-4-4-12 hex) from a seed string. */
function deterministicUuid(seed) {
  const id = deriveId("uuid", { seed }); // 26 base32 chars — plenty of entropy
  const hex = Buffer.from(id, "utf8").toString("hex").padEnd(32, "0").slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

const headerList = (headers) =>
  Object.keys(headers)
    .sort()
    .map((key) => ({ key, value: headers[key] }));

function postmanUrl(path) {
  const raw = `{{base_url}}${path}`;
  const segments = path.split("?")[0].split("/").filter((s) => s.length > 0);
  return {
    raw,
    host: ["{{base_url}}"],
    path: segments,
  };
}

/** Resolve a case body_ref into dataset content from the library store. */
function resolveDataset(store, apiId, oneCase, bodyRef) {
  const ref = bodyRef === "__SELF__" ? `${oneCase.case_id}.json` : bodyRef;
  return store.getDataset(apiId, ref);
}

function buildItem(store, apiId, oneCase, stepIndex) {
  const step = oneCase.steps[stepIndex];
  const req = step.request;

  const headers = { ...(req.headers || {}) };
  let body = null;
  if (req.body_ref) {
    const dataset = resolveDataset(store, apiId, oneCase, req.body_ref);
    if (dataset === null || dataset === undefined) {
      throw Object.assign(new Error(`dataset not found for body_ref "${req.body_ref}" of case ${oneCase.case_id}`), {
        code: "CMP_STATIC_CHECK_FAILED",
      });
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    body = { mode: "raw", raw: JSON.stringify(dataset) };
  }

  // Mechanically translate the assertions that apply to THIS step.
  const exec = [];
  let assertionIndex = 0;
  for (const line of oneCase.assertions) {
    const parsed = parseAssertion(line);
    if (!appliesToStep(parsed, stepIndex + 1)) continue;
    assertionIndex += 1;
    exec.push(...toNewmanLines(parsed));
  }

  const stepSuffix = oneCase.steps.length > 1 ? ` · step ${stepIndex + 1}` : "";
  const item = {
    name: `${oneCase.case_id} · ${oneCase.title}${stepSuffix}`,
    request: {
      method: req.method,
      ...(Object.keys(headers).length > 0 ? { header: headerList(headers) } : {}),
      url: postmanUrl(req.path),
      ...(body ? { body } : {}),
    },
    event: [{ listen: "test", script: { exec } }],
  };
  return item;
}

/**
 * Compile one scenario's validated+active cases.
 * @param {import("./store.mjs").LibraryStore} store
 * @param {{apiId: string, scenarioId: string, statuses?: string[]}} input
 * @returns {{ok: true, collection: object, manifest: object, sourceMap: object}
 *          | {ok: false, error: object}}
 */
export function compileScenario(store, { apiId, scenarioId, statuses = ["validated", "active"] }) {
  const scenario = store.getScenario(scenarioId);
  if (!scenario) {
    return { ok: false, error: compileFailed(`scenario not found in the library: ${scenarioId}`, { scenario_id: scenarioId }) };
  }

  const items = [];
  const sourceRequests = [];
  const compiledCases = [];
  const skippedCases = [];

  for (const caseId of [...scenario.case_ids].sort()) {
    const oneCase = store.getCase(caseId);
    if (!oneCase) {
      return { ok: false, error: caseNotFound(`scenario references a case that is not in the library: ${caseId}`, { case_id: caseId, scenario_id: scenarioId }) };
    }
    if (!statuses.includes(oneCase.status)) {
      skippedCases.push({ case_id: caseId, status: oneCase.status });
      continue;
    }
    for (let i = 0; i < oneCase.steps.length; i += 1) {
      let item;
      try {
        item = buildItem(store, apiId, oneCase, i);
      } catch (e) {
        if (e.code === "CMP_STATIC_CHECK_FAILED") {
          return { ok: false, error: staticCheckFailed(e.message, { case_id: caseId }) };
        }
        return { ok: false, error: compileFailed(`case ${caseId} could not be compiled: ${e.message}`, { case_id: caseId }) };
      }
      items.push(item);
      sourceRequests.push({ item_name: item.name, step_index: i + 1, case_id: caseId });
    }
    compiledCases.push({
      case_id: caseId,
      status: oneCase.status,
      content_checksum: bytesChecksum(serializeArtifact(oneCase)),
    });
  }

  if (compiledCases.length === 0) {
    return {
      ok: false,
      error: compileFailed(`scenario ${scenarioId} has no cases in status [${statuses.join(", ")}] to compile`, {
        scenario_id: scenarioId,
      }),
    };
  }

  const collection = {
    info: {
      name: `${apiId} · ${scenario.name}`,
      _postman_id: deterministicUuid(`${apiId}|${scenarioId}`),
      description: `Deterministically compiled by the NightWatch Library Compiler (${COMPILER_VERSION}) from scenario ${scenario.scenario_id} revision ${scenario.revision}. Source map: source_map.json. Regenerating the same input reproduces this file byte-for-byte.`,
      schema: COLLECTION_SCHEMA,
    },
    item: items,
  };

  const sourceMap = {
    api_id: apiId,
    scenario_id: scenarioId,
    scenario_revision: scenario.revision,
    requests: sourceRequests,
  };

  // Static validation of the compiled asset BEFORE it is returned (CMP_STATIC_CHECK_FAILED).
  const staticIssues = [];
  if (collection.info.schema !== COLLECTION_SCHEMA) staticIssues.push("collection schema url wrong");
  if (!Array.isArray(collection.item) || collection.item.length === 0) staticIssues.push("collection has no items");
  for (const item of collection.item) {
    if (!item.request || typeof item.request.method !== "string") staticIssues.push(`item "${item.name}" has no method`);
    if (!item.request || !item.request.url || typeof item.request.url.raw !== "string") staticIssues.push(`item "${item.name}" has no url.raw`);
    if (!item.event || !item.event[0] || !Array.isArray(item.event[0].script.exec) || item.event[0].script.exec.length === 0) {
      staticIssues.push(`item "${item.name}" has no test script`);
    }
  }
  if (staticIssues.length > 0) {
    return { ok: false, error: staticCheckFailed("compiled collection failed static validation", { issues: staticIssues.slice(0, 5) }) };
  }

  const manifest = {
    compiler_version: COMPILER_VERSION,
    api_id: apiId,
    scenario_id: scenarioId,
    scenario_revision: scenario.revision,
    compiled_from_statuses: [...statuses].sort(),
    cases: compiledCases.sort((a, b) => (a.case_id < b.case_id ? -1 : 1)),
    skipped_cases: skippedCases.sort((a, b) => (a.case_id < b.case_id ? -1 : 1)),
    collection: { file: "collection.json", checksum: bytesChecksum(serializeArtifact(collection)) },
    source_map: { file: "source_map.json", checksum: bytesChecksum(serializeArtifact(sourceMap)) },
  };

  return { ok: true, collection, manifest, sourceMap };
}
