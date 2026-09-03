#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "cases", "index.json");
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${relative(root, path)}: invalid JSON: ${error.message}`);
    return null;
  }
}

const index = readJson(indexPath) ?? {};
if (index.schema_version !== "nightwatch.case-index.v1") {
  errors.push("cases/index.json has an unsupported schema_version");
}
if (index.discovery_rule !== "listed_only") {
  errors.push("cases/index.json must use discovery_rule=listed_only");
}
if (!Array.isArray(index.entries)) {
  errors.push("cases/index.json entries must be an array");
  index.entries = [];
}

const ids = new Set();
const sources = new Set();
for (const entry of index.entries) {
  if (!entry || typeof entry !== "object") {
    errors.push("every Case index entry must be an object");
    continue;
  }
  const required = ["case_set_id", "component", "owner", "format", "source", "status", "migration_state"];
  for (const key of required) {
    if (!(key in entry)) errors.push(`entry ${entry.case_set_id ?? "<unknown>"} missing ${key}`);
  }
  if (ids.has(entry.case_set_id)) errors.push(`duplicate case_set_id: ${entry.case_set_id}`);
  ids.add(entry.case_set_id);
  if (sources.has(entry.source)) errors.push(`duplicate source: ${entry.source}`);
  sources.add(entry.source);
  if (String(entry.source).includes(".local.")) errors.push(`local credential file cannot be a Case source: ${entry.source}`);
  const sourcePath = resolve(root, String(entry.source));
  if (!sourcePath.startsWith(`${root}/`)) {
    errors.push(`source escapes repository: ${entry.source}`);
    continue;
  }
  readJson(sourcePath);
}

const postmanDir = join(root, "postman");
const discovered = new Set(
  readdirSync(postmanDir)
    .filter((name) => name.endsWith(".postman_collection.json"))
    .map((name) => `postman/${name}`),
);
for (const path of discovered) {
  if (!sources.has(path)) errors.push(`unlisted Postman collection: ${path}`);
}
for (const path of sources) {
  if (String(path).endsWith(".postman_collection.json") && !discovered.has(path)) {
    errors.push(`listed Postman collection does not exist: ${path}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`NightWatch Case index valid: entries=${ids.size}`);
}

