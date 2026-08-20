/**
 * NightWatch WP-04 — WP-00 schema validators (C04 Policy Gate + C08 Credential Broker)
 *
 * Loads the FROZEN WP-00 schemas (nightwatch/schemas/**, read-only) and compiles
 * validators with the pinned repo-wide Ajv 2020-12. Every product of this
 * package (policy_decision / approval_record / credential_reference /
 * injection_lease / error envelope) is validated against its frozen contract
 * before it is ever returned or audited.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const LIB_ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SCHEMAS_DIR = join(LIB_ROOT, "..", "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(readJson(join(SCHEMAS_DIR, "common.json"))); // resolves common.json#/$defs/* refs

const compiled = {
  policy_decision: ajv.compile(readJson(join(SCHEMAS_DIR, "policy_decision", "v1.json"))),
  approval_record: ajv.compile(readJson(join(SCHEMAS_DIR, "approval_record", "v1.json"))),
  credential_reference: ajv.compile(readJson(join(SCHEMAS_DIR, "credential_reference", "v1.json"))),
  injection_lease: ajv.compile(readJson(join(SCHEMAS_DIR, "injection_lease", "v1.json"))),
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

export const validators = compiled;
