/**
 * NightWatch WP-02 — Library store (persisted layout).
 *
 * Layout under the store root (all files JSON, 2-space indent, newline
 * terminated — byte-deterministic for a fixed input, NO wall-clock fields
 * so two runs of the same input produce identical trees):
 *
 *   index.json                                      apis → plan/scenarios/cases/change reports
 *   plans/{plan_id}.json                            test_plan/v1 artifacts
 *   scenarios/{scenario_id}.json                    scenario/v1 artifacts
 *   cases/{case_id}.json                            test_case/v1 artifacts
 *   meta/{case_id}.json                             per-case sidecar (traceability 8, assumptions,
 *                                                   lifecycle transitions, flags, deprecation)
 *   datasets/{api_id}/{ref}.json                    synthetic request bodies ("__SELF__" refs are
 *                                                   stored as datasets/{api_id}/{case_id}.json)
 *   coverage/{api_id}.json                          endpoint × case-type matrix + uncovered list
 *   changes/{api_id}/{seq}.json                     regeneration change reports (A4)
 *   compile/{api_id}/{scenario_id}/*.json           compiled collection + manifest + source map
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const writeJson = (file, obj) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readJsonOrNull = (file) => {
  if (!existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
};
const seqFile = (seq) => `${String(seq).padStart(4, "0")}.json`;

export class LibraryStore {
  /** @param {{rootDir: string}} opts */
  constructor({ rootDir }) {
    this.rootDir = rootDir;
  }

  /** Wipe and recreate the store root (the library is rebuildable from sources). */
  reset() {
    rmSync(this.rootDir, { recursive: true, force: true });
    for (const d of ["plans", "scenarios", "cases", "meta", "datasets", "coverage", "changes", "compile"]) {
      mkdirSync(join(this.rootDir, d), { recursive: true });
    }
    writeJson(join(this.rootDir, "index.json"), { apis: {} });
  }

  /* ---------------- index ---------------- */

  getIndex() {
    return readJsonOrNull(join(this.rootDir, "index.json")) || { apis: {} };
  }

  /** Merge-update one api's index entry. */
  updateApiIndex(apiId, patch) {
    const index = this.getIndex();
    const prev = index.apis[apiId] || {};
    index.apis[apiId] = { ...prev, ...patch };
    // Deterministic key order for byte-identical outputs.
    index.apis[apiId].case_ids = [...new Set(index.apis[apiId].case_ids || [])].sort();
    index.apis[apiId].scenario_ids = [...new Set(index.apis[apiId].scenario_ids || [])].sort();
    index.apis = Object.fromEntries(Object.keys(index.apis).sort().map((k) => [k, index.apis[k]]));
    writeJson(join(this.rootDir, "index.json"), index);
  }

  getApiIndex(apiId) {
    return this.getIndex().apis[apiId] || null;
  }

  /* ---------------- plans / scenarios / cases ---------------- */

  savePlan(plan) {
    writeJson(join(this.rootDir, "plans", `${plan.plan_id}.json`), plan);
  }

  getPlan(planId) {
    return readJsonOrNull(join(this.rootDir, "plans", `${planId}.json`));
  }

  saveScenario(scenario) {
    writeJson(join(this.rootDir, "scenarios", `${scenario.scenario_id}.json`), scenario);
  }

  getScenario(scenarioId) {
    return readJsonOrNull(join(this.rootDir, "scenarios", `${scenarioId}.json`));
  }

  saveCase(oneCase) {
    writeJson(join(this.rootDir, "cases", `${oneCase.case_id}.json`), oneCase);
  }

  getCase(caseId) {
    return readJsonOrNull(join(this.rootDir, "cases", `${caseId}.json`));
  }

  saveMeta(meta) {
    writeJson(join(this.rootDir, "meta", `${meta.case_id}.json`), meta);
  }

  getMeta(caseId) {
    return readJsonOrNull(join(this.rootDir, "meta", `${caseId}.json`));
  }

  /** All case ids present on disk (physical set — the library never deletes). */
  listCaseIds() {
    const dir = join(this.rootDir, "cases");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  }

  /* ---------------- datasets ---------------- */

  saveDataset(apiId, ref, content) {
    writeJson(join(this.rootDir, "datasets", apiId, ref), content);
  }

  getDataset(apiId, ref) {
    return readJsonOrNull(join(this.rootDir, "datasets", apiId, ref));
  }

  /* ---------------- coverage / change reports ---------------- */

  saveCoverage(apiId, coverage) {
    writeJson(join(this.rootDir, "coverage", `${apiId}.json`), coverage);
  }

  getCoverage(apiId) {
    return readJsonOrNull(join(this.rootDir, "coverage", `${apiId}.json`));
  }

  nextChangeSeq(apiId) {
    const dir = join(this.rootDir, "changes", apiId);
    if (!existsSync(dir)) return 1;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1;
  }

  saveChangeReport(apiId, seq, report) {
    writeJson(join(this.rootDir, "changes", apiId, seqFile(seq)), report);
  }

  getChangeReports(apiId) {
    const dir = join(this.rootDir, "changes", apiId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => readJson(join(dir, f)));
  }

  /* ---------------- compile artifacts ---------------- */

  saveCompile(apiId, scenarioId, { collection, manifest, sourceMap }) {
    const dir = join(this.rootDir, "compile", apiId, scenarioId);
    writeJson(join(dir, "collection.json"), collection);
    writeJson(join(dir, "manifest.json"), manifest);
    writeJson(join(dir, "source_map.json"), sourceMap);
  }

  getCompile(apiId, scenarioId) {
    const dir = join(this.rootDir, "compile", apiId, scenarioId);
    if (!existsSync(dir)) return null;
    return {
      collection: readJson(join(dir, "collection.json")),
      manifest: readJson(join(dir, "manifest.json")),
      sourceMap: readJson(join(dir, "source_map.json")),
    };
  }
}
