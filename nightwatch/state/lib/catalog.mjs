/**
 * NightWatch WP-03 — Machine-generated Catalog & object index (C14, §5.10 / WorkRequest §5.4)
 *
 * The catalog is NOT an authoritative store: it is a deterministic, machine-
 * generated index over the file fact sources under nightwatch/:
 *   - nightwatch/schemas/**   (WP-00 frozen contracts — read-only input)
 *   - nightwatch/fixtures/**  (WP-00 frozen fixtures — read-only input)
 *   - nightwatch/registry/**  (WP-01 registry facts — read-only input)
 *   - nightwatch/state/.store/** runtime products (audit events / locks /
 *     checkpoints) EXCLUDING the catalog's own output directory.
 *
 * rev1 §5.6 (scan exclusions & race tolerance):
 *   - any directory NAMED `.state` is excluded from the scan wherever it
 *     appears in the tree (e.g. nightwatch/registry/.state/, created and
 *     removed by WP-01's verifier while it runs) — runtime-rebuildable state
 *     is not a file fact source. nightwatch/state/.store/ is this component's
 *     own persistent store and keeps its original scan treatment (its name is
 *     ".store", not ".state");
 *   - files that vanish between enumeration and read (parallel lanes
 *     deleting files concurrently) are tolerated, skipped AND recorded —
 *     never a crash. Tolerated skips are returned via `skipped` and are NOT
 *     written into the catalog product (they are timing observations, not
 *     facts; writing them in would break rebuild determinism).
 *
 * Properties:
 *   - deterministic: same file tree → byte-identical catalog.json (sorted walk,
 *     sorted entries, canonical serialization, NO timestamps, NO random data);
 *   - rebuildable: deleting catalog.json and rebuilding yields byte-identical
 *     output (the catalog never carries catalog-only data);
 *   - queryable: by exact object_type and by object_id PREFIX (e.g. "audit_",
 *     "lock_", "session_").
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./audit.mjs";

const STATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/state
const NW_ROOT = join(STATE_ROOT, ".."); // .../nightwatch
const DEFAULT_STORE_DIR = join(STATE_ROOT, ".store");

const sha256Text = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sha256Bytes = (buf) => createHash("sha256").update(buf).digest("hex");

/** rev1 §5.6-1 — directory names never scanned, at any depth (runtime-rebuildable state is not a fact source). */
const EXCLUDED_DIR_NAMES = [".state"];
/** rev1 §5.6-1 — exclusion globs declared in the catalog product for self-description. */
const EXCLUSION_GLOBS = ["**/.state/**"];

/**
 * Deterministic recursive walk (sorted names). Returns paths relative to `root`.
 *
 * rev1 §5.6: skips any directory named `.state` at any depth, and tolerates
 * entries that vanish mid-walk (a parallel lane deleting files concurrently):
 * vanished entries are recorded into `vanished` ({file, reason}) instead of
 * crashing the scan.
 */
function walkSorted(root, relDir = "", acc = [], vanished = []) {
  const absDir = relDir === "" ? root : join(root, relDir);
  let names;
  try {
    names = readdirSync(absDir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      vanished.push({ file: relDir === "" ? "." : relDir, reason: "vanished_before_listdir" });
      return acc;
    }
    throw err;
  }
  for (const name of names.sort()) {
    if (EXCLUDED_DIR_NAMES.includes(name)) continue;
    const rel = relDir === "" ? name : `${relDir}/${name}`;
    const abs = join(root, rel);
    let isDir;
    try {
      isDir = statSync(abs).isDirectory();
    } catch (err) {
      if (err && err.code === "ENOENT") {
        vanished.push({ file: rel, reason: "vanished_before_stat" });
        continue;
      }
      throw err;
    }
    if (isDir) walkSorted(root, rel, acc, vanished);
    else acc.push(rel);
  }
  return acc;
}

const tryReadJson = (absPath) => {
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
};

const parseJsonBytes = (buf) => {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
};

function schemaVersionLookup() {
  const index = tryReadJson(join(NW_ROOT, "schemas", "index.json"));
  const map = new Map();
  if (index && index.objects) {
    for (const [name, meta] of Object.entries(index.objects)) map.set(name, meta.version);
  }
  return (name, fallback = null) => map.get(name) ?? fallback;
}

