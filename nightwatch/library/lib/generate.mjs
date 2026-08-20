/**
 * NightWatch WP-02 — Test Plan / Scenario / Case generation (architecture §5.4/§5.6/§10).
 *
 * Given ONLY the structured API understanding (from a WP-01 inventory/IR) this
 * module deterministically generates the baseline library:
 *
 *   1. functional — spec-declared success contract (or protocol-level 2xx when
 *      the spec declares nothing → assumption)
 *   2. schema     — missing required field / enum violation / type mismatch
 *      (only from INLINE schemas; $ref bodies degrade to protocol level)
 *   3. negative   — method-not-allowed + resource-not-found (path params)
 *   4. boundary   — numeric below-minimum, string over-maxLength
 *   5. auth       — missing / invalid / expired credential styles when the
 *      registry declares security schemes; no-auth probes when it does not
 *
 * The "Agent" reasoning stages (scenario design, exclusions, business cases)
 * are driven by the Agent Output Fixture (WorkRequest §5.2) — a fixed
 * synthetic stand-in, never an LLM call.
 *
 * Every rule INFERRED from the spec (as opposed to explicitly declared by it)
 * is recorded in meta.assumptions with classification "assumption" (A6);
 * explicit spec facts go to meta.explicit_rules.
 */
import { deriveId, contentChecksum } from "./ids.mjs";

const CASE_TYPES = ["functional", "schema", "negative", "boundary", "auth"];
const TIMEOUT_MS = 5000;

const envPrefix = (apiId) => apiId.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** Headers for a security scheme, credential style: valid | invalid | expired | none. */
function authHeadersFor(understanding, schemes, style) {
  if (style === "none") return {};
  const prefix = envPrefix(understanding.api_id);
  const out = {};
  for (const name of schemes) {
    const scheme = understanding.security_schemes[name] || {};
    if (scheme.type === "apiKey" && scheme.in === "header" && scheme.param_name) {
      const varName = style === "valid" ? `${prefix}_API_KEY` : `${prefix}_${style.toUpperCase()}_API_KEY`;
      out[scheme.param_name] = `{{${varName}}}`;
    } else {
      // http bearer/basic and unknown types: Authorization header with a
      // credential VARIABLE reference (never a value).
      const varName = style === "valid" ? `${prefix}_BEARER_TOKEN` : `${prefix}_${style.toUpperCase()}_TOKEN`;
      out.Authorization = `Bearer {{${varName}}}`;
    }
  }
  return out;
}

/** Deterministic synthetic value honoring declared field rules. */
function synthValue(rule, fieldName) {
  if (rule.enum && rule.enum.length > 0) return rule.enum[0];
  switch (rule.type) {
    case "integer":
    case "number":
      if (typeof rule.minimum === "number") return rule.minimum;
      if (typeof rule.maximum === "number") return rule.maximum;
      return 1;
    case "boolean":
      return true;
    default:
      return `synthetic-${fieldName}`;
  }
}

/** Synthetic value violating declared rules (schema/boundary cases). */
function violateValue(rule, mode) {
  if (mode === "enum") return "synthetic-invalid-enum-value";
  if (mode === "type") {
    if (rule.type === "integer" || rule.type === "number") return "synthetic-not-a-number";
    if (rule.type === "boolean") return "synthetic-not-a-boolean";
    return 1073741824; // wrong type for a string field
  }
  if (mode === "below_min") return rule.minimum - 1;
  if (mode === "over_length") return "s".repeat(rule.maxLength + 1);
  throw new Error(`unknown violation mode: ${mode}`);
}

/** {x} path params → Postman-style {{x}} runtime variables. */
const parameterizePath = (path) => path.replace(/\{([A-Za-z0-9_]+)\}/g, "{{$1}}");

/** First field (by name order) whose rule satisfies the predicate. */
function pickField(properties, pred) {
  for (const name of Object.keys(properties).sort()) {
    if (pred(properties[name])) return { name, rule: properties[name] };
  }
  return null;
}

