/**
 * NightWatch WP-06 — WP-00 schema validators (C11 Evidence / C12 Finding)
 *
 * Loads the FROZEN WP-00 schemas (nightwatch/schemas/**, read-only) and
 * compiles validators with Ajv 2020-12 (pinned repo dependency, no new deps).
 * Validated here: run (manifest), observation, finding, audit_event, error.
 * This module never writes to nightwatch/schemas/.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const EVIDENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/evidence
const SCHEMAS_DIR = join(EVIDENCE_ROOT, "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(readJson(join(SCHEMAS_DIR, "common.json"))); // resolves common.json#/$defs/* refs

const compiled = {
  run: ajv.compile(readJson(join(SCHEMAS_DIR, "run", "v1.json"))),
  observation: ajv.compile(readJson(join(SCHEMAS_DIR, "observation", "v1.json"))),
  finding: ajv.compile(readJson(join(SCHEMAS_DIR, "finding", "v1.json"))),
  audit_event: ajv.compile(readJson(join(SCHEMAS_DIR, "audit_event", "v1.json"))),
  error: ajv.compile(readJson(join(SCHEMAS_DIR, "error", "v1.json"))),
};

const firstErrors = (validate, limit = 5) =>
  (validate.errors || []).slice(0, limit).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

/**
 * Validate an instance against a WP-00 schema.
 * @param {"run"|"observation"|"finding"|"audit_event"|"error"} objectName
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validate(objectName, instance) {
  const validateFn = compiled[objectName];
  if (!validateFn) throw new Error(`unknown schema "${objectName}"`);
  const ok = validateFn(instance);
  return ok ? { ok: true } : { ok: false, errors: firstErrors(validateFn) };
}

export const validateRun = (instance) => validate("run", instance);
export const validateObservation = (instance) => validate("observation", instance);
export const validateFinding = (instance) => validate("finding", instance);
export const validateAuditEvent = (instance) => validate("audit_event", instance);
export const validateErrorEnvelope = (instance) => validate("error", instance);

export const validators = compiled;
