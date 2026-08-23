/**
 * NightWatch WP-10 — Golden Fault API (local deterministic HTTP target, §20.2 subset).
 *
 * A 127.0.0.1 node:http service carrying the FROZEN defect set from
 * fixtures/defect-manifest.json. Every behavior is a pure function of the
 * request inputs (fixed widget ids / fixed Idempotency-Keys / fixed nonces /
 * sha256-derived flaky rule): same inputs → same outputs, on every port, in
 * every pass — which is what A3 (determinism) and A5 (stable classifications)
 * rely on. The server keeps NO wall-clock or RNG in any observable path.
 *
 * Implanted defects (see the manifest for the authoritative list):
 *   G-BASELINE  normal read/update/delete on widget 100
 *   G-SCHEMA    GET /widgets/schema → rating is the string "five" (contract: number)
 *   G-IDEM      POST /widgets ignores Idempotency-Key: every submit creates a
 *               new resource with 201 (contract: replay → 200 + same resource)
 *   G-FLAKY     GET /widgets/flaky?nonce=N → 500 iff sha256("nwgold:"+N)[0] % 3 !== 0
 *   G-STALE     GET /widgets/stale returns the pre-PUT name exactly once after
 *               each PUT (stale window = 1 read, reset by PUT)
 *   G-LOST      PUT /widgets/lost?value=N is last-write-wins with no merge, so
 *               two increments derived from one base read collapse to one
 *   G-TOKEN     GET /widgets/token with Bearer nwgold-token-expiring-ttl30s →
 *               401 AUTH_TOKEN_EXPIRED although the token has NOT expired
 *   G-SECRET    GET /widgets/secret → rating "six" (enum violation) AND a fake
 *               api_key field whose SYNTHETIC value must never survive into
 *               any NightWatch artifact (redaction + seal scan prove it)
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/migration/lib
export const GOLDEN_MANIFEST = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "defect-manifest.json"), "utf8"));
export const FAKE_SECRET = GOLDEN_MANIFEST.fake_secret_marker;

const TOKEN_EXPIRING = "nwgold-token-expiring-ttl30s";

/** Deterministic flaky rule (frozen in the manifest; no RNG). */
export function flakyFails(nonce) {
  const byte = createHash("sha256").update(`nwgold:${nonce}`).digest()[0];
  return byte % 3 !== 0;
}

/** Fresh deterministic widget table (per server instance).
 *  Numeric key 100 = baseline; alphanumeric keys = defect probes.
 *  Non-numeric widget IDs ensure each defect normalizes to an independent
 *  path (e.g. GET /widgets/schema → "GET /widgets/schema", not "GET /widgets/{id}"),
 *  preventing quartet-level attempts dilution in the orchestrator. */
function freshWidgets() {
  return new Map([
    [100, { id: 100, name: "baseline", rating: 4 }],
    ["schema", { id: "schema", name: "schema-defect", rating: "five" }],
    ["stale", { id: "stale", name: "stale-old", rating: 3, stale_name: "stale-old", stale_reads: 0 }],
    ["lost", { id: "lost", name: "counter", rating: 3, value: 0 }],
    ["token", { id: "token", name: "token-boundary", rating: 5 }],
    ["secret", { id: "secret", name: "leaky", rating: "six", api_key: FAKE_SECRET }],
    ["flaky", { id: "flaky", name: "flaky-probe", rating: 3 }],
  ]);
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
};

/**
 * Start the Golden Fault API on an ephemeral 127.0.0.1 port.
 * @returns {Promise<{server, baseUrl, port, close, requests}>}
 *   requests — appended {method, path, status} log (verify-only surface)
 */
export function startGoldenFaultApi() {
  const widgets = freshWidgets();
  let nextId = 1000;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const q = url.searchParams;
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let status = 500;
      try {
        status = route(req, res, path, q);
      } catch {
        status = res.statusCode;
      } finally {
        requests.push({ method: req.method, path: req.url, status });
      }
    });
  });

  function route(req, res, path, q) {
    // Accept numeric (baseline widget 100) or alphanumeric (defect probes) widget IDs
    const widgetMatch = path.match(/^\/widgets\/([\w-]+)$/);

    if (req.method === "POST" && path === "/widgets") {
      // G-IDEM-01: Idempotency-Key is ignored — every submit re-creates (201).
      const id = nextId;
      nextId += 1;
      json(res, 201, { id, name: q.get("name") ?? "", rating: Number(q.get("rating") ?? 0) });
      return 201;
    }

    if (widgetMatch) {
      const rawId = widgetMatch[1];
      const id = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
      const w = widgets.get(id);

      if (req.method === "GET") {
        if (id === "flaky") {
          const nonce = q.get("nonce") ?? "";
          if (flakyFails(nonce)) {
            json(res, 500, { code: "GOLDEN_FLAKY_500", message: "deterministic intermittent failure (sha256 rule)" });
            return 500;
          }
          json(res, 200, { id: w.id, name: w.name, rating: w.rating });
          return 200;
        }
        if (id === "token" && req.headers.authorization === `Bearer ${TOKEN_EXPIRING}`) {
          json(res, 401, { code: "AUTH_TOKEN_EXPIRED", message: "token treated as expired although ttl is 30s (implanted boundary defect)" });
          return 401;
        }
        if (!w) {
          json(res, 404, { code: "WIDGET_NOT_FOUND", message: `widget ${id} does not exist` });
          return 404;
        }
        if (id === "lost" && q.get("reset") === "1") {
          w.value = 0;
          json(res, 200, { id: w.id, name: w.name, rating: w.rating, value: w.value });
          return 200;
        }
        if (id === "stale" && w.stale_reads > 0) {
          w.stale_reads -= 1;
          json(res, 200, { id: w.id, name: w.stale_name, rating: w.rating });
          return 200;
        }
        const body2 = { id: w.id, name: w.name, rating: w.rating };
        if (id === "lost") body2.value = w.value;
        if (id === "secret") body2.api_key = w.api_key; // G-SECRET-01 (synthetic marker)
        json(res, 200, body2);
        return 200;
      }

      if (req.method === "PUT") {
        if (!w) {
          json(res, 404, { code: "WIDGET_NOT_FOUND", message: `widget ${id} does not exist` });
          return 404;
        }
        if (q.has("name")) {
          w.stale_name = w.name; // remember pre-write name for the stale window
          w.stale_reads = 1; // G-STALE-01: exactly one stale read after each PUT
          w.name = q.get("name");
        }
        if (q.has("value")) w.value = Number(q.get("value")); // G-LOST-01: last-write-wins, no merge
        const body2 = { id: w.id, name: w.name, rating: w.rating };
        if (id === "lost") body2.value = w.value;
        json(res, 200, body2);
        return 200;
      }

      if (req.method === "DELETE") {
        // Idempotent acknowledge-only delete (keeps runs byte-comparable).
        res.writeHead(204);
        res.end();
        return 204;
      }
    }

    json(res, 404, { code: "ROUTE_NOT_FOUND", message: `no route for ${req.method} ${path}` });
    return 404;
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