/** Build the expectation assertion + assumption/explicit-rule bookkeeping for a 4xx contract. */
function fourOhhExpectation(ep, declaredError, assumedCodes, assumptionText) {
  if (ep.declared_responses.errors.includes(declaredError)) {
    return {
      assertion: `status_code equals ${declaredError}`,
      explicit_rules: [{ rule: `spec declares response ${declaredError} for ${ep.key}` }],
      assumptions: [],
    };
  }
  return {
    assertion: `status_code in [${assumedCodes.join(", ")}]`,
    explicit_rules: [],
    assumptions: [{ statement: assumptionText }],
  };
}

/* ------------------------------------------------------------------ */
/* Case assembly                                                       */
/* ------------------------------------------------------------------ */

function assembleCase({ understanding, ep, variant, caseType, title, risk, steps, assertions, assumptions, explicitRules, origin, scenarioName, dataset = null }) {
  const endpoint = ep
    ? { method: ep.method, path: ep.path, key: ep.key }
    : { method: steps[0].request.method, path: steps[0].request.path, key: `${steps[0].request.method} ${steps[0].request.path}` };
  const slot = {
    api_id: understanding.api_id,
    endpoint_key: endpoint.key,
    case_type: caseType,
    variant,
  };
  const signature = contentChecksum({
    title,
    steps: steps.map((s) => ({
      method: s.request.method,
      path: s.request.path,
      headers: s.request.headers || {},
      body: s.request.body_ref || null,
    })),
    assertions,
    risk,
    // Dataset content is part of the identity: a spec change that alters the
    // valid request body (e.g. a new required field) produces a NEW case and
    // the old one is superseded — never silently rewritten in place.
    dataset: dataset ? dataset.content : null,
  });
  const caseId = deriveId("case", { ...slot, signature });
  const asmp = (assumptions || []).map((a, i) => ({
    assumption_id: `ASM-${caseId.slice(5, 13)}-${String(i + 1).padStart(2, "0")}`,
    statement: a.statement,
    rule: a.statement,
    classification: "assumption",
    status: a.status || "unconfirmed",
  }));
  const rules = (explicitRules || []).map((r, i) => ({
    rule_id: `RUL-${caseId.slice(5, 13)}-${String(i + 1).padStart(2, "0")}`,
    rule: r.rule,
    source: "spec",
  }));
  const oneCase = {
    case_id: caseId,
    title,
    api_id: understanding.api_id,
    risk,
    status: "draft",
    provenance: {
      source_revision: understanding.source_revision,
      generated_by: origin === "agent-fixture" ? "test-library-generator" : "baseline-rule-engine",
      skill_version: origin === "agent-fixture" ? "baseline-suite-design@1" : "baseline-rules@1",
      last_validated_run: null,
    },
    type: caseType,
    preconditions: ["Target API test environment is reachable"],
    setup: { workflow: "none" },
    steps,
    assertions,
    timing: { per_request_timeout_ms: TIMEOUT_MS },
    repetitions: 1,
    cleanup: { workflow: "none" },
    evidence: { capture_timeline: false, capture_request_response: "failures", redact_profile: "default" },
  };
  const meta = {
    case_id: caseId,
    api_id: understanding.api_id,
    origin,
    endpoint,
    ...(scenarioName ? { scenario_name: scenarioName } : {}),
    case_type: caseType,
    variant,
    slot,
    assumptions: asmp,
    explicit_rules: rules,
    environments: ["test"],
    executors: ["newman"],
    finding_id: null,
    issue_ref: null,
    flags: [],
    transitions: [],
    deprecated: null,
  };
  return { case: oneCase, meta, slot, dataset };
}

function validBodyDataset(ep) {
  if (!ep.body || !ep.body.inline) {
    return ep.body && ep.body.required ? { content: {} } : null; // protocol-level minimal JSON body
  }
  const content = {};
  for (const [name, rule] of Object.entries(ep.body.properties)) {
    if (!rule || Object.keys(rule).length === 0) continue;
    content[name] = synthValue(rule, name);
  }
  return { content };
}

