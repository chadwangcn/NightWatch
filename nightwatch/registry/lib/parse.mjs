/**
 * NightWatch WP-01 — Spec parsing, structural validation and normalization.
 *
 * Implements the Parse → Normalize → Validate stages of the intake pipeline
 * (architecture §9) for the two File-Adapter formats of P0:
 *   - Postman Collection v2.1.0 (JSON)
 *   - OpenAPI 3.x (JSON)
 *
 * Output is a deterministic NightWatch intermediate representation (IR) that:
 *   - carries the source pin (type/location/revision/checksum);
 *   - marks every spec-originated text as UNTRUSTED_API_DATA with injection flags;
 *   - records rejected external $refs (never resolved, never fetched);
 *   - contains NO credential-shaped material (paths/methods/schemas only).
 */
import { markUntrusted, findExternalRefs, makeRefPolicy } from "./untrusted.mjs";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const POSTMAN_V21 = /\/collection\/v2\.1\.0\//;

/** Detect the spec format of an already-JSON-parsed document. */
export function detectFormat(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.openapi === "string" && /^3\./.test(doc.openapi)) return "openapi";
  if (doc.info && typeof doc.info === "object" && typeof doc.info.schema === "string" && POSTMAN_V21.test(doc.info.schema)) {
    return "postman";
  }
  return null;
}

/**
 * Normalize a Postman raw URL into {baseUrlRef, path, query}.
 *   "{{base_url}}/v1/x?y=1" -> {baseUrlRef:"base_url", path:"/v1/x", query:"y=1"}
 *   "{{cdn_url}}"            -> {baseUrlRef:null, path:"{{cdn_url}}", query:null} (whole-URL variable)
 *   "https://h.test/a"       -> {baseUrlRef:null, path:"/a", query:null}
 */
export function normalizePostmanUrl(url) {
  let raw = null;
  if (typeof url === "string") raw = url;
  else if (url && typeof url === "object" && typeof url.raw === "string") raw = url.raw;
  if (raw === null) return { baseUrlRef: null, path: null, query: null };
  raw = raw.trim();

  let query = null;
  const qi = raw.indexOf("?");
  if (qi >= 0) {
    query = raw.slice(qi + 1);
    raw = raw.slice(0, qi);
  }

  let baseUrlRef = null;
  let path = raw;
  const vm = raw.match(/^\{\{([^}]+)\}\}(.*)$/);
  if (vm) {
    baseUrlRef = vm[1];
    path = vm[2];
    if (!path) {
      // The whole URL is a runtime variable: keep it as the path token.
      path = `{{${baseUrlRef}}}`;
      baseUrlRef = null;
    }
  } else {
    const hm = raw.match(/^https?:\/\/[^/]+(\/.*)?$/);
    if (hm) path = hm[1] || "/";
  }
  if (!path) path = raw || "/";
  return { baseUrlRef, path, query };
}

/* ------------------------------------------------------------------ */
/* Schema/ref helpers                                                  */
/* ------------------------------------------------------------------ */

const isExternalRef = (ref) => typeof ref === "string" && !ref.startsWith("#");

/** Extract a stable schema representation: {schema_ref} | {schema_inline}. */
function schemaRepr(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (isExternalRef(schema.$ref)) return { schema_ref: null, external_ref: schema.$ref };
  if (typeof schema.$ref === "string") return { schema_ref: schema.$ref };
  const inline = { schema_inline: schema };
  return inline;
}

/* ------------------------------------------------------------------ */
/* OpenAPI 3.x                                                         */
/* ------------------------------------------------------------------ */

