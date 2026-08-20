/**
 * NightWatch WP-01 — Contract intake pipeline (architecture §9).
 *
 *   Discover → Fetch → Hash → Parse → Normalize → Validate
 *           → Diff → Impact Analysis → Registry Update
 *
 * Hard synchronization rules implemented here (§9.1):
 *   - same-checksum imports are idempotent replays: the existing entry is returned,
 *     no new import_history record, no re-generated assets, no re-computed diff;
 *   - a bad spec (fetch-integrity / parse / validate failure) is recorded in
 *     import_history with status=invalid + failure reason, and NEVER overwrites
 *     the entry's last_valid version;
 *   - new endpoints land in the uncovered inventory list;
 *   - removed/breaking changes are marked destructive;
 *   - security scheme changes are marked security_changed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { parseSpec, detectFormat } from "./parse.mjs";
import { diffNormalized } from "./diff.mjs";
import { analyzeImpact } from "./impact.mjs";
import { sanitizeForAgent, makeRefPolicy } from "./untrusted.mjs";
import { specInvalid, sourceUnavailable, checksumMismatch } from "./errors.mjs";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Discover step: enumerate candidate spec files under a directory (recursively).
 * @param {string} dir absolute directory path
 * @param {(name: string) => boolean} [predicate] file-name filter
 * @returns {string[]} absolute file paths (sorted)
 */
