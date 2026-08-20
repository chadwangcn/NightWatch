/**
 * NightWatch WP-02 — API Understanding, Capability/Resource Graph, Risk model.
 *
 * Stages 2–4 of the generation pipeline (architecture §5.4): turns the WP-01
 * normalized IR into the structured understanding the case generator consumes.
 *
 * IMPORTANT trust boundary: only STRUCTURED spec fields (methods, paths,
 * schemas, security references, declared status codes) are used here. Spec
 * free-text (summary/description) is UNTRUSTED_API_DATA and is never copied
 * into generated assets — titles are built from structural fields only.
 *
 * Rules that come straight from the spec (declared status codes, required
 * fields, enums, bounds) are surfaced as explicit facts; anything the
 * generator infers beyond them must be marked as an assumption downstream
 * (WorkRequest §5.2, architecture §5.4 item 3).
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Extract the field-level rules we can reason about from an inline JSON schema. */
function extractFieldRules(schemaInline) {
  if (!schemaInline || typeof schemaInline !== "object") return null;
  const properties = {};
  const src = schemaInline.properties || {};
  for (const [name, p] of Object.entries(src)) {
    if (!p || typeof p !== "object") continue;
    const rule = {};
    if (typeof p.type === "string") rule.type = p.type;
    if (Array.isArray(p.enum)) rule.enum = [...p.enum].sort();
    if (typeof p.minimum === "number") rule.minimum = p.minimum;
    if (typeof p.maximum === "number") rule.maximum = p.maximum;
    if (typeof p.minLength === "number") rule.minLength = p.minLength;
    if (typeof p.maxLength === "number") rule.maxLength = p.maxLength;
    properties[name] = rule;
  }
  return {
    inline: true,
    required_fields: Array.isArray(schemaInline.required) ? [...schemaInline.required].sort() : [],
    properties,
  };
}

function extractParamRules(param) {
  const rule = {};
  if (param.schema_inline) {
    const s = param.schema_inline;
    if (typeof s.type === "string") rule.type = s.type;
    if (Array.isArray(s.enum)) rule.enum = [...s.enum].sort();
    if (typeof s.minimum === "number") rule.minimum = s.minimum;
    if (typeof s.maximum === "number") rule.maximum = s.maximum;
  }
  return rule;
}

const pathParamsOf = (path) => [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);

/**
 * @param {object} ir WP-01 normalized IR (runImportPipeline(...).normalized)
 * @returns {object} structured understanding
 */
export function understandApi(ir) {
  if (!ir || typeof ir !== "object" || !Array.isArray(ir.endpoints)) {
    throw new Error("understandApi: normalized IR with endpoints[] required");
  }

  // path → declared methods (needed for method_not_allowed negatives)
  const pathMethods = {};
  for (const ep of ir.endpoints) {
    if (!pathMethods[ep.path]) pathMethods[ep.path] = [];
    pathMethods[ep.path].push(ep.method);
  }
  for (const p of Object.keys(pathMethods)) pathMethods[p].sort();

  const endpoints = ir.endpoints.map((ep) => {
    const pathParams = pathParamsOf(ep.path);
    const queryParams = [];
    for (const p of ep.parameters || []) {
      if (p.in === "query") queryParams.push({ name: p.name, required: p.required === true, ...extractParamRules(p) });
    }

    let body = null;
    if (ep.request_body) {
      if (ep.request_body.schema_inline) {
        body = { required: ep.request_body.required === true, ...extractFieldRules(ep.request_body.schema_inline) };
      } else if (ep.request_body.schema_ref) {
        // Internal $ref: WP-01 keeps only the reference — field-level rules are
        // unavailable, so schema/boundary cases degrade to protocol-level.
        body = { required: ep.request_body.required === true, inline: false, schema_ref: ep.request_body.schema_ref, required_fields: [], properties: {} };
      } else if (ep.request_body.raw_hint) {
        body = { required: false, inline: false, schema_ref: null, required_fields: [], properties: {} };
      }
    }

    const declared = Object.keys(ep.responses || {});
    const success = declared.filter((c) => /^2\d\d$/.test(c)).map(Number).sort((a, b) => a - b);
    const errors = declared.filter((c) => /^[45]\d\d$/.test(c)).map(Number).sort((a, b) => a - b);

    const schemes = [];
    for (const req of ep.security || []) {
      for (const name of Object.keys(req)) if (!schemes.includes(name)) schemes.push(name);
    }
    schemes.sort();

    const auth = { schemes, required: schemes.length > 0 };

    // Risk model (deterministic, structural facts only).
    const riskReasons = [];
    let risk = "low";
    if (WRITE_METHODS.has(ep.method)) riskReasons.push(`${ep.method} mutates state`);
    if (auth.required) riskReasons.push(`requires ${schemes.join("+")}`);
    if (body && body.required) riskReasons.push("request body required");
    if ((body && body.required_fields.length > 0) || queryParams.some((q) => q.required)) riskReasons.push("required input fields declared");
    if (WRITE_METHODS.has(ep.method) && auth.required) risk = "high";
    else if (WRITE_METHODS.has(ep.method) || (body && body.required) || queryParams.some((q) => q.required)) risk = "medium";

    return {
      key: ep.key,
      method: ep.method,
      path: ep.path,
      group: ep.group,
      operation_id: ep.operation_id,
      path_params: pathParams,
      query_params: queryParams,
      body,
      declared_responses: { success, errors },
      auth,
      executable: typeof ep.method === "string" && ep.method.length > 0 && typeof ep.path === "string" && ep.path.startsWith("/"),
      risk,
      risk_reasons: riskReasons,
    };
  });

  // Capability/Resource Graph — P0 placeholder layer (WorkRequest §5.1):
  // capabilities group endpoints by leading resource segment; Suite-level
  // objects are deliberately not materialized (pass-through).
  const capabilities = {};
  for (const ep of endpoints) {
    const segs = ep.path.split("/").filter((s) => s.length > 0 && !s.startsWith("{"));
    const resource = segs.length > 1 ? segs[segs.length - 2] : segs[0] || "root";
    const cap = resource.replace(/[^a-z0-9-]/gi, "") || "root";
    if (!capabilities[cap]) capabilities[cap] = [];
    capabilities[cap].push(ep.key);
  }

  return {
    ir_version: 1,
    api_id: ir.api_id,
    display_name: ir.display_name,
    format: ir.format,
    source_revision: ir.source_pin.revision,
    security_schemes: ir.security_schemes || {},
    path_methods: pathMethods,
    capabilities: Object.keys(capabilities)
      .sort()
      .map((name) => ({ name, endpoints: capabilities[name].sort() })),
    endpoints,
  };
}
