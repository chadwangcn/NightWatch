/**
 * NightWatch WP-04 — Environment definitions and classification (§12.1, §12.3)
 *
 * An Environment Definition is a pure INPUT artifact (WorkRequest §5.1):
 *   environment / classification (local|staging|production, extensible enum)
 *   base_url_env      — variable NAME, never the value (§13.1)
 *   credential_profile / health_checks / data_namespace
 *   limits            — max_requests / max_duration_seconds / max_parallelism
 *   capabilities      — destructive / fuzzing / load booleans
 *   production_url_patterns (optional) — used for production re-identification
 *   allow_readonly_smoke (optional)    — explicit allowance for read-only smoke
 *
 * Production identification (§12.3): a request runs under production policy
 * when the environment definition is explicitly classified "production" OR
 * when the base_url_env-resolved URL matches a production_url_pattern of ANY
 * production-classified definition in the loaded environment set (a staging
 * definition pointing at a production URL is re-classified as production).
 */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { makeError, ERROR_CODES } from "./errors.mjs";

export const ENVIRONMENT_CLASSIFICATIONS = ["local", "staging", "production"];

const ENV_DEF_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "NightWatch Environment Definition (WP-04, §12.1)",
  type: "object",
  additionalProperties: false,
  required: [
    "environment",
    "classification",
    "base_url_env",
    "credential_profile",
    "data_namespace",
    "limits",
    "capabilities",
  ],
  properties: {
    environment: { type: "string", minLength: 1 },
    classification: { enum: ENVIRONMENT_CLASSIFICATIONS },
    base_url_env: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
    credential_profile: { type: "string", minLength: 1 },
    health_checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["method", "path"],
        properties: {
          method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
          path: { type: "string", minLength: 1 },
        },
      },
    },
    data_namespace: { type: "string", minLength: 1 },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["max_requests", "max_duration_seconds", "max_parallelism"],
      properties: {
        max_requests: { type: "integer", minimum: 1 },
        max_duration_seconds: { type: "integer", minimum: 1 },
        max_parallelism: { type: "integer", minimum: 1 },
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: ["destructive", "fuzzing", "load"],
      properties: {
        destructive: { type: "boolean" },
        fuzzing: { type: "boolean" },
        load: { type: "boolean" },
      },
    },
    production_url_patterns: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    allow_readonly_smoke: { type: "boolean" },
  },
};

const ENV_SET_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "NightWatch Environment Set (WP-04)",
  type: "object",
  additionalProperties: false,
  required: ["environments"],
  properties: {
    environments: {
      type: "array",
      minItems: 1,
      items: ENV_DEF_SCHEMA,
    },
  },
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateDef = ajv.compile(ENV_DEF_SCHEMA);
const validateSet = ajv.compile(ENV_SET_SCHEMA);

const firstErrors = (validateFn, limit = 3) =>
  (validateFn.errors || []).slice(0, limit).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

/** Validate a single environment definition. */
export function validateEnvironmentDefinition(definition) {
  const ok = validateDef(definition);
  return ok ? { ok: true } : { ok: false, errors: firstErrors(validateDef) };
}

/** Validate an environment set ({environments: [...]}) and every definition in it. */
export function validateEnvironmentSet(set) {
  const ok = validateSet(set);
  if (!ok) return { ok: false, errors: firstErrors(validateSet) };
  for (const def of set.environments) {
    const single = validateEnvironmentDefinition(def);
    if (!single.ok) return { ok: false, errors: single.errors };
  }
  return { ok: true };
}

/** Load + validate an environment set from a JSON file. */
export function loadEnvironmentSet(filePath) {
  let set;
  try {
    set = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    return { ok: false, error: makeError(ERROR_CODES.CTL_VALIDATION_FAILED, `environment set unreadable: ${e.message}`) };
  }
  const result = validateEnvironmentSet(set);
  if (!result.ok) {
    return {
      ok: false,
      error: makeError(ERROR_CODES.CTL_VALIDATION_FAILED, "environment set failed validation", { errors: result.errors }),
    };
  }
  return { ok: true, set };
}

/**
 * URL/pattern match: a pattern ending in "*" is a prefix match, otherwise
 * exact equality. No other glob syntax (keeps the production matcher strict).
 */
export function urlMatchesPattern(url, pattern) {
  if (typeof url !== "string" || typeof pattern !== "string") return false;
  if (pattern.endsWith("*")) return url.startsWith(pattern.slice(0, -1));
  return url === pattern;
}

/**
 * Production identification (§12.3): explicit classification OR a resolved
 * base URL matching a production_url_pattern of any production-classified
 * definition in the set (misclassified staging → production re-check).
 */
export function isProductionEnvironment(environmentSet, environmentDefinition, resolvedBaseUrl) {
  if (!environmentDefinition || typeof environmentDefinition !== "object") return false;
  if (environmentDefinition.classification === "production") return true;
  if (typeof resolvedBaseUrl !== "string" || resolvedBaseUrl.length === 0) return false;
  const environments =
    environmentSet && Array.isArray(environmentSet.environments) ? environmentSet.environments : [environmentDefinition];
  for (const def of environments) {
    if (!def || def.classification !== "production") continue;
    for (const pattern of def.production_url_patterns || []) {
      if (urlMatchesPattern(resolvedBaseUrl, pattern)) return true;
    }
  }
  return false;
}
