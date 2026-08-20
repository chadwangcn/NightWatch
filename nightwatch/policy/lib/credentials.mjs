/**
 * NightWatch WP-04 — Credential Broker (C08, §13.1 / §13.1.1)
 *
 * Secret by Reference (§13.1): workspaces and environment definitions carry
 * variable NAMES only. A credential_reference has NO value fields — enforced
 * structurally by the frozen WP-00 schema (additionalProperties:false).
 *
 * View isolation: the Agent/Console surface is `describe(reference)` which
 * returns {reference_name, provider_type, configured} and nothing else.
 * Resolution exists ONLY on the injection path (§5.4: lease materialize) and
 * is reached exclusively through the broker's internal `_resolve`.
 *
 * Enumeration is FORBIDDEN (§13.1.1): every listing surface returns a
 * registered-code error envelope (POL_DENIED — errors.json has no dedicated
 * CRED_ENUM_FORBIDDEN-style code; closest registered policy-denied code used,
 * deviation recorded in DeliveryNotice).
 *
 * Local Secret Provider Stub (P0): synthetic values ONLY, read from a local
 * fixture file and/or an explicitly passed env object. Any value not carrying
 * the synthetic- prefix is REFUSED at construction time, so a real secret can
 * never accidentally enter the stub. No Keychain, no CI Secret Store.
 *
 * Profile separation (§13.1.1): tested-api / agent-host / github-publish must
 * use distinct credential profiles with pairwise-disjoint reference sets —
 * validated at construction.
 */
import { readFileSync } from "node:fs";
import { validate } from "./schemas.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";

export const SYNTHETIC_VALUE_PREFIX = "synthetic-";
export const CREDENTIAL_PURPOSES = ["tested-api", "agent-host", "github-publish"];
export const PROVIDER_TYPES = ["process_env", "ci_secret_store", "keychain"];

const REFERENCE_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export class LocalSecretProviderStub {
  /**
   * @param {object} [options]
   *   fixturePath? — JSON file {REFERENCE_NAME: "synthetic-..."}
   *   env?         — explicitly passed env object {REFERENCE_NAME: "synthetic-..."}
   *                 (the caller decides the source; the stub never scans process.env)
   */
  constructor({ fixturePath, env } = {}) {
    const raw = {};
    if (fixturePath !== undefined) {
      Object.assign(raw, JSON.parse(readFileSync(fixturePath, "utf8")));
    }
    if (env !== undefined) {
      if (env === null || typeof env !== "object" || Array.isArray(env)) {
        throw new TypeError("env source must be a plain object of reference names");
      }
      Object.assign(raw, env);
    }
    this._values = new Map();
    for (const [name, value] of Object.entries(raw)) {
      if (!REFERENCE_NAME_RE.test(name)) {
        throw new TypeError(`provider key "${name}" is not a valid credential reference name`);
      }
      if (typeof value !== "string" || !value.startsWith(SYNTHETIC_VALUE_PREFIX)) {
        throw new Error(`local secret provider stub refuses non-synthetic value for "${name}" (synthetic- prefixed values only)`);
      }
      this._values.set(name, value);
    }
  }

  /** Whether the reference is configured in this provider. */
  has(reference) {
    return typeof reference === "string" && this._values.has(reference);
  }

  /**
   * Resolve a value. INTERNAL — only the injection path (lease materialize)
   * may ever call this; the returned value must never be persisted, logged,
   * audited or surfaced to Agent/Console views.
   */
  resolve(reference) {
    if (!this._values.has(reference)) return undefined;
    return this._values.get(reference);
  }
}

/**
 * Validate credential definitions:
 *   - profiles non-empty; each purpose ∈ CREDENTIAL_PURPOSES; purposes unique
 *   - references non-empty; reference names valid; provider_type registered
 *   - reference sets of different profiles pairwise DISJOINT (§13.1.1:
 *     tested-api / agent-host / github-publish tokens must never share a profile)
 */