function parseOpenapi(doc, { apiId, sourcePin, refPolicy }) {
  const issues = [];
  if (typeof doc.openapi !== "string" || !/^3\.\d+\.\d+/.test(doc.openapi)) {
    issues.push("openapi: must be an OpenAPI 3.x version string");
  }
  if (!doc.info || typeof doc.info !== "object" || typeof doc.info.title !== "string" || doc.info.title.length === 0) {
    issues.push("info.title: required non-empty string");
  }
  if (!doc.info || typeof doc.info.version !== "string" || doc.info.version.length === 0) {
    issues.push("info.version: required non-empty string");
  }
  if (!doc.paths || typeof doc.paths !== "object" || Array.isArray(doc.paths)) {
    issues.push("paths: required object");
  }

  const endpoints = [];
  const flaggedTexts = [];
  const externalRefsRejected = [];

  const noteText = (location, text) => {
    const marked = markUntrusted(text);
    if (marked && marked.quarantined) flaggedTexts.push({ location, pattern_ids: marked.injection_flags });
    return marked;
  };

  if (doc.paths && typeof doc.paths === "object" && !Array.isArray(doc.paths)) {
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      if (!path.startsWith("/")) {
        issues.push(`paths.${path}: path keys must start with "/"`);
        continue;
      }
      if (!pathItem || typeof pathItem !== "object") {
        issues.push(`paths.${path}: path item must be an object`);
        continue;
      }
      if (isExternalRef(pathItem.$ref)) {
        externalRefsRejected.push({ ref: pathItem.$ref, location: `paths.${path}` });
        continue;
      }
      for (const method of HTTP_METHODS) {
        const op = pathItem[method];
        if (!op || typeof op !== "object") continue;
        if (isExternalRef(op.$ref)) {
          externalRefsRejected.push({ ref: op.$ref, location: `paths.${path}.${method}` });
          continue;
        }
        if (!op.responses || typeof op.responses !== "object" || Array.isArray(op.responses) || Object.keys(op.responses).length === 0) {
          issues.push(`paths.${path}.${method}.responses: required non-empty object`);
        }

        const parameters = [];
        for (const p of op.parameters || []) {
          if (!p || typeof p !== "object" || typeof p.name !== "string") {
            issues.push(`paths.${path}.${method}.parameters: parameter without a name`);
            continue;
          }
          const param = {
            name: p.name,
            in: typeof p.in === "string" ? p.in : null,
            required: p.required === true,
            ...schemaRepr(p.schema),
          };
          if (p.example !== undefined && p.example !== null) {
            param.example = noteText(`paths.${path}.${method}.parameters.${p.name}.example`, p.example);
          }
          parameters.push(param);
        }
        for (const p of pathItem.parameters || []) {
          if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
          parameters.push({
            name: p.name,
            in: typeof p.in === "string" ? p.in : null,
            required: p.required === true,
            ...schemaRepr(p.schema),
          });
        }

        let request_body = null;
        if (op.requestBody && typeof op.requestBody === "object" && !isExternalRef(op.requestBody.$ref)) {
          const content = op.requestBody.content && op.requestBody.content["application/json"];
          const repr = content ? schemaRepr(content.schema) : {};
          request_body = {
            required: op.requestBody.required === true,
            content_type: content ? "application/json" : null,
            ...repr,
            required_fields:
              repr.schema_inline && Array.isArray(repr.schema_inline.required) ? [...repr.schema_inline.required] : null,
          };
        } else if (op.requestBody && isExternalRef(op.requestBody.$ref)) {
          externalRefsRejected.push({ ref: op.requestBody.$ref, location: `paths.${path}.${method}.requestBody` });
        }

        const responses = {};
        if (op.responses && typeof op.responses === "object") {
          for (const [status, resp] of Object.entries(op.responses)) {
            if (isExternalRef(resp && resp.$ref)) {
              externalRefsRejected.push({ ref: resp.$ref, location: `paths.${path}.${method}.responses.${status}` });
              responses[status] = {};
              continue;
            }
            const content = resp && resp.content && resp.content["application/json"];
            responses[status] = content ? schemaRepr(content.schema) : {};
          }
        }

        endpoints.push({
          key: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          group: null,
          occurrences: 1,
          groups: [],
          operation_id: typeof op.operationId === "string" ? op.operationId : null,
          summary: typeof op.summary === "string" ? op.summary : null,
          description: noteText(`paths.${path}.${method}.description`, typeof op.description === "string" ? op.description : null),
          parameters,
          request_body,
          responses,
          security: normalizeSecurity(op.security) || normalizeSecurity(doc.security) || [],
        });
      }
    }
  }

  const securitySchemes = {};
  const schemes = doc.components && doc.components.securitySchemes;
  if (schemes && typeof schemes === "object") {
    for (const [name, s] of Object.entries(schemes)) {
      if (!s || typeof s !== "object") continue;
      securitySchemes[name] = {
        type: typeof s.type === "string" ? s.type : null,
        ...(typeof s.scheme === "string" ? { scheme: s.scheme } : {}),
        ...(typeof s.in === "string" ? { in: s.in } : {}),
        ...(typeof s.name === "string" ? { param_name: s.name } : {}),
      };
    }
  }

  const ir = {
    ir_version: 1,
    api_id: apiId,
    display_name: doc.info && typeof doc.info.title === "string" ? doc.info.title : apiId,
    format: "openapi",
    source_pin: sourcePin,
    spec_version: doc.info && typeof doc.info.version === "string" ? doc.info.version : null,
    servers: Array.isArray(doc.servers) ? doc.servers.map((s) => (typeof s.url === "string" ? s.url : null)).filter(Boolean) : [],
    security_schemes: securitySchemes,
    endpoints: endpoints.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    api_description: noteText("info.description", doc.info && typeof doc.info.description === "string" ? doc.info.description : null),
    injection_report: {
      flagged_texts: flaggedTexts,
      external_refs_rejected: externalRefsRejected,
      quarantined_text_count: flaggedTexts.length,
    },
  };
  return { ir, issues };
}