function bodyWithViolation(ep, mode, fieldName) {
  const base = validBodyDataset(ep) || { content: {} };
  const content = { ...base.content };
  if (mode === "missing_required") delete content[fieldName];
  else content[fieldName] = violateValue(ep.body.properties[fieldName], mode);
  return { content };
}

/* ------------------------------------------------------------------ */
/* Per-endpoint generation                                             */
/* ------------------------------------------------------------------ */

function generateFunctional(understanding, ep) {
  const headers = authHeadersFor(understanding, ep.auth.schemes, "valid");
  let path = parameterizePath(ep.path);
  const dataset = ep.body && ep.body.required ? validBodyDataset(ep) : null;

  const declaredSuccess = ep.declared_responses.success;
  const explicitRules = [];
  const assumptions = [];
  let successAssertion;
  if (declaredSuccess.length > 0) {
    successAssertion = `status_code in [${declaredSuccess.join(", ")}]`;
    explicitRules.push({ rule: `spec declares success responses [${declaredSuccess.join(", ")}] for ${ep.key}` });
  } else {
    successAssertion = "status_code in [200, 201, 202, 204]";
    assumptions.push({ statement: `success status codes are not declared by the spec for ${ep.key}; the standard 2xx range is assumed` });
  }
  if (ep.body && ep.body.required) {
    explicitRules.push({ rule: `spec declares a required request body for ${ep.key}` });
  }

  const steps = [
    {
      request: {
        method: ep.method,
        path,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(dataset ? { body_ref: "__SELF__" } : {}),
      },
    },
  ];
  return assembleCase({
    understanding,
    ep,
    variant: "functional",
    caseType: "functional",
    title: `${ep.key} functional success contract`,
    risk: ep.risk,
    steps,
    assertions: [successAssertion, `response_time_ms below ${TIMEOUT_MS}`],
    assumptions,
    explicitRules,
    origin: "generated",
    dataset: dataset || null,
  });
}

function generateSchemaCases(understanding, ep) {
  const out = [];
  if (!ep.body || !ep.body.inline) return out;
  const headers = authHeadersFor(understanding, ep.auth.schemes, "valid");

  const expect4xx = () => fourOhhExpectation(ep, 400, [400, 422], `spec does not declare a validation-failure response for ${ep.key}; a 400/422 rejection is assumed`);

  const requiredField = ep.body.required_fields.length > 0 ? ep.body.required_fields[0] : null;
  if (requiredField) {
    const exp = expect4xx();
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "schema_missing_required",
        caseType: "schema",
        title: `${ep.key} rejects a body missing required field "${requiredField}"`,
        risk: ep.risk,
        steps: [
          {
            request: {
              method: ep.method,
              path: parameterizePath(ep.path),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              body_ref: "__SELF__",
            },
          },
        ],
        assertions: [exp.assertion, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: exp.assumptions.length > 0 ? exp.assumptions : [],
        explicitRules: [
          { rule: `spec declares "${requiredField}" as a required body field of ${ep.key}` },
          ...exp.explicit_rules,
        ],
        origin: "generated",
        dataset: bodyWithViolation(ep, "missing_required", requiredField),
      }),
    );
  }

  const enumField = pickField(ep.body.properties, (r) => Array.isArray(r.enum) && r.enum.length > 0);
  if (enumField) {
    const exp = expect4xx();
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "schema_enum_violation",
        caseType: "schema",
        title: `${ep.key} rejects an out-of-enum value for field "${enumField.name}"`,
        risk: ep.risk,
        steps: [
          {
            request: {
              method: ep.method,
              path: parameterizePath(ep.path),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              body_ref: "__SELF__",
            },
          },
        ],
        assertions: [exp.assertion, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: exp.assumptions.length > 0 ? exp.assumptions : [],
        explicitRules: [
          { rule: `spec declares enum [${enumField.rule.enum.join(", ")}] for body field "${enumField.name}" of ${ep.key}` },
          ...exp.explicit_rules,
        ],
        origin: "generated",
        dataset: bodyWithViolation(ep, "enum", enumField.name),
      }),
    );
  }

  const typedField = pickField(ep.body.properties, (r) => typeof r.type === "string" && !Array.isArray(r.enum));
  if (typedField) {
    const exp = expect4xx();
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "schema_type_mismatch",
        caseType: "schema",
        title: `${ep.key} rejects a wrong-type value for field "${typedField.name}"`,
        risk: ep.risk,
        steps: [
          {
            request: {
              method: ep.method,
              path: parameterizePath(ep.path),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              body_ref: "__SELF__",
            },
          },
        ],
        assertions: [exp.assertion, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: exp.assumptions.length > 0 ? exp.assumptions : [],
        explicitRules: [
          { rule: `spec declares type "${typedField.rule.type}" for body field "${typedField.name}" of ${ep.key}` },
          ...exp.explicit_rules,
        ],
        origin: "generated",
        dataset: bodyWithViolation(ep, "type", typedField.name),
      }),
    );
  }
  return out;
}

