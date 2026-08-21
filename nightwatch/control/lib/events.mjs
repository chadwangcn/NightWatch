/**
 * NightWatch WP-08 — Event stream (C02, WorkRequest §5.1)
 *
 * Domain events produced by the orchestrator (the eight WP-00 events) are
 * delivered in TWO shapes simultaneously:
 *
 *   1. an in-process subscription interface — `subscribe(cb)` callbacks plus
 *      an async iterator over the buffered history;
 *   2. an append-only JSONL event log file (events.jsonl) under the runtime
 *      state dir.
 *
 * Every event is validated against its WP-00 event schema BEFORE delivery;
 * a schema-invalid event is rejected and never reaches subscribers or disk.
 * `sequence` is assigned per object_id (session-monotonic per session, run-
 * monotonic per run, ...), mirroring the envelope contract.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEvent } from "./schemas.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";

export class EventBus {
  /**
   * @param {object} options
   *   stateDir — runtime root; the JSONL log lives at <stateDir>/events.jsonl
   *   ids      — {eventId()} from makeIdFactory
   *   clock    — () => ISO string
   */
  constructor({ stateDir, ids, clock }) {
    if (!stateDir) throw new TypeError("EventBus requires stateDir");
    if (!ids) throw new TypeError("EventBus requires an id factory");
    if (!clock) throw new TypeError("EventBus requires a clock");
    this.stateDir = stateDir;
    this.ids = ids;
    this.clock = clock;
    this.logPath = join(stateDir, "events.jsonl");
    this.buffer = [];
    this.subscribers = new Set();
    this._sequenceByObject = new Map();
    this._waiters = [];
    mkdirSync(stateDir, { recursive: true });
    if (!existsSync(this.logPath)) writeFileSync(this.logPath, "", { flag: "wx" });
  }

  /**
   * Emit one domain event. The caller supplies the payload and identity
   * fields; sequence/occurred_at/event_id are assigned here.
   * @param {string} name — one of the eight WP-00 event names
   * @param {{object_id: string, object_type: string, payload: object}} parts
   * @returns {{ok: true, event: object} | {ok: false, error: object}}
   */
  emit(name, { object_id, object_type, payload }) {
    const sequence = (this._sequenceByObject.get(object_id) ?? 0) + 1;
    const event = {
      event_id: this.ids.eventId(),
      object_id,
      object_type,
      occurred_at: this.clock(),
      sequence,
      payload,
    };
    const check = validateEvent(name, event);
    if (!check.ok) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, `event "${name}" failed the WP-00 schema`, {
          reason: "event_schema",
          errors: check.errors,
        }),
      };
    }
    this._sequenceByObject.set(object_id, sequence);
    this.buffer.push({ name, event });
    appendFileSync(this.logPath, `${JSON.stringify({ name, event })}\n`, "utf8");
    for (const subscriber of this.subscribers) {
      try {
        subscriber({ name, event });
      } catch {
        // A subscriber fault must never break the orchestration stream.
      }
    }
    for (const waiter of this._waiters.splice(0)) waiter();
    return { ok: true, event };
  }

  /** In-process subscription (callback form). Returns an unsubscribe fn. */
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /** Replay everything emitted so far (name + envelope pairs). */
  history() {
    return [...this.buffer];
  }

  /** Events for one object id, in sequence order. */
  forObject(objectId) {
    return this.buffer.filter((e) => e.event.object_id === objectId);
  }

  /** Async iterator over the buffered stream (terminates when exhausted). */
  [Symbol.asyncIterator]() {
    let index = 0;
    const next = async () => {
      if (index < this.buffer.length) {
        return { value: this.buffer[index++], done: false };
      }
      await new Promise((resolve) => this._waiters.push(resolve));
      if (index < this.buffer.length) {
        return { value: this.buffer[index++], done: false };
      }
      return { value: undefined, done: true };
    };
    return { next };
  }
}