/** Catalog entry for a raw file fact (no object-level extraction). */
function fileEntry(objectType, objectId, relFile, version, checksum) {
  return { object_type: objectType, object_id: objectId, file: relFile, version, checksum };
}

/**
 * Build the catalog from the file fact sources. Pure function of the tree
 * (rev1 §5.6: `.state` directories never enter the scan; files that vanish
 * between enumeration and read are skipped and reported via `skipped`, never
 * a crash — the catalog product itself stays a pure function of the tree).
 *
 * @param {object} [options] {nightwatchRoot?, storeDir?, onEnumeratedFile?}
 *   - onEnumeratedFile(absPath): race-injection hook invoked synchronously for
 *     every scanned file AFTER enumeration and BEFORE its read (acceptance A10
 *     uses it to simulate a parallel lane deleting files mid-build).
 * @returns {{catalog: object, bytes: string, skipped: Array<{file: string, reason: string}>}}
 */
export function buildCatalog(options = {}) {
  const nwRoot = options.nightwatchRoot ?? NW_ROOT;
  const storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
  const relStore = relative(nwRoot, storeDir).split("\\").join("/"); // e.g. "state/.store"
  const catalogDirRel = `${relStore}/catalog`;
  const versionOf = schemaVersionLookup();
  const raceHook = typeof options.onEnumeratedFile === "function" ? options.onEnumeratedFile : null;

  /** rev1 §5.6-2 — files that vanish between enumeration and read: skip & record, never crash. */
  const skipped = [];
  const readOrSkip = (absPath, logRel) => {
    if (raceHook) raceHook(absPath);
    try {
      return readFileSync(absPath);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        skipped.push({ file: logRel, reason: "vanished_before_read" });
        return null;
      }
      throw err;
    }
  };

  const entries = [];

  // 1) schemas/** — WP-00 contracts (read-only facts)
  const schemasDir = join(nwRoot, "schemas");
  if (existsSync(schemasDir)) {
    for (const rel of walkSorted(schemasDir, "", [], skipped)) {
      const raw = readOrSkip(join(schemasDir, rel), `schemas/${rel}`);
      if (raw === null) continue;
      const parsed = parseJsonBytes(raw);
      const parts = rel.split("/");
      // schemas/<object>/v1.json → object name = dir; root-level files → basename
      const objectId = parts.length >= 2 ? parts[parts.length - 2] : parts[0].replace(/\.json$/, "");
      const version = parsed && typeof parsed["x-nightwatch-version"] === "string" ? parsed["x-nightwatch-version"] : versionOf(objectId);
      entries.push(fileEntry("schema", objectId, `schemas/${rel}`, version, sha256Bytes(raw)));
    }
  }

  // 2) fixtures/** — WP-00 fixtures (read-only facts)
  const fixturesDir = join(nwRoot, "fixtures");
  if (existsSync(fixturesDir)) {
    for (const rel of walkSorted(fixturesDir, "", [], skipped)) {
      const raw = readOrSkip(join(fixturesDir, rel), `fixtures/${rel}`);
      if (raw === null) continue;
      const objectId = rel.split("/").pop().replace(/\.json$/, "");
      entries.push(fileEntry("fixture", objectId, `fixtures/${rel}`, null, sha256Bytes(raw)));
    }
  }

  // 3) registry/** — WP-01 registry facts (read-only input; Coordinator-verified lane).
  //    rev1 §5.6-1: registry/.state/** (WP-01 verifier's rebuildable runtime
  //    tree, created/removed while it runs) is excluded by walkSorted; files
  //    vanishing mid-scan are tolerated (rejection-defect regression).
  const registryDir = join(nwRoot, "registry");
  if (existsSync(registryDir)) {
    for (const rel of walkSorted(registryDir, "", [], skipped)) {
      const raw = readOrSkip(join(registryDir, rel), `registry/${rel}`);
      if (raw === null) continue;
      entries.push(fileEntry("registry_file", `registry/${rel}`, `registry/${rel}`, null, sha256Bytes(raw)));
    }
  }

  // 4) state/.store/** runtime products (excluding the catalog's own directory)
  if (existsSync(storeDir)) {
    for (const rel of walkSorted(storeDir, "", [], skipped)) {
      const storeRel = `${relStore}/${rel}`;
      if (storeRel === catalogDirRel || storeRel.startsWith(`${catalogDirRel}/`)) continue;
      const raw = readOrSkip(join(storeDir, rel), storeRel);
      if (raw === null) continue;
      const parsed = parseJsonBytes(raw);

      if (storeRel === `${relStore}/audit/events.jsonl`) {
        // object-level entries: one per VALID audit event line
        const text = raw.toString("utf8");
        const lines = text.length === 0 ? [] : text.split("\n");
        const physical = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
        physical.forEach((line, i) => {
          let ev = null;
          try {
            ev = JSON.parse(line);
          } catch {
            ev = null;
          }
          if (ev && typeof ev.audit_id === "string" && typeof ev.idempotency_key === "string") {
            entries.push(fileEntry("audit_event", ev.audit_id, storeRel, versionOf("audit_event", "1.0.0"), sha256Text(canonicalJson(ev))));
          }
          void i;
        });
        entries.push(fileEntry("state_file", storeRel, storeRel, null, sha256Bytes(raw)));
        continue;
      }

      if (storeRel.startsWith(`${relStore}/locks/`) && rel.endsWith(".json") && parsed && typeof parsed.lock_id === "string") {
        entries.push(fileEntry("lock", parsed.lock_id, storeRel, versionOf("lock", "1.0.0"), sha256Text(canonicalJson(parsed))));
        continue;
      }

      if (storeRel.startsWith(`${relStore}/checkpoints/`) && rel.endsWith(".json")) {
        const name = rel.split("/").pop();
        if (/^seq-\d+\.json$/.test(name) && parsed && typeof parsed.session_id === "string" && Number.isInteger(parsed.sequence)) {
          entries.push(
            fileEntry("checkpoint", `${parsed.session_id}#${parsed.sequence}`, storeRel, versionOf("checkpoint", "1.0.0"), sha256Text(canonicalJson(parsed)))
          );
          continue;
        }
        entries.push(fileEntry("state_file", storeRel, storeRel, null, sha256Bytes(raw)));
        continue;
      }

      entries.push(fileEntry("state_file", storeRel, storeRel, null, sha256Bytes(raw)));
    }
  }

  entries.sort((a, b) => {
    if (a.object_type !== b.object_type) return a.object_type < b.object_type ? -1 : 1;
    if (a.object_id !== b.object_id) return a.object_id < b.object_id ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });

  const byType = {};
  for (const e of entries) byType[e.object_type] = (byType[e.object_type] || 0) + 1;

  const catalog = {
    catalog_version: "1.0.0",
    generated_by: "nightwatch/state/lib/catalog.mjs",
    source_root: "nightwatch",
    scan_roots: ["schemas", "fixtures", "registry", relStore],
    exclusions: [catalogDirRel, ...EXCLUSION_GLOBS],
    counts: { total: entries.length, by_object_type: byType },
    entries,
  };
  const bytes = `${JSON.stringify(catalog, null, 2)}\n`;
  return { catalog, bytes, skipped };
}