function generateNegativeCases(understanding, ep) {
  const out = [];
  const path = parameterizePath(ep.path);

  // method_not_allowed: first undeclared method in a fixed candidate order.
  const declared = understanding.path_methods[ep.path] || [ep.method];
  const candidate = ["POST", "GET", "PUT", "PATCH", "DELETE"].find((m) => !declared.includes(m));
  if (candidate) {
    const declaredError = 405;
    const explicit = ep.declared_responses.errors.includes(declaredError);
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "negative_method_not_allowed",
        caseType: "negative",
        title: `${candidate} ${ep.path} is rejected as method not allowed`,
        risk: "low",
        steps: [{ request: { method: candidate, path } }],
        assertions: [`status_code equals 405`, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: explicit
          ? []
          : [{ statement: `spec does not declare a 405 response for ${ep.key}; RFC 9110 method-not-allowed semantics are assumed` }],
        explicitRules: explicit ? [{ rule: `spec declares response 405 for ${ep.key}` }] : [],
        origin: "generated",
      }),
    );
  }

  // not_found: endpoints with path params target a nonexistent resource id.
  if (ep.path_params.length > 0) {
    const param = ep.path_params[0];
    const notFoundPath = parameterizePath(ep.path).replace(`{{${param}}}`, `synthetic-nonexistent-${param}`);
    const explicit = ep.declared_responses.errors.includes(404);
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "negative_not_found",
        caseType: "negative",
        title: `${ep.key} reports a nonexistent resource id as not found`,
        risk: "low",
        steps: [
          {
            request: {
              method: ep.method,
              path: notFoundPath,
              ...(Object.keys(authHeadersFor(understanding, ep.auth.schemes, "valid")).length > 0
                ? { headers: authHeadersFor(understanding, ep.auth.schemes, "valid") }
                : {}),
            },
          },
        ],
        assertions: [`status_code equals 404`, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: explicit ? [] : [{ statement: `spec does not declare a 404 response for ${ep.key}; not-found semantics are assumed` }],
        explicitRules: explicit ? [{ rule: `spec declares response 404 for ${ep.key}` }] : [],
        origin: "generated",
      }),
    );
  }
  return out;
}

