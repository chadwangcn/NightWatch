/**
 * NightWatch WP-05 — WP-00 schema validation for executor artifacts.
 *
 * Loads the FROZEN WP-00 schemas (read-only; never modified):
 *   - nightwatch/schemas/common.json
 *   - nightwatch/schemas/execution_request/v1.json
 *   - nightwatch/schemas/execution_result/v1.json
 *   - nightwatch/schemas/test_case/v1.json
 *   - nightwatch/schemas/scenario/v1.json
 *   - nightwatch/schemas/audit_event/v1.json
 * and validates executor artifacts against them with AJV 2020-12 (repo-pinned).
 *
 * Every execution_request submitted through the public entry and every
 * execution_result returned by it is validated HERE before anything runs or
 * is returned (WorkRequest §5.1 hard gate).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const NW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // .../nightwatch
const SCHEMAS_DIR = join(NW_ROOT, "schemas");

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const rel of [
  "common.json",
  "execution_request/v1.json",
  "execution_result/v1.json",
  "test_case/v1.json",
  "scenario/v1.json",
  "audit_event/v1.json",
]) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, rel), "utf8")));
}

const summarize = (errors) => (errors || []).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

const check = (schemaId, obj) => {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  const ok = validate(obj);
  return { ok, errors: ok ? [] : summarize(validate.errors).slice(0, 8) };
};

/** Validate an execution_request against execution_request/v1.json (§5.7). */
export const validateExecutionRequest = (request) =>
  check("https://nightwatch.local/schemas/execution_request/v1.json", request);

/** Validate an execution_result against execution_result/v1.json (§5.7). */
export const validateExecutionResult = (result) =>
  check("https://nightwatch.local/schemas/execution_result/v1.json", result);

/** Validate a test case against test_case/v1.json (validated-case consumption). */
export const validateTestCase = (testCase) => check("https://nightwatch.local/schemas/test_case/v1.json", testCase);

/** Validate a scenario against scenario/v1.json. */
export const validateScenario = (scenario) => check("https://nightwatch.local/schemas/scenario/v1.json", scenario);
