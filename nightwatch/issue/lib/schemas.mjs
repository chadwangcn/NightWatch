/**
 * NightWatch WP-07 — WP-00 schema validators (C13 Issue Gateway)
 *
 * Loads the FROZEN WP-00 schemas (nightwatch/schemas/**, read-only) and
 * compiles validators with the pinned repo-wide Ajv 2020-12. Validated here:
 * issue_draft, publish_receipt, approval_record, policy_decision, error.
 * This module never writes to nightwatch/schemas/.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const ISSUE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // .../nightwatch/issue
const SCHEMAS_DIR = join(ISSUE_ROOT, "..", "schemas"); // .../nightwatch/schemas (WP-00, read-only)

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(readJson(join(SCHEMAS_DIR, "common.json"))); // resolves common.json#/$defs/* refs

const compiled = {
  issue_draft: ajv.compile(readJson(join(SCHEMAS_DIR, "issue_draft", "v1.json"))),
  publish_receipt: ajv.compile(readJson(join(SCHEMAS_DIR, "publish_receipt", "v1.json"))),
  approval_record: ajv.compile(readJson(join(SCHEMAS_DIR, "approval_record", "v1.json"))),
  policy_decision: ajv.compile(readJson(join(SCHEMAS_DIR, "policy_decision", "v1.json"))),
  error: ajv.compile(readJson(join(SCHEMAS_DIR, "error", "v1.json"))),
};

const firstErrors = (validate, limit = 5) =>
  (validate.errors || []).slice(0, limit).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

/**
 * Validate an instance against a WP-00 schema.
 * @param {"issue_draft"|"publish_receipt"|"approval_record"|"policy_decision"|"error"} objectName
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validate(objectName, instance) {
  const validateFn = compiled[objectName];
  if (!validateFn) throw new Error(`unknown schema "${objectName}"`);
  const ok = validateFn(instance);
  return ok ? { ok: true } : { ok: false, errors: firstErrors(validateFn) };
}

export const validateIssueDraft = (instance) => validate("issue_draft", instance);
export const validatePublishReceipt = (instance) => validate("publish_receipt", instance);
export const validateApprovalRecord = (instance) => validate("approval_record", instance);
export const validatePolicyDecision = (instance) => validate("policy_decision", instance);
export const validateErrorEnvelope = (instance) => validate("error", instance);

export const validators = compiled;
