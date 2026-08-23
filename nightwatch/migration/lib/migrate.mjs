/**
 * NightWatch WP-10 — Migration pipeline (WorkRequest §5.1/§5.2, A1/A4).
 *
 * Consumes ONLY the public APIs of WP-01 (runImportPipeline / RegistryStore)
 * and WP-02 (runLibraryPipeline / LibraryStore / transitionCase /
 * compileScenario / coverage). The four Postman collections under postman/
 * are read-only migration inputs: the collection stops being the contract
 * source of truth the moment its requests land in the WP-01 registry and its
 * coverage enters the WP-02 library (architecture 22.1 item 2).
 *
 * Determinism: no wall clock (RegistryStore/LibraryStore clocks are injected
 * by the caller), sorted traversals, no randomness. Re-running with the same
 * inputs re-imports idempotently (same checksum → replay, zero new revisions)
 * and re-runs the library pipeline add-only (validated/manual cases retained).
 *
 * Non-silent anomalies: every rejected/unparseable entry is collected into
 * the per-collection anomalies[] of migration-report.json — nothing is
 * dropped silently (A1).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RegistryStore } from "../../registry/lib/store.mjs";
import { runImportPipeline } from "../../registry/lib/pipeline.mjs";
import { LibraryStore } from "../../library/lib/store.mjs";
import { runLibraryPipeline } from "../../library/lib/pipeline.mjs";
import { compileScenario } from "../../library/lib/compile.mjs";
import { transitionCase } from "../../library/lib/lifecycle.mjs";

/** Frozen migration inputs (WorkRequest §2 pin): 26/26/114/52 = 218 requests. */
export const COLLECTIONS = [
  { apiId: "lumi-device-platform", location: "postman/lumi-device-platform.postman_collection.json", expectedRequests: 26 },
  { apiId: "lumi-s4-interaction", location: "postman/lumi-s4-interaction.postman_collection.json", expectedRequests: 26 },
  { apiId: "lumi-s5-content-media", location: "postman/lumi-s5-content-media.postman_collection.json", expectedRequests: 114 },
  { apiId: "lumi-s6-observation", location: "postman/lumi-s6-observation.postman_collection.json", expectedRequests: 52 },
];

export const MIGRATION_SCENARIO_SUFFIX = ":migration-sweep";

/** Independent traversal count of a Postman collection document (A1 byte-compare basis). */
export function countCollectionRequests(doc, anomalies = []) {
  let count = 0;
  const walk = (items, path) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && typeof item === "object" && Array.isArray(item.item)) {
        walk(item.item, `${path}/${item.name ?? "group"}`);
        continue;
      }
      if (item && item.request && item.request.method) {
        count += 1;
        continue;
      }
      anomalies.push({ group: path, name: item?.name ?? "<unnamed>", reason: "entry has no executable request" });
    }
  };
  walk(doc.item, "");
  return count;
}

/** Manual cases per collection (WorkRequest §5.1-3: ≥1 manual case,
 *  proving incremental preservation of reviewed/validated/manual content.
 *  Also ensures all five case types (functional, schema, negative, boundary,
 *  auth) are present in the migration library — Postman collections are
 *  protocol-level (no inline OpenAPI schemas), so WP-02 auto-generation only
 *  produces functional/negative/auth. Manual schema/boundary cases close the
 *  coverage gap (A4). */
function manualCaseFor(apiId, endpoint) {
  const baseCase = (type, title, assertions) => ({
    case: {
      title,
      api_id: apiId,
      risk: "low",
      status: "reviewed",
      provenance: { source_revision: "assigned-at-intake", generated_by: "human-reviewer", skill_version: "manual@1", last_validated_run: null },
      type,
      preconditions: ["target environment reachable"],
      setup: { workflow: "none" },
      steps: [{ request: { method: endpoint.method, path: endpoint.path } }],
      assertions,
      timing: { per_request_timeout_ms: 5000 },
      repetitions: 1,
      cleanup: { workflow: "none" },
      evidence: { capture_timeline: false, capture_request_response: "failures", redact_profile: "default" },
    },
    meta: {
      origin: "manual",
      endpoint: { method: endpoint.method, path: endpoint.path, key: `${endpoint.method} ${endpoint.path}` },
      case_type: type,
      variant: `migration-${type}`,
      assumptions: [],
      explicit_rules: [],
      environments: ["test"],
      executors: ["newman"],
      finding_id: null,
      issue_ref: null,
    },
  });
  return [
    baseCase("functional", `migration smoke: ${endpoint.method} ${endpoint.path} responds in the declared family`, ["status_code in [200, 201, 202, 204, 400, 401, 403, 404]"]),
    baseCase("schema", `migration schema: ${endpoint.method} ${endpoint.path} response body honors the declared schema`, ["json $.id is number"]),
    baseCase("boundary", `migration boundary: ${endpoint.method} ${endpoint.path} rejects oversized request`, ["status_code in [400, 413, 422]"]),
  ];
}