function normalizeSecurity(security) {
  if (!Array.isArray(security)) return null;
  return security.map((req) => {
    if (!req || typeof req !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(req)) out[k] = Array.isArray(v) ? [...v] : [];
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Postman Collection v2.1.0                                           */
/* ------------------------------------------------------------------ */

function parsePostman(doc, { apiId, sourcePin }) {
  const issues = [];
  if (!doc.info || typeof doc.info !== "object" || typeof doc.info.name !== "string" || doc.info.name.length === 0) {
    issues.push("info.name: required non-empty string");
  }
  if (!Array.isArray(doc.item)) {
    issues.push("item: required array");
  }

  const byKey = new Map();
  const baseUrlRefs = new Set();
  const flaggedTexts = [];
  const externalRefsRejected = [];

  const noteText = (location, text) => {
    const marked = markUntrusted(text);
    if (marked && marked.quarantined) flaggedTexts.push({ location, pattern_ids: marked.injection_flags });
    return marked;
  };

  const walk = (items, groupPath) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      if (Array.isArray(it.item)) {
        walk(it.item, `${groupPath}/${it.name || ""}`);
        continue;
      }
      const req = it.request;
      if (!req || typeof req !== "object") {
        issues.push(`item "${it.name || "<unnamed>"}: request object missing"`);
        continue;
      }
      if (typeof req.method !== "string" || req.method.length === 0) {
        issues.push(`item "${it.name || "<unnamed>"}": request.method required`);
        continue;
      }
      const url = normalizePostmanUrl(req.url);
      if (url.path === null) {
        issues.push(`item "${it.name || "<unnamed>"}": request.url unusable`);
        continue;
      }
      if (url.baseUrlRef) baseUrlRefs.add(url.baseUrlRef);

      const method = req.method.toUpperCase();
      const key = `${method} ${url.path}`;
      const description =
        typeof req.description === "string"
          ? req.description
          : req.description && typeof req.description === "object" && typeof req.description.content === "string"
            ? req.description.content
            : null;

      let ep = byKey.get(key);
      if (!ep) {
        ep = {
          key,
          method,
          path: url.path,
          group: groupPath === "" ? null : groupPath,
          occurrences: 0,
          groups: [],
          query_variants: [],
          operation_id: typeof it.name === "string" ? it.name : null,
          summary: null,
          description: null,
          parameters: [],
          request_body: null,
          responses: {},
          security: [],
        };
        byKey.set(key, ep);
      }
      ep.occurrences += 1;
      const g = groupPath === "" ? "(root)" : groupPath;
      if (!ep.groups.includes(g)) ep.groups.push(g);
      if (url.query && !ep.query_variants.includes(url.query)) ep.query_variants.push(url.query);
      if (ep.description === null && description !== null) {
        ep.description = noteText(`item ${JSON.stringify(it.name || key)}`, description);
      }
      if (req.body && typeof req.body === "object" && req.body.mode === "raw" && typeof req.body.raw === "string") {
        ep.request_body = { required: false, content_type: "raw", required_fields: null, raw_hint: true };
      }
    }
  };

  walk(doc.item || [], "");

  const ir = {
    ir_version: 1,
    api_id: apiId,
    display_name: doc.info && typeof doc.info.name === "string" ? doc.info.name : apiId,
    format: "postman",
    source_pin: sourcePin,
    spec_version: typeof doc.info?.schema === "string" ? doc.info.schema : null,
    base_url_refs: [...baseUrlRefs].sort(),
    security_schemes: {},
    endpoints: [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    api_description: noteText("info.description", doc.info && typeof doc.info.description === "string" ? doc.info.description : null),
    injection_report: {
      flagged_texts: flaggedTexts,
      external_refs_rejected: externalRefsRejected,
      quarantined_text_count: flaggedTexts.length,
    },
  };
  return { ir, issues };
}

/**
 * Parse + normalize + structurally validate a JSON-parsed spec document.
 * @returns {{format, ir, issues}} — issues non-empty means the spec is invalid.
 */
export function parseSpec(doc, { apiId, sourcePin, refPolicy = makeRefPolicy() }) {
  const format = detectFormat(doc);
  if (format === null) {
    return { format: null, ir: null, issues: ["unrecognized spec format: expected Postman Collection v2.1.0 or OpenAPI 3.x JSON"] };
  }
  const externalRefs = findExternalRefs(doc);
  const rejected = [];
  for (const r of externalRefs) {
    if (refPolicy.allows(r.ref)) continue;
    rejected.push(r);
  }
  const parsed = format === "openapi" ? parseOpenapi(doc, { apiId, sourcePin, refPolicy }) : parsePostman(doc, { apiId, sourcePin });

  // Merge spec-wide external-ref scan with per-location rejections (dedup, stable order).
  const seen = new Set(parsed.ir.injection_report.external_refs_rejected.map((r) => `${r.location} ${r.ref}`));
  for (const r of rejected) {
    const k = `${r.location} ${r.ref}`;
    if (!seen.has(k)) {
      seen.add(k);
      parsed.ir.injection_report.external_refs_rejected.push(r);
    }
  }
  parsed.ir.injection_report.external_refs_rejected.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return parsed;
}
