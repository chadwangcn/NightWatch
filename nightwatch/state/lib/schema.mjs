/**
 * NightWatch WP-03 — WP-00 schema validators (C14 Audit, Checkpoint and Catalog Index)
 *
 * Loads the FROZEN WP-00 schemas (nightwatch/schemas/**, read-only) and compiles
 * validators with Ajv 2020-12 (already a pinned repo dependency — no new deps).
 * This module never writes to nightwatch/schemas/.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const STATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/state
const SCHEMAS_DIR = join(STATE_ROOT, "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(readJson(join(SCHEMAS_DIR, "common.json"))); // resolves common.json#/$defs/* refs

const compiled = {
  audit_event: ajv.compile(readJson(join(SCHEMAS_DIR, "audit_event", "v1.json"))),
  lock: ajv.compile(readJson(join(SCHEMAS_DIR, "lock", "v1.json"))),
  checkpoint: ajv.compile(readJson(join(SCHEMAS_DIR, "checkpoint", "v1.json"))),
  error: ajv.compile(readJson(join(SCHEMAS_DIR, "error", "v1.json"))),
};

const firstErrors = (validate, limit = 3) =>
  (validate.errors || []).slice(0, limit).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

/**
 * Validate an instance against a WP-00 schema.
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validate(objectName, instance) {
  const validateFn = compiled[objectName];
  if (!validateFn) throw new Error(`unknown schema "${objectName}"`);
  const ok = validateFn(instance);
  return ok ? { ok: true } : { ok: false, errors: firstErrors(validateFn) };
}

/** Throwing variant. */
export function assertValid(objectName, instance, ErrorCtor, code, message) {
  const result = validate(objectName, instance);
  if (!result.ok) {
    throw new (ErrorCtor || Error)(`${message}: ${result.errors.join("; ")}`);
  }
  return result;
}

export const validators = compiled;
