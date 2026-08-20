/**
 * NightWatch WP-02 — Case assertion DSL (executor-neutral).
 *
 * Case assertions (test_case/v1.json: assertions: string[]) are written in a
 * RESTRICTED declarative DSL so that the compiler (C07) can translate them
 * into Newman test scripts MECHANICALLY — the compiler never invents
 * assertions, judges risk, or alters Expected (WorkRequest §5.5).
 *
 * Grammar (one assertion per string):
 *
 *   [@N] status_code in [200, 201, 409]
 *   [@N] status_code equals 404
 *   [@N] response_time_ms below 5000
 *   [@N] header X-Request-Id present
 *   [@N] json $.a.b present
 *   [@N] json $.a.b is string|number|boolean|array|object
 *   [@N] json $.a.b equals 42 | "text" | true | false | null
 *   [@N] json $.a.b one_of [active, archived, 3]
 *
 * `@N` optionally binds an assertion to step N (1-based) of a multi-step case;
 * assertions without a binding apply to every step.
 *
 * parseAssertion throws on anything outside the grammar — the Reviewer
 * (static check) and the compiler share this parser, so only assertions the
 * reviewer accepted can ever reach a compiled collection.
 */

const JSON_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

const parseLiteral = (text) => {
  const t = text.trim();
  if (t === "true") return { value: true, quoted: false };
  if (t === "false") return { value: false, quoted: false };
  if (t === "null") return { value: null, quoted: false };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t), quoted: false };
  if (/^".*"$/.test(t) && JSON.parse(t) !== undefined) return { value: JSON.parse(t), quoted: true };
  // Bare tokens (enum members, identifiers) are treated as strings.
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(t)) return { value: t, quoted: false };
  throw new Error(`unparseable literal: ${text}`);
};

const literalToJs = (lit) => (lit.quoted ? JSON.stringify(lit.value) : JSON.stringify(lit.value));

/**
 * @param {string} line raw assertion string
 * @returns {{raw: string, step: number|null, kind: string, ...}} parsed assertion
 * @throws {Error} when the line is outside the DSL grammar
 */
export function parseAssertion(line) {
  const raw = line;
  if (typeof line !== "string" || line.trim().length === 0) throw new Error("assertion must be a non-empty string");
  let text = line.trim();
  let step = null;
  const stepMatch = text.match(/^@(\d+)\s+(.*)$/);
  if (stepMatch) {
    step = Number(stepMatch[1]);
    if (step < 1) throw new Error(`assertion step binding must be >= 1: ${raw}`);
    text = stepMatch[2].trim();
  }

  // status_code in [..]
  let m = text.match(/^status_code in \[(\d+(,\s*\d+)*)\]$/);
  if (m) {
    const codes = m[1].split(",").map((s) => Number(s.trim()));
    return { raw, step, kind: "status_code_in", codes };
  }
  // status_code equals N
  m = text.match(/^status_code equals (\d{3})$/);
  if (m) return { raw, step, kind: "status_code_equals", code: Number(m[1]) };
  // response_time_ms below N
  m = text.match(/^response_time_ms below (\d+)$/);
  if (m) return { raw, step, kind: "response_time_below", ms: Number(m[1]) };
  // header H present
  m = text.match(/^header ([A-Za-z0-9-]+) present$/);
  if (m) return { raw, step, kind: "header_present", header: m[1] };
  // json $.path ... forms
  m = text.match(/^json (\$\.[A-Za-z0-9_.-]+|\$) (present|is [a-z]+|equals .+|one_of \[.+\])$/);
  if (m) {
    const jsonPath = m[1];
    if (!/^(\$(\.[A-Za-z_][A-Za-z0-9_]*)*)$/.test(jsonPath)) {
      throw new Error(`unsupported json path (dotted object paths only): ${jsonPath}`);
    }
    const property = jsonPath === "$" ? "" : jsonPath.slice(2);
    const op = m[2];
    if (op === "present") return { raw, step, kind: "json_present", property };
    if (op.startsWith("is ")) {
      const type = op.slice(3);
      if (!JSON_TYPES.has(type)) throw new Error(`unsupported json type: ${type}`);
      return { raw, step, kind: "json_type", property, jsonType: type };
    }
    if (op.startsWith("equals ")) {
      const lit = parseLiteral(op.slice(7));
      return { raw, step, kind: "json_equals", property, literal: lit };
    }
    // one_of [..]
    const items = op
      .slice("one_of ".length)
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => parseLiteral(s));
    if (items.length === 0) throw new Error("one_of requires at least one value");
    return { raw, step, kind: "json_one_of", property, items };
  }
  throw new Error(`assertion outside the DSL grammar: ${raw}`);
}

/** Static syntax validation (used by the Reviewer and by case loading). */
export function isValidAssertion(line) {
  try {
    parseAssertion(line);
    return true;
  } catch {
    return false;
  }
}

/** Does the parsed assertion apply to the given step (1-based)? */
export const appliesToStep = (parsed, stepIndex) => parsed.step === null || parsed.step === stepIndex;

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Mechanically translate ONE parsed assertion into Newman pm.test script lines.
 * The translation is 1:1 — no risk judgement, no Expected rewriting.
 */
export function toNewmanLines(parsed) {
  const name = esc(parsed.raw);
  switch (parsed.kind) {
    case "status_code_in":
      return [
        `pm.test("${name}", function () {`,
        `  pm.expect(pm.response.code).to.be.oneOf([${parsed.codes.join(", ")}]);`,
        `});`,
      ];
    case "status_code_equals":
      return [
        `pm.test("${name}", function () {`,
        `  pm.expect(pm.response.code).to.eql(${parsed.code});`,
        `});`,
      ];
    case "response_time_below":
      return [
        `pm.test("${name}", function () {`,
        `  pm.expect(pm.response.responseTime).to.be.below(${parsed.ms});`,
        `});`,
      ];
    case "header_present":
      return [
        `pm.test("${name}", function () {`,
        `  pm.expect(pm.response.headers.has("${esc(parsed.header)}")).to.be.true;`,
        `});`,
      ];
    case "json_present":
      return [
        `pm.test("${name}", function () {`,
        `  var body = pm.response.json();`,
        `  pm.expect(body).to.have.nested.property("${esc(parsed.property)}");`,
        `});`,
      ];
    case "json_type":
      return [
        `pm.test("${name}", function () {`,
        `  var body = pm.response.json();`,
        `  pm.expect(body).to.have.nested.property("${esc(parsed.property)}").that.is.a("${parsed.jsonType}");`,
        `});`,
      ];
    case "json_equals":
      return [
        `pm.test("${name}", function () {`,
        `  var body = pm.response.json();`,
        `  pm.expect(body).to.have.nested.property("${esc(parsed.property)}").that.eqls(${literalToJs(parsed.literal)});`,
        `});`,
      ];
    case "json_one_of":
      return [
        `pm.test("${name}", function () {`,
        `  var body = pm.response.json();`,
        `  pm.expect(body).to.have.nested.property("${esc(parsed.property)}").that.is.oneOf([${parsed.items.map(literalToJs).join(", ")}]);`,
        `});`,
      ];
    default:
      throw new Error(`untranslatable assertion kind: ${parsed.kind}`);
  }
}