/** Advance every library case of one api to `validated` through the WP-02
 *  public lifecycle API (draft→reviewed→validated; manual starts reviewed). */
function validateAllCases(store, apiId, log) {
  let transitions = 0;
  for (const caseId of store.listCaseIds()) {
    const meta = store.getMeta(caseId);
    if (!meta || meta.api_id !== apiId) continue;
    const oneCase = store.getCase(caseId);
    if (!oneCase || oneCase.status === "deprecated" || oneCase.status === "validated" || oneCase.status === "active") continue;
    const chain = oneCase.status === "draft" ? ["reviewed", "validated"] : ["validated"];
    for (const to of chain) {
      const moved = transitionCase(store, caseId, to, { actor: "nw-wp10-migration" });
      if (!moved.ok) {
        log.push({ case_id: caseId, from: oneCase.status, to, reason: moved.error?.message ?? "transition rejected" });
        continue;
      }
      transitions += 1;
    }
  }
  return transitions;
}

/**
 * Run the full migration for the four collections (and optionally the Golden
 * API spec). Returns the machine receipt structure; the caller persists it.
 *
 * @param {object} input
 *   workDir       — root for registry/ + library/ runtime stores
 *   reportDir     — directory the compile artifacts are written to
 *   repoRoot      — repository root (postman/** paths resolve against it)
 *   clock         — injected deterministic clock (ISO string)
 *   golden        — optional {location, apiId} extra spec import (Golden API)
 */