function generateBoundaryCases(understanding, ep) {
  const out = [];
  if (!ep.body || !ep.body.inline) return out;
  const headers = authHeadersFor(understanding, ep.auth.schemes, "valid");
  const expect4xx = () =>
    fourOhhExpectation(ep, 400, [400, 422], `spec does not declare a validation-failure response for ${ep.key}; a 400/422 rejection is assumed`);

  const numeric = pickField(ep.body.properties, (r) => (r.type === "integer" || r.type === "number") && typeof r.minimum === "number");
  if (numeric) {
    const exp = expect4xx();
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "boundary_numeric_below_min",
        caseType: "boundary",
        title: `${ep.key} rejects "${numeric.name}" below the declared minimum`,
        risk: ep.risk,
        steps: [
          {
            request: {
              method: ep.method,
              path: parameterizePath(ep.path),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              body_ref: "__SELF__",
            },
          },
        ],
        assertions: [exp.assertion, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: exp.assumptions.length > 0 ? exp.assumptions : [],
        explicitRules: [
          { rule: `spec declares minimum ${numeric.rule.minimum} for body field "${numeric.name}" of ${ep.key}` },
          ...exp.explicit_rules,
        ],
        origin: "generated",
        dataset: bodyWithViolation(ep, "below_min", numeric.name),
      }),
    );
  }

  const strField = pickField(ep.body.properties, (r) => r.type === "string" && typeof r.maxLength === "number");
  if (strField) {
    const exp = expect4xx();
    out.push(
      assembleCase({
        understanding,
        ep,
        variant: "boundary_string_over_max_length",
        caseType: "boundary",
        title: `${ep.key} rejects "${strField.name}" longer than the declared maxLength`,
        risk: ep.risk,
        steps: [
          {
            request: {
              method: ep.method,
              path: parameterizePath(ep.path),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              body_ref: "__SELF__",
            },
          },
        ],
        assertions: [exp.assertion, `response_time_ms below ${TIMEOUT_MS}`],
        assumptions: exp.assumptions.length > 0 ? exp.assumptions : [],
        explicitRules: [
          { rule: `spec declares maxLength ${strField.rule.maxLength} for body field "${strField.name}" of ${ep.key}` },
          ...exp.explicit_rules,
        ],
        origin: "generated",
        dataset: bodyWithViolation(ep, "over_length", strField.name),
      }),
    );
  }
  return out;
}

