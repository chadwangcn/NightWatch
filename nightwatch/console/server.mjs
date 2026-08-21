#!/usr/bin/env node
/**
 * NightWatch WP-09 — Console entrypoint (C01 local service)
 *
 *   node nightwatch/console/server.mjs
 *
 * Environment:
 *   NW_CONSOLE_PORT      listen port (default 0 = ephemeral)
 *   NW_CONSOLE_STATE_DIR runtime state root
 *                       (default nightwatch/console/.state/console, gitignored)
 *
 * Binds 127.0.0.1 ONLY. On startup the one-shot capability token is printed
 * to STDERR — copy it into the UI's token field to unlock write operations
 * (POST /commands/* and POST /approvals). Reads need no token.
 */
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDeployment } from "./lib/wiring.mjs";
import { buildConsoleServer } from "./lib/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/console
const STATE_DIR = process.env.NW_CONSOLE_STATE_DIR ?? join(HERE, ".state", "console");
const PORT = Number(process.env.NW_CONSOLE_PORT ?? 0);
const DEFAULT_ENVIRONMENT = process.env.NW_CONSOLE_ENVIRONMENT ?? "lumi-local";

const realNowMs = () => Date.now();

mkdirSync(STATE_DIR, { recursive: true });
const deployment = await buildDeployment({
  stateDir: STATE_DIR,
  auditStoreDir: join(STATE_DIR, "wp03"),
  defaultEnvironment: DEFAULT_ENVIRONMENT,
  nowMs: realNowMs,
});
const console_ = buildConsoleServer({ deployment });
const address = await console_.listen(PORT);

process.stderr.write(`[nightwatch-console] listening on http://127.0.0.1:${address.port}\n`);
process.stderr.write(`[nightwatch-console] capability token (write operations): ${console_.token}\n`);
process.stderr.write(`[nightwatch-console] state dir: ${STATE_DIR}\n`);

const shutdown = async () => {
  await console_.close();
  await deployment.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