/**
 * Write the catalog to <storeDir>/catalog/catalog.json (atomic tmp+rename).
 * @returns {{path: string, bytes: string, catalog: object, skipped: Array<{file: string, reason: string}>}}
 */
export function writeCatalog(options = {}) {
  const storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
  const { catalog, bytes, skipped } = buildCatalog(options);
  const dir = join(storeDir, "catalog");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "catalog.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, bytes, "utf8");
  renameSync(tmp, target);
  return { path: target, bytes, catalog, skipped };
}

/** Delete the catalog file (for rebuild-determinism testing). */
export function deleteCatalog(options = {}) {
  const storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
  const target = join(storeDir, "catalog", "catalog.json");
  if (existsSync(target)) rmSync(target);
  return !existsSync(target);
}

/** Load a previously written catalog file. */
export function loadCatalog(options = {}) {
  const storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
  const target = join(storeDir, "catalog", "catalog.json");
  return tryReadJson(target);
}

/**
 * Query the object index.
 * @param {object} catalog catalog object (built or loaded)
 * @param {object} [criteria] {object_type?, id_prefix?}
 */
export function query(catalog, { object_type, id_prefix } = {}) {
  if (!catalog || !Array.isArray(catalog.entries)) return [];
  return catalog.entries.filter(
    (e) =>
      (object_type === undefined || e.object_type === object_type) &&
      (id_prefix === undefined || (typeof e.object_id === "string" && e.object_id.startsWith(id_prefix)))
  );
}