export function discoverSpecs(dir, predicate = () => true) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = `${d}/${name}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json") && predicate(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const coveredLinkFor = (impactLinks, apiId, method, path) => {
  const link = (impactLinks || []).find((l) => l.api_id === apiId && l.method === method && l.path === path);
  return link || null;
};

function buildInventory({ apiId, ir, clock, impactLinks }) {
  const endpoints = [];
  const uncovered = [];
  for (const ep of ir.endpoints) {
    const link = coveredLinkFor(impactLinks, apiId, ep.method, ep.path);
    const assoc = link || { plans: [], scenarios: [], cases: [] };
    const covered = Boolean(link) && assoc.plans.length + assoc.scenarios.length + assoc.cases.length > 0;
    endpoints.push({
      method: ep.method,
      path: ep.path,
      group: ep.group,
      operation_id: ep.operation_id,
      occurrence_count: ep.occurrences,
      description_agent_view: sanitizeForAgent(ep.description),
      covered,
      plans: assoc.plans,
      scenarios: assoc.scenarios,
      cases: assoc.cases,
    });
    if (!covered) uncovered.push({ method: ep.method, path: ep.path });
  }
  return {
    api_id: apiId,
    source: { revision: ir.source_pin.revision, checksum: ir.source_pin.checksum },
    generated_at: clock(),
    agent_view_policy: "descriptions are UNTRUSTED_API_DATA; injection-flagged text is quarantined",
    endpoints,
    summary: {
      total: endpoints.length,
      covered: endpoints.filter((e) => e.covered).length,
      uncovered: uncovered.length,
    },
    uncovered,
  };
}

/**
 * Run the full intake pipeline for one spec file.
 *
 * @param {import("./store.mjs").RegistryStore} store
 * @param {{location: string, apiId: string, repoRoot: string, environments?: object,
 *          owner?: string, purpose?: string, expectedChecksum?: string,
 *          refPolicy?: object}} options
 * @returns {object} machine-readable import result
 */
export function runImportPipeline(store, options) {
  const { location, apiId, repoRoot } = options;
  const steps = [];
  const step = (name, data) => steps.push({ step: name, ...data });
  const now = () => store.clock();

  const absLocation = isAbsolute(location) ? location : `${repoRoot}/${location}`;
  const relLocation = relative(repoRoot, absLocation) || location;
  const refPolicy = options.refPolicy || makeRefPolicy();

  /* 1. Discover — resolve the source reference to a file source. */
  step("discover", { source_type: "file", location: relLocation });

  /* 2. Fetch — read the raw bytes. */
  let bytes;
  try {
    bytes = readFileSync(absLocation);
    step("fetch", { bytes: bytes.length });
  } catch (e) {
    const err = sourceUnavailable(`contract source could not be fetched: ${relLocation}`, { location: relLocation });
    step("fetch", { failed: true });
    return { ok: false, api_id: apiId, status: "invalid", error: err, steps, idempotent_replay: false };
  }

  /* 3. Hash — sha256 over the raw file bytes (import identity). */
  const checksum = sha256Hex(bytes);
  const revision = `sha256:${checksum}`;
  step("hash", { checksum, algorithm: "sha256" });

  /* 3b. Pinned-checksum integrity check (REG_CHECKSUM_MISMATCH). */
  if (options.expectedChecksum && options.expectedChecksum !== checksum) {
    const err = checksumMismatch("fetched checksum does not match the pinned checksum", {
      location: relLocation,
      expected: options.expectedChecksum,
      actual: checksum,
    });
    const seq = store.nextSequence(apiId);
    const record = {
      api_id: apiId,
      sequence: seq,
      source_revision: revision,
      checksum,
      imported_at: now(),
      status: "invalid",
      error: err.message,
    };
    store.saveHistory(apiId, seq, record);
    const entry = store.getEntry(apiId);
    if (entry) {
      entry.latest_import = { revision, checksum, imported_at: record.imported_at, status: "invalid" };
      store.saveEntry(apiId, entry);
    }
    step("hash", { pinned_check: "failed" });
    return {
      ok: false,
      api_id: apiId,
      sequence: seq,
      checksum,
      revision,
      status: "invalid",
      error: err,
      entry,
      steps,
      idempotent_replay: false,
    };
  }
  step("hash", { pinned_check: options.expectedChecksum ? "passed" : "not-pinned" });

  /* Idempotency: same checksum as the last VALID import → replay the existing entry (§9.1 rule 3). */
  const existingEntry = store.getEntry(apiId);
  if (existingEntry && existingEntry.last_valid && existingEntry.last_valid.checksum === checksum) {
    step("idempotency_check", { result: "replay", last_valid_checksum: existingEntry.last_valid.checksum });
    return {
      ok: true,
      api_id: apiId,
      status: "replay",
      idempotent_replay: true,
      checksum,
      revision,
      entry: existingEntry,
      sequence: null,
      diff: null,
      impact: null,
      inventory: store.getInventory(apiId),
      steps,
    };
  }
  step("idempotency_check", {
    result: "new-import",
    existing_last_valid: existingEntry && existingEntry.last_valid ? existingEntry.last_valid.checksum : null,
  });

  const failInvalid = (message, details, stepName) => {
    const err = specInvalid(message, details);
    const seq = store.nextSequence(apiId);
    const record = {
      api_id: apiId,
      sequence: seq,
      source_revision: revision,
      checksum,
      imported_at: now(),
      status: "invalid",
      error: err.message,
    };
    store.saveHistory(apiId, seq, record);
    let entry = store.getEntry(apiId);
    if (entry) {
      // Bad spec NEVER overwrites last_valid (§9.1 rule 4): only latest_import moves.
      entry.latest_import = { revision, checksum, imported_at: record.imported_at, status: "invalid" };
      store.saveEntry(apiId, entry);
    }
    step(stepName, { failed: true, reason: message });
    return {
      ok: false,
      api_id: apiId,
      sequence: seq,
      checksum,
      revision,
      status: "invalid",
      error: err,
      entry,
      steps,
      idempotent_replay: false,
    };
  };

  /* 4. Parse — JSON syntax + format detection. */
  let doc;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return failInvalid(`JSON parse failed: ${e.message}`, { location: relLocation }, "parse");
  }
  const format = detectFormat(doc);
  if (format === null) {
    return failInvalid("unrecognized spec format: expected Postman Collection v2.1.0 or OpenAPI 3.x JSON", { location: relLocation }, "parse");
  }
  step("parse", { format });

  /* 5. Normalize — build the NightWatch IR (untrusted marking + external-ref policy). */
  const sourcePin = { type: "file", location: relLocation, revision, checksum };
  const { ir, issues } = parseSpec(doc, { apiId, sourcePin, refPolicy });
  step("normalize", {
    format: ir.format,
    endpoints: ir.endpoints.length,
    untrusted_texts_marked: true,
    external_refs_rejected: ir.injection_report.external_refs_rejected.length,
  });

  /* 6. Validate — structural validation of the normalized spec. */
  if (issues.length > 0) {
    return failInvalid(`spec failed structural validation: ${issues.join("; ")}`, { issues: issues.slice(0, 10) }, "validate");
  }
  step("validate", { result: "passed" });

  /* 7. Diff — against the previous VALID normalized version. */
  const prevIR = existingEntry && existingEntry.last_valid ? store.readNormalized(apiId, existingEntry.last_valid.checksum) : null;
  const diff = diffNormalized(prevIR, ir);
  step("diff", {
    initial: diff.initial,
    added: diff.endpoints.added.length,
    removed: diff.endpoints.removed.length,
    modified: diff.endpoints.modified.length,
    destructive: diff.destructive,
    security_changed: diff.security_changed,
  });

  /* 8. Impact analysis — changed endpoints → associated plans/scenarios/cases. */
  const impact = analyzeImpact({ apiId, diff, links: store.impactLinks });
  step("impact_analysis", {
    impacted: impact.impacted.length,
    uncovered_new_endpoints: impact.uncovered_new_endpoints.length,
    reviews_required: impact.reviews_required.length,
  });

  /* 9. Registry update — entry + history + normalized copy + inventory + receipts. */
  const importedAt = now();
  const seq = store.nextSequence(apiId);
  const environments =
    options.environments || (existingEntry ? existingEntry.environments : undefined) || {
      test: { base_url_env: "NIGHTWATCH_TEST_BASE_URL", auth_profile: `${apiId}-test-bearer`, destructive_allowed: false },
    };

  const entry = {
    api_id: apiId,
    display_name: ir.display_name,
    ...(options.owner || (existingEntry && existingEntry.owner) ? { owner: options.owner || existingEntry.owner } : {}),
    purpose: options.purpose || (existingEntry && existingEntry.purpose) || `Imported from ${relLocation}`,
    source: { type: "file", location: relLocation, revision, checksum },
    last_valid: { revision, checksum, imported_at: importedAt },
    latest_import: { revision, checksum, imported_at: importedAt, status: "valid" },
    environments,
  };

  const historyRecord = {
    api_id: apiId,
    sequence: seq,
    source_revision: revision,
    checksum,
    imported_at: importedAt,
    status: "valid",
  };

  const inventory = buildInventory({ apiId, ir, clock: store.clock, impactLinks: store.impactLinks });

  store.saveNormalized(apiId, checksum, ir);
  store.saveEntry(apiId, entry);
  store.saveHistory(apiId, seq, historyRecord);
  store.saveInventory(apiId, inventory);
  store.saveDiffReceipt(apiId, seq, diff);
  store.saveImpactReceipt(apiId, seq, impact);
  step("registry_update", {
    entry_path: `entries/${apiId}.json`,
    history_path: `history/${apiId}/${String(seq).padStart(4, "0")}.json`,
    normalized_path: `normalized/${apiId}/${checksum}.json`,
    inventory_path: `inventory/${apiId}.json`,
  });

  return {
    ok: true,
    api_id: apiId,
    status: "valid",
    idempotent_replay: false,
    sequence: seq,
    checksum,
    revision,
    entry,
    diff,
    impact,
    inventory,
    injection_report: ir.injection_report,
    normalized: ir,
    steps,
  };
}
