/**
 * NightWatch WP-01 — WP-00 schema validation for persisted artifacts.
 *
 * Loads the FROZEN WP-00 schemas (read-only; never modified):
 *   - nightwatch/schemas/common.json
 *   - nightwatch/schemas/registry_entry/v1.json
 *   - nightwatch/schemas/import_history/v1.json
 *   - nightwatch/schemas/error/v1.json
 * and validates registry artifacts against them with AJV 2020-12.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const NW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // .../nightwatch
const SCHEMAS_DIR = join(NW_ROOT, "schemas");

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, "common.json"), "utf8")));
ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, "registry_entry", "v1.json"), "utf8")));
ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, "import_history", "v1.json"), "utf8")));
ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, "error", "v1.json"), "utf8")));

const summarize = (errors) => (errors || []).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

const check = (schemaId, obj) => {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  const ok = validate(obj);
  return { ok, errors: ok ? [] : summarize(validate.errors).slice(0, 5) };
};

/** Validate a registry entry against registry_entry/v1.json. */
export const validateRegistryEntry = (entry) => check("https://nightwatch.local/schemas/registry_entry/v1.json", entry);

/** Validate an import-history record against import_history/v1.json. */
export const validateImportHistory = (record) => check("https://nightwatch.local/schemas/import_history/v1.json", record);

/** Validate an error envelope against error/v1.json. */
export const validateErrorEnvelope = (envelope) => check("https://nightwatch.local/schemas/error/v1.json", envelope);
