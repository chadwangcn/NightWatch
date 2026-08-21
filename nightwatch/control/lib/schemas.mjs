/**
 * NightWatch WP-08 — WP-00 schema validators (C02)
 *
 * Compiles the FROZEN WP-00 schemas (nightwatch/schemas/**, read-only) for:
 *   - the seven commands: createSession / startRun / cancelRun / retryRun /
 *     resumeSession / publishIssue / retestIssue;
 *   - the eight events: sessionStateChanged / runStarted / runStepRecorded /
 *     runCompleted / observationRecorded / findingClassified / issueDrafted /
 *     issuePublished;
 *   - the session object and the checkpoint object.
 *
 * Uses the repo-pinned ajv (2020-12) exactly like WP-03's schema module; this
 * module never writes to nightwatch/schemas/.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const CONTROL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS_DIR = join(CONTROL_ROOT, "..", "schemas");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(readJson(join(SCHEMAS_DIR, "common.json")));

export const COMMANDS = [
  "createSession",
  "startRun",
  "cancelRun",
  "retryRun",
  "resumeSession",
  "publishIssue",
  "retestIssue",
];

export const EVENTS = [
  "sessionStateChanged",
  "runStarted",
  "runStepRecorded",
  "runCompleted",
  "observationRecorded",
  "findingClassified",
  "issueDrafted",
  "issuePublished",
];

const compilePair = (kind, name) => {
  const key = `${kind}:${name}`;
  const schema = readJson(join(SCHEMAS_DIR, kind, name, "v1.json"));
  return [key, ajv.compile(schema)];
};

const compiled = new Map([
  ...COMMANDS.map((name) => compilePair("commands", name)),
  ...EVENTS.map((name) => compilePair("events", name)),
  ["object:session", ajv.compile(readJson(join(SCHEMAS_DIR, "session", "v1.json")))],
  ["object:checkpoint", ajv.compile(readJson(join(SCHEMAS_DIR, "checkpoint", "v1.json")))],
  ["object:error", ajv.compile(readJson(join(SCHEMAS_DIR, "error", "v1.json")))],
]);

const firstErrors = (validate, limit = 3) =>
  (validate.errors || []).slice(0, limit).map((e) => `${e.instancePath || "/"} ${e.keyword} ${e.message || ""}`.trim());

/**
 * Validate an instance against a WP-00 schema.
 * @param {"command"|"event"|"session"|"checkpoint"|"error"} kind
 * @param {string} name — command/event name (ignored for plain objects)
 * @param {object} instance
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validate(kind, name, instance) {
  const key = kind === "command" || kind === "event" ? `${kind}s:${name}` : `object:${kind}`;
  const validateFn = compiled.get(key);
  if (!validateFn) throw new Error(`unknown schema "${key}"`);
  const ok = validateFn(instance);
  return ok ? { ok: true } : { ok: false, errors: firstErrors(validateFn) };
}

export const validateCommand = (name, envelope) => validate("command", name, envelope);
export const validateEvent = (name, event) => validate("event", name, event);
export const validateSession = (session) => validate("session", null, session);
export const validateCheckpoint = (checkpoint) => validate("checkpoint", null, checkpoint);
export const validateError = (error) => validate("error", null, error);

export const validators = compiled;