export function validateCredentialDefinitions(definitions) {
  const errors = [];
  if (definitions === null || typeof definitions !== "object" || Array.isArray(definitions)) {
    return { ok: false, errors: ["definitions must be an object"] };
  }
  const profiles = definitions.profiles;
  if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles) || Object.keys(profiles).length === 0) {
    return { ok: false, errors: ["definitions.profiles must be a non-empty object"] };
  }
  const seenPurposes = new Map();
  const referenceOwner = new Map();
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (profile === null || typeof profile !== "object") {
      errors.push(`profile "${profileName}" must be an object`);
      continue;
    }
    if (!CREDENTIAL_PURPOSES.includes(profile.purpose)) {
      errors.push(`profile "${profileName}" purpose must be one of ${CREDENTIAL_PURPOSES.join("|")}`);
    } else if (seenPurposes.has(profile.purpose)) {
      errors.push(`purpose "${profile.purpose}" is used by both "${seenPurposes.get(profile.purpose)}" and "${profileName}"`);
    } else {
      seenPurposes.set(profile.purpose, profileName);
    }
    if (!Array.isArray(profile.references) || profile.references.length === 0) {
      errors.push(`profile "${profileName}" must declare a non-empty references array`);
      continue;
    }
    for (const ref of profile.references) {
      if (ref === null || typeof ref !== "object") {
        errors.push(`profile "${profileName}" has a non-object reference`);
        continue;
      }
      if (!REFERENCE_NAME_RE.test(ref.reference_name)) {
        errors.push(`profile "${profileName}" reference name "${ref.reference_name}" is invalid`);
        continue;
      }
      if (!PROVIDER_TYPES.includes(ref.provider_type)) {
        errors.push(`profile "${profileName}" reference "${ref.reference_name}" has unregistered provider_type`);
      }
      if (referenceOwner.has(ref.reference_name)) {
        errors.push(
          `reference "${ref.reference_name}" is shared by profiles "${referenceOwner.get(ref.reference_name)}" and "${profileName}" — distinct purposes must use distinct credential profiles (§13.1.1)`,
        );
      } else {
        referenceOwner.set(ref.reference_name, profileName);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

const ENUMERATION_DENIED = () =>
  makeError(
    ERROR_CODES.POL_DENIED,
    "credential enumeration is forbidden (§13.1.1); only per-reference describe views {reference_name, provider_type, configured} are available",
  );

export class CredentialBroker {
  /**
   * @param {object} options
   *   provider     — LocalSecretProviderStub (or a future real provider with has/resolve)
   *   definitions  — {profiles: {...}} credential definitions (validated here)
   */
  constructor({ provider, definitions }) {
    if (!provider || typeof provider.has !== "function" || typeof provider.resolve !== "function") {
      throw new TypeError("CredentialBroker requires a provider with has() and resolve()");
    }
    const check = validateCredentialDefinitions(definitions);
    if (!check.ok) {
      throw new TypeError(`credential definitions invalid: ${check.errors.join("; ")}`);
    }
    this._provider = provider;
    this._definitions = definitions;
    this._references = new Map();
    for (const profile of Object.values(definitions.profiles)) {
      for (const ref of profile.references) {
        this._references.set(ref.reference_name, ref);
      }
    }
  }

  /** Whether the referenced credential is currently configured. */
  has(reference) {
    return this._provider.has(reference);
  }

  /**
   * Agent/Console view — reference name, provider type, configured-ness ONLY
   * (§13.1 rule 5: the model context sees variable names and configured-ness,
   * never values). Validated against the frozen credential_reference/v1.
   */
  describe(reference) {
    if (typeof reference !== "string" || !this._references.has(reference)) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CRED_MISSING, `credential reference "${reference}" is not defined in any credential profile (name reported, value never exists here)`),
      };
    }
    const def = this._references.get(reference);
    const view = {
      reference_name: def.reference_name,
      provider_type: def.provider_type,
      configured: this._provider.has(reference),
    };
    const sr = validate("credential_reference", view);
    if (!sr.ok) {
      return { ok: false, error: makeError(ERROR_CODES.CTL_VALIDATION_FAILED, "credential view failed schema validation", { errors: sr.errors }) };
    }
    return { ok: true, view };
  }

  /**
   * INTERNAL — injection path only (lease materialize after an approved
   * policy decision). Values from here must never be persisted or logged.
   */
  _resolve(reference) {
    return this._provider.resolve(reference);
  }

  /* ---- enumeration surfaces: ALL refused (§13.1.1) ---------------------- */
  list() {
    return { ok: false, error: ENUMERATION_DENIED() };
  }
  listReferences() {
    return { ok: false, error: ENUMERATION_DENIED() };
  }
  enumerate() {
    return { ok: false, error: ENUMERATION_DENIED() };
  }
  all() {
    return { ok: false, error: ENUMERATION_DENIED() };
  }
}