function generateAuthCases(understanding, ep) {
  const out = [];
  const path = parameterizePath(ep.path);
  const dataset = ep.body && ep.body.required ? validBodyDataset(ep) : null;

  if (ep.auth.required) {
    const styles = [
      { variant: "auth_missing", style: "none", title: `${ep.key} rejects a request without credentials`, withBody: false },
      { variant: "auth_invalid", style: "invalid", title: `${ep.key} rejects an invalid credential`, withBody: true },
      { variant: "auth_expired", style: "expired", title: `${ep.key} rejects an expired credential`, withBody: true },
    ];
    for (const s of styles) {
      const explicit = ep.declared_responses.errors.includes(401);
      const headers = s.style === "none" ? {} : authHeadersFor(understanding, ep.auth.schemes, s.style);
      const useBody = s.withBody && dataset;
      out.push(
        assembleCase({
          understanding,
          ep,
          variant: s.variant,
          caseType: "auth",
          title: s.title,
          risk: ep.risk,
          steps: [
            {
              request: {
                method: ep.method,
                path,
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
                ...(useBody ? { body_ref: "__SELF__" } : {}),
              },
            },
          ],
          assertions: [`status_code equals 401`, `response_time_ms below ${TIMEOUT_MS}`],
          assumptions:
            s.style === "none"
              ? explicit
                ? [] // a declared 401 maps directly onto a credential-less request
                : [{ statement: `spec does not declare a 401 response for ${ep.key}; unauthorized semantics are assumed for a request without credentials` }]
              : [
                  // invalid/expired: the 401 declaration does not pin the
                  // credential style, so the mapping stays an inference.
                  { statement: `spec does not declare per-credential-style behavior on ${ep.key}; rejection with 401 for ${s.style === "invalid" ? "an invalid" : "an expired"} credential is assumed` },
                ],
          explicitRules: explicit ? [{ rule: `spec declares response 401 for ${ep.key}` }] : [],
          origin: "generated",
          dataset: useBody ? dataset : null,
        }),
      );
    }
    return out;
  }

  // No security scheme referenced by this endpoint (or none declared at all):
  // probe without credentials — a 401/403 would expose undeclared auth (spec-ambiguity).
  const apiHasSchemes = Object.keys(understanding.security_schemes).length > 0;
  const declaredSuccess = ep.declared_responses.success;
  const successAssertion = declaredSuccess.length > 0 ? `status_code in [${declaredSuccess.join(", ")}]` : "status_code in [200, 201, 202, 204]";
  out.push(
    assembleCase({
      understanding,
      ep,
      variant: "auth_no_auth",
      caseType: "auth",
      title: `${ep.key} is reachable without credentials`,
      risk: ep.risk,
      steps: [{ request: { method: ep.method, path, ...(dataset ? { body_ref: "__SELF__" } : {}) } }],
      assertions: [successAssertion, `response_time_ms below ${TIMEOUT_MS}`],
      assumptions: [
        apiHasSchemes
          ? { statement: `no security scheme is referenced by ${ep.key}; the operation is assumed public (the IR cannot distinguish an explicit empty security from an undeclared one)` }
          : { statement: `no security scheme is declared for this API; endpoints are assumed public and a 401/403 would flag undeclared authentication` },
      ],
      explicitRules: [],
      origin: "generated",
      dataset,
    }),
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Agent-fixture-driven scenarios & business cases                     */
/* ------------------------------------------------------------------ */

function generateScenarioAssets(understanding, agentOutput, generated, agentDatasets = {}) {
  const apiConf = (agentOutput && agentOutput.apis && agentOutput.apis[understanding.api_id]) || null;
  if (!apiConf || !Array.isArray(apiConf.scenarios)) return { scenarios: [], generated: [], exclusions: [] };

  const exclusions = (apiConf.exclusions || []).map((e) => ({ method: e.method, path: e.path, reason: e.reason }));
  const excludedKeys = new Set(exclusions.map((e) => `${e.method} ${e.path}`));

  const scenarios = [];
  const extra = [];
  for (const scen of apiConf.scenarios) {
    const endpointKeys = new Set(scen.endpoints.map((e) => `${e.method} ${e.path}`));
    // Endpoint cases associated with this scenario (excluding excluded endpoints).
    const associated = generated
      .filter((g) => g.meta.origin === "generated" && endpointKeys.has(g.meta.endpoint.key) && !excludedKeys.has(g.meta.endpoint.key))
      .map((g) => g.case.case_id);

    // Business cases authored by the "Agent" (fixture) for this scenario.
    for (const tmpl of scen.cases || []) {
      const bodyFile = tmpl.steps.find((s) => s.request.body_ref);
      const bodyName = bodyFile ? bodyFile.request.body_ref.split("/").pop() : null;
      const steps = tmpl.steps.map((s) => ({
        request: {
          method: s.request.method,
          path: s.request.path,
          ...(s.request.headers && Object.keys(s.request.headers).length > 0 ? { headers: s.request.headers } : {}),
          ...(s.request.body_ref ? { body_ref: `agent/${s.request.body_ref.split("/").pop()}` } : {}),
        },
      }));
      const generatedBusiness = assembleCase({
        understanding,
        ep: null,
        variant: `business-${tmpl.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
        caseType: tmpl.type || "business",
        title: tmpl.title,
        risk: tmpl.risk || "medium",
        steps,
        assertions: tmpl.assertions,
        assumptions: (scen.assumptions || [])
          .filter((a) => a.status !== "confirmed")
          .map((a) => ({ statement: a.statement, status: "unconfirmed" })),
        explicitRules: [],
        origin: "agent-fixture",
        scenarioName: scen.name,
        dataset: bodyName && agentDatasets[bodyName] ? { content: agentDatasets[bodyName] } : null,
      });
      generatedBusiness.meta.assumptions = (scen.assumptions || []).map((a, i) => ({
        assumption_id: `ASM-${generatedBusiness.case.case_id.slice(5, 13)}-${String(i + 1).padStart(2, "0")}`,
        statement: a.statement,
        rule: a.statement,
        classification: "assumption",
        status: a.status,
      }));
      extra.push(generatedBusiness);
      associated.push(generatedBusiness.case.case_id);
    }

    const scenarioId = deriveId("scen", { api_id: understanding.api_id, name: scen.name });
    scenarios.push({
      scenario: {
        scenario_id: scenarioId,
        name: scen.name,
        description: scen.description,
        endpoints: scen.endpoints.map((e) => ({ api_id: understanding.api_id, method: e.method, path: e.path })),
        case_ids: [...new Set(associated)].sort(),
        revision: scen.revision,
        ...(Array.isArray(scen.assumptions) && scen.assumptions.length > 0
          ? { assumptions: scen.assumptions.map((a, i) => ({ assumption_id: a.assumption_id || `ASM-SCEN-${i + 1}`, statement: a.statement, status: a.status })) }
          : {}),
      },
    });
  }
  return { scenarios, generated: extra, exclusions };
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

function generatePlan(understanding, generated, exclusions) {
  const planId = deriveId("plan", { api_id: understanding.api_id, plan: "baseline-coverage" });
  const excludedKeys = new Set(exclusions.map((e) => `${e.method} ${e.path}`));
  const riskRows = {};
  for (const ep of understanding.endpoints) {
    if (excludedKeys.has(ep.key)) continue;
    const bucket = riskRows[ep.risk] || [];
    bucket.push(ep.key);
    riskRows[ep.risk] = bucket;
  }
  const risks = [];
  for (const level of ["high", "medium", "low"]) {
    for (const key of (riskRows[level] || []).sort()) risks.push(`${level}: ${key}`);
  }
  const caseIds = generated.map((g) => g.case.case_id).sort();
  return {
    plan_id: planId,
    objective: `Baseline functional, schema, negative, boundary and authentication coverage for ${understanding.api_id} (${understanding.display_name}) from the API inventory alone.`,
    scope: `All ${understanding.endpoints.filter((e) => !excludedKeys.has(e.key)).length} non-excluded endpoints in API inventory revision ${understanding.source_revision}; spec-inferred rules are marked as assumptions.`,
    risks,
    api_ids: [understanding.api_id],
    executors: ["newman"],
    environments: ["test"],
    coverage_matrix: [{ api_id: understanding.api_id, case_ids: caseIds }],
    exit_criteria: [
      "Every non-excluded endpoint has at least one functional case",
      "Every endpoint with inline body schemas has schema and boundary cases",
      "Every endpoint referencing a security scheme has missing/invalid/expired auth cases",
      "All generated cases pass the static reviewer (schema, DSL syntax, no DB-read assertions)",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Generate the baseline library for one API.
 * @param {object} understanding output of understandApi()
 * @param {object|null} agentOutput Agent Output Fixture (fixed synthetic input)
 * @param {object} [agentDatasets] map of agent fixture dataset filename → content
 * @returns {{plan, scenarios, generated, exclusions, case_types}}
 */
export function generateLibraryAssets(understanding, agentOutput = null, agentDatasets = {}) {
  const generated = [];
  const exclusions = [];
  const apiConf = agentOutput && agentOutput.apis ? agentOutput.apis[understanding.api_id] : null;
  if (apiConf && Array.isArray(apiConf.exclusions)) {
    for (const e of apiConf.exclusions) exclusions.push({ method: e.method, path: e.path, reason: e.reason });
  }
  const excludedKeys = new Set(exclusions.map((e) => `${e.method} ${e.path}`));

  for (const ep of understanding.endpoints) {
    if (!ep.executable) continue; // not compilable → not generated (covered by coverage matrix gaps)
    if (excludedKeys.has(ep.key)) continue; // paused for human confirmation (§5.4)
    generated.push(generateFunctional(understanding, ep));
    generated.push(...generateSchemaCases(understanding, ep));
    generated.push(...generateNegativeCases(understanding, ep));
    generated.push(...generateBoundaryCases(understanding, ep));
    generated.push(...generateAuthCases(understanding, ep));
  }

  const scenarioAssets = generateScenarioAssets(understanding, agentOutput, generated, agentDatasets);
  const allGenerated = [...generated, ...scenarioAssets.generated];
  const plan = generatePlan(understanding, allGenerated, exclusions);
  return {
    plan,
    scenarios: scenarioAssets.scenarios,
    generated: allGenerated,
    exclusions: [...exclusions, ...scenarioAssets.exclusions].filter((e, i, arr) => arr.findIndex((x) => x.method === e.method && x.path === e.path) === i),
    case_types: CASE_TYPES,
  };
}