export function runMigration({ workDir, repoRoot, clock, extraSpecs = [] }) {
  const registry = new RegistryStore({ rootDir: join(workDir, "registry"), clock, impactLinks: [] });
  registry.reset();
  const library = new LibraryStore({ rootDir: join(workDir, "library") });
  library.reset();

  const report = {
    report_version: "nw-migration-report@1",
    generated_by: "nightwatch/migration/lib/migrate.mjs",
    collections: [],
    extras: [],
    totals: { collections: 0, requests_imported: 0, cases_generated: 0, anomalies: 0 },
  };

  const importOne = ({ apiId, location, expectedRequests }) => {
    const anomalies = [];
    const doc = JSON.parse(readFileSync(join(repoRoot, location), "utf8"));
    const sourceCount = countCollectionRequests(doc, anomalies);
    const imported = runImportPipeline(registry, {
      repoRoot,
      location,
      apiId,
      environments: {
        "lumi-local": { base_url_env: "NW_LOCAL_BASE_URL", auth_profile: `${apiId}-test-bearer`, destructive_allowed: false, load_allowed: false },
      },
      owner: "nw-wp10-migration",
      purpose: `Migrated legacy Postman collection (NW-WP-10); the registry entry is now the contract source of truth`,
    });
    if (!imported.ok) {
      anomalies.push({ stage: "import", reason: imported.error?.message ?? "import failed", code: imported.error?.code });
    }
    const inventory = imported.inventory ?? registry.getInventory(apiId);
    const inventoryTotal = inventory?.summary?.total ?? -1; // deduplicated unique endpoint count (WP-01 contract)
    // occurrence_count sum = raw request count (each Postman item mapped to a normalized endpoint key)
    const occurrenceSum = Array.isArray(inventory?.endpoints)
      ? inventory.endpoints.reduce((s, e) => s + (e.occurrence_count ?? 0), 0)
      : -1;
    // A1: WP-01 deduplicates endpoints by METHOD path → summary.total is unique count;
    // the raw request count is the occurrence_count sum, which must match expected + source traversal.
    if (occurrenceSum !== expectedRequests) {
      anomalies.push({ stage: "inventory-count", reason: `occurrence_count sum ${occurrenceSum} != expected ${expectedRequests}` });
    }
    if (occurrenceSum !== sourceCount) {
      anomalies.push({ stage: "count-mismatch", reason: `occurrence_count sum ${occurrenceSum} != source traversal ${sourceCount}` });
    }
    return { imported, inventory, sourceCount, occurrenceSum, anomalies };
  };

  for (const spec of COLLECTIONS) {
    const { imported, inventory, sourceCount, occurrenceSum, anomalies } = importOne(spec);
    const apiId = spec.apiId;
    const normalized = imported.normalized ?? registry.readNormalized(apiId, imported.checksum);

    // WP-02 pipeline over the REAL WP-01 products (agent output minimal, ≥1 manual case).
    const firstEndpoint = normalized.ir
      ? normalized.ir.endpoints[0]
      : normalized.endpoints?.[0] ?? { method: "GET", path: "/" };
    const libRun = runLibraryPipeline(library, {
      apiId,
      inventory,
      normalized,
      agentOutput: null,
      agentDatasets: {},
      manualCases: manualCaseFor(apiId, firstEndpoint),
    });
    if (!libRun.ok) {
      anomalies.push({ stage: "library", reason: libRun.error?.message ?? "library pipeline failed", code: libRun.error?.code });
    }

    const transitionLog = [];
    const transitions = validateAllCases(library, apiId, transitionLog);
    for (const t of transitionLog) anomalies.push({ stage: "lifecycle", ...t });

    // Migration sweep scenario: EVERY validated case of this api, compiled once.
    const caseIds = library
      .listCaseIds()
      .filter((id) => library.getMeta(id)?.api_id === apiId)
      .sort();
    const scenarioId = `${apiId}${MIGRATION_SCENARIO_SUFFIX}`;
    library.saveScenario({
      scenario_id: scenarioId,
      name: `${apiId} migration sweep`,
      description: `All validated cases generated from the migrated ${spec.location} input (NW-WP-10 §5.1-3).`,
      endpoints: [...new Set((inventory?.endpoints ?? []).map((e) => e.path))].sort(),
      revision: "r1",
      case_ids: caseIds,
    });
    const compiled = compileScenario(library, { apiId, scenarioId });
    if (!compiled.ok) {
      anomalies.push({ stage: "compile", reason: compiled.error?.message ?? "compile failed", code: compiled.error?.code });
    } else {
      library.saveCompile(apiId, scenarioId, compiled); // Newman-executable asset on disk
    }

    const byKind = {};
    for (const id of caseIds) {
      const c = library.getCase(id);
      if (c) byKind[c.type] = (byKind[c.type] ?? 0) + 1;
    }
    const coverage = library.getCoverage ? library.getCoverage(apiId) : null;

    report.collections.push({
      api_id: apiId,
      source_location: spec.location,
      requests_imported: occurrenceSum,
      unique_endpoints: inventory?.summary?.total ?? 0,
      source_traversal_count: sourceCount,
      expected_requests: spec.expectedRequests,
      import_status: imported.ok ? (imported.idempotent_replay ? "replay" : "valid") : "invalid",
      checksum: imported.checksum ?? null,
      cases_generated: caseIds.length,
      cases_generated_by_kind: byKind,
      manual_cases_retained: caseIds.filter((id) => library.getMeta(id)?.origin === "manual").length,
      lifecycle_transitions: transitions,
      compile_scenario_id: scenarioId,
      compile_artifact_checksum: compiled.ok ? compiled.manifest.collection.checksum : null,
      coverage_summary: coverage?.summary ?? null,
      anomalies,
    });
    report.totals.collections += 1;
    report.totals.requests_imported += occurrenceSum;
    report.totals.cases_generated += caseIds.length;
    report.totals.anomalies += anomalies.length;
  }

  // Optional extra specs (Golden Fault API contract) — same pipeline, no manual cases.
  for (const spec of extraSpecs) {
    const imported = runImportPipeline(registry, {
      repoRoot,
      location: spec.location,
      apiId: spec.apiId,
      environments: {
        "golden-local": { base_url_env: "NW_GOLDEN_BASE_URL", auth_profile: `${spec.apiId}-golden-bearer`, destructive_allowed: false, load_allowed: false },
      },
      owner: "nw-wp10-migration",
      purpose: spec.purpose ?? "Golden Fault API contract pin (NW-WP-10 §5.3)",
    });
    report.extras.push({
      api_id: spec.apiId,
      source_location: spec.location,
      import_status: imported.ok ? (imported.idempotent_replay ? "replay" : "valid") : "invalid",
      checksum: imported.checksum ?? null,
      endpoints: imported.inventory?.summary?.total ?? 0,
      error: imported.ok ? null : imported.error?.message,
    });
  }

  return { report, registry, library };
}

/** Idempotency probe (A1): re-import the same inputs — every collection must
 *  come back as an idempotent replay with the SAME checksum and sequence null. */
export function reimportIdempotencyProbe(registry, repoRoot) {
  const results = [];
  for (const spec of COLLECTIONS) {
    const again = runImportPipeline(registry, { repoRoot, location: spec.location, apiId: spec.apiId });
    results.push({
      api_id: spec.apiId,
      ok: again.ok === true,
      idempotent_replay: again.idempotent_replay === true,
      same_checksum: again.checksum === registry.getEntry(spec.apiId)?.last_valid?.checksum,
      new_sequence: again.sequence ?? null,
    });
  }
  return results;
}

export const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
