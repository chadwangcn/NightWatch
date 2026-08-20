/**
 * NightWatch WP-01 — Registry store (persisted state layout).
 *
 * Layout under the store root (all files JSON, 2-space indent, newline-terminated
 * — byte-deterministic for a fixed input sequence and clock):
 *
 *   index.json                       list of registered apis
 *   entries/{api_id}.json            registry_entry/v1 artifacts
 *   history/{api_id}/{seq}.json      import_history/v1 artifacts (1-based sequence)
 *   normalized/{api_id}/{checksum}.json   normalized (read-only, rebuildable) IR copies
 *   inventory/{api_id}.json          Agent-visible API inventory (sanitized)
 *   diffs/{api_id}/{seq}.json        machine-readable diff receipts
 *   impacts/{api_id}/{seq}.json      machine-readable impact receipts
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

export class RegistryStore {
  /**
   * @param {{rootDir: string, clock: () => string, impactLinks?: Array}} opts
   */
  constructor({ rootDir, clock, impactLinks = [] }) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.impactLinks = impactLinks;
  }

  /** Wipe and recreate the store root (the store is fully rebuildable from sources). */
  reset() {
    rmSync(this.rootDir, { recursive: true, force: true });
    for (const d of ["entries", "history", "normalized", "inventory", "diffs", "impacts"]) {
      mkdirSync(join(this.rootDir, d), { recursive: true });
    }
    writeJson(join(this.rootDir, "index.json"), { apis: [] });
  }

  /* ---------------- entries ---------------- */

  getEntry(apiId) {
    return readJsonOrNull(join(this.rootDir, "entries", `${apiId}.json`));
  }

  saveEntry(apiId, entry) {
    writeJson(join(this.rootDir, "entries", `${apiId}.json`), entry);
    const indexFile = join(this.rootDir, "index.json");
    const index = readJsonOrNull(indexFile) || { apis: [] };
    if (!index.apis.some((a) => a.api_id === apiId)) {
      index.apis.push({ api_id: apiId, display_name: entry.display_name });
      index.apis.sort((a, b) => (a.api_id < b.api_id ? -1 : 1));
      writeJson(indexFile, index);
    }
  }

  /* ---------------- import history ---------------- */

  nextSequence(apiId) {
    const dir = join(this.rootDir, "history", apiId);
    if (!existsSync(dir)) return 1;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1;
  }

  saveHistory(apiId, seq, record) {
    writeJson(join(this.rootDir, "history", apiId, seqFile(seq)), record);
  }

  getHistory(apiId) {
    const dir = join(this.rootDir, "history", apiId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => readJson(join(dir, f)));
  }

  /* ---------------- normalized copies ---------------- */

  saveNormalized(apiId, checksum, ir) {
    writeJson(join(this.rootDir, "normalized", apiId, `${checksum}.json`), ir);
  }

  readNormalized(apiId, checksum) {
    return readJsonOrNull(join(this.rootDir, "normalized", apiId, `${checksum}.json`));
  }

  /* ---------------- inventory / receipts ---------------- */

  saveInventory(apiId, inventory) {
    writeJson(join(this.rootDir, "inventory", `${apiId}.json`), inventory);
  }

  getInventory(apiId) {
    return readJsonOrNull(join(this.rootDir, "inventory", `${apiId}.json`));
  }

  saveDiffReceipt(apiId, seq, diff) {
    writeJson(join(this.rootDir, "diffs", apiId, seqFile(seq)), diff);
  }

  saveImpactReceipt(apiId, seq, impact) {
    writeJson(join(this.rootDir, "impacts", apiId, seqFile(seq)), impact);
  }

  /* ---------------- queries ---------------- */

  listApis() {
    const index = readJsonOrNull(join(this.rootDir, "index.json"));
    return index ? index.apis.map((a) => a.api_id) : [];
  }
}
