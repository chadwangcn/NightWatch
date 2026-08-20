/**
 * NightWatch WP-02 — WP-00 schema validation for library artifacts.
 *
 * Loads the FROZEN WP-00 schemas (read-only; never modified):
 *   - nightwatch/schemas/common.json
 *   - nightwatch/schemas/test_plan/v1.json
 *   - nightwatch/schemas/scenario/v1.json
 *   - nightwatch/schemas/test_case/v1.json
 *   - nightwatch/schemas/error/v1.json
 * and validates library artifacts against them with AJV 2020-12.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const NW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // .../nightwatch
const SCHEMAS_DIR = join(NW_ROOT, "schemas");

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const rel of ["common.json", "test_plan/v1.json", "scenario/v1.json", "test_case/v1.json", "error/v1.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, rel), "utf8")));
}

const summarize = (errors) => (errors || []).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

const check = (schemaId, obj) => {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  const ok = validate(obj);
  return { ok, errors: ok ? [] : summarize(validate.errors).slice(0, 5) };
};

/** Validate a test plan against test_plan/v1.json. */
export const validateTestPlan = (plan) => check("https://nightwatch.local/schemas/test_plan/v1.json", plan);

/** Validate a scenario against scenario/v1.json. */
export const validateScenario = (scenario) => check("https://nightwatch.local/schemas/scenario/v1.json", scenario);

/** Validate a test case against test_case/v1.json. */
export const validateTestCase = (testCase) => check("https://nightwatch.local/schemas/test_case/v1.json", testCase);

/** Validate an error envelope against error/v1.json. */
export const validateErrorEnvelope = (envelope) => check("https://nightwatch.local/schemas/error/v1.json", envelope);
