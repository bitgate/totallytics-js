"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/workers.ts
var workers_exports = {};
__export(workers_exports, {
  withTotallytics: () => withTotallytics
});
module.exports = __toCommonJS(workers_exports);

// src/core/histogram.ts
var LOG_GROWTH = Math.log(1.08);
var MAX_BUCKET = 250;
function bucket(ms) {
  if (!(ms > 1)) return 0;
  return Math.min(Math.ceil(Math.log(ms) / LOG_GROWTH), MAX_BUCKET);
}

// src/core/aggregator.ts
var MAX_KEYS = 1e4;
var MAX_SERVER_ERROR_SAMPLES = 50;
var MAX_CLIENT_ERROR_SAMPLES = 20;
var Aggregator = class {
  constructor(sampleErrors) {
    this.sampleErrors = sampleErrors;
  }
  sampleErrors;
  rows = /* @__PURE__ */ new Map();
  serverErrors = [];
  clientErrors = [];
  get size() {
    return this.rows.size;
  }
  add(measurement) {
    const { ts, method, route, status, durationMs, userAgent, consumer } = measurement;
    const minute = Math.floor(ts / 6e4) * 60;
    const key = `${minute}\0${method}\0${route}\0${status}\0${userAgent ?? ""}\0${consumer ?? ""}`;
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= MAX_KEYS) return false;
      row = { minute, method, route, status, count: 0, duration_ms_sum: 0, histogram: {} };
      if (userAgent) row.user_agent = userAgent;
      if (consumer) row.consumer = consumer;
      this.rows.set(key, row);
    }
    const index = bucket(durationMs);
    row.count += 1;
    row.duration_ms_sum += durationMs;
    row.histogram[index] = (row.histogram[index] ?? 0) + 1;
    if (this.sampleErrors && status >= 400) this.sample(measurement);
    return true;
  }
  drain() {
    const metrics = [...this.rows.values()];
    for (const row of metrics) row.duration_ms_sum = round(row.duration_ms_sum);
    const errors = [...this.serverErrors, ...this.clientErrors];
    this.rows = /* @__PURE__ */ new Map();
    this.serverErrors = [];
    this.clientErrors = [];
    return { metrics, errors };
  }
  sample(measurement) {
    const serverError = measurement.status >= 500;
    const samples = serverError ? this.serverErrors : this.clientErrors;
    if (samples.length >= (serverError ? MAX_SERVER_ERROR_SAMPLES : MAX_CLIENT_ERROR_SAMPLES)) return;
    const { ts, method, route, path, status, durationMs, userAgent, consumer, message } = measurement;
    const row = { ts, method, route, path, status, duration_ms: round(durationMs) };
    if (userAgent) row.user_agent = userAgent;
    if (consumer) row.consumer = consumer;
    if (message) row.message = message;
    samples.push(row);
  }
};
function round(ms) {
  return Math.round(ms * 1e3) / 1e3;
}

// src/core/runtime.ts
var STATE = /* @__PURE__ */ Symbol.for("totallytics.state");
var SHUTDOWN_BUDGET_MS = 5e3;
function shared() {
  const scope = globalThis;
  return scope[STATE] ??= { warned: /* @__PURE__ */ new Set(), clients: /* @__PURE__ */ new Set(), hooked: false, terminating: false };
}
function hostProcess() {
  return globalThis.process;
}
function normalizeKey(value) {
  return typeof value === "string" ? value.trim() || void 0 : void 0;
}
function defaultKey(env) {
  try {
    const bindings = env;
    return normalizeKey(bindings?.TOTALLYTICS_API_KEY) ?? normalizeKey(hostProcess()?.env?.TOTALLYTICS_API_KEY);
  } catch {
    return void 0;
  }
}
function warnOnce(id, message) {
  const { warned } = shared();
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[totallytics] ${message}`);
}
function warnNoKey(debug) {
  if (debug) warnOnce("no-key", "no API key (set TOTALLYTICS_API_KEY or pass apiKey), requests are not recorded");
}
function randomId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "");
  let id = "";
  while (id.length < 32) id += Math.random().toString(16).slice(2);
  return id.slice(0, 32);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function unref(timer) {
  try {
    const handle = timer;
    if (typeof handle?.unref === "function") return handle.unref();
    const deno = globalThis.Deno;
    if (typeof timer === "number") deno?.unrefTimer?.(timer);
  } catch {
  }
}
function startInterval(callback, ms) {
  const timer = setInterval(callback, ms);
  unref(timer);
  return timer;
}
function flushOnShutdown(client) {
  const state = shared();
  state.clients.add(client);
  if (state.hooked) return;
  const proc = hostProcess();
  if (typeof proc?.on !== "function") return;
  state.hooked = true;
  const flushAll = () => Promise.all([...state.clients].map((each) => each.flush()));
  const onBeforeExit = () => {
    if ([...state.clients].some((each) => each.hasBufferedData)) void flushAll();
  };
  const onSigterm = () => {
    if (state.terminating) return;
    state.terminating = true;
    try {
      const alone = proc.listenerCount?.("SIGTERM") === 1;
      const budget = new Promise((resolve) => unref(setTimeout(resolve, SHUTDOWN_BUDGET_MS)));
      Promise.race([flushAll(), budget]).then(() => {
        if (!alone || typeof proc.pid !== "number") return;
        proc.removeListener?.("SIGTERM", onSigterm);
        proc.kill?.(proc.pid, "SIGTERM");
      }).catch(() => void 0);
    } catch {
    }
  };
  try {
    proc.on("beforeExit", onBeforeExit);
    proc.on("SIGTERM", onSigterm);
  } catch {
    state.hooked = false;
  }
}

// src/version.ts
var VERSION = "0.1.0";

// src/core/util.ts
var ORIGIN = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i;
function pathOf(url) {
  const path = url.replace(ORIGIN, "");
  const end = path.search(/[?#]/);
  return (end === -1 ? path : path.slice(0, end)) || "/";
}
function clip(value, max) {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 55296 && last <= 56319 ? max - 1 : max);
}
function describeError(error) {
  if (error == null) return void 0;
  try {
    const { name, message } = error;
    if (typeof message !== "string") return String(error);
    return typeof name === "string" && name && name !== "Error" ? `${name}: ${message}` : message;
  } catch {
    return void 0;
  }
}
function attempt(callback, log) {
  try {
    return callback();
  } catch (error) {
    log?.(`callback threw: ${describeError(error)}`);
    return void 0;
  }
}
function debugLogger(debug) {
  return debug ? (message) => console.warn(`[totallytics] ${message}`) : void 0;
}

// src/core/transport.ts
var USER_AGENT = `totallytics-js/${VERSION}`;
var MAX_ATTEMPTS = 3;
var MAX_PENDING = 20;
var TIMEOUT_MS = 1e4;
var BACKOFF_BASE_MS = 1e3;
function createBatch(apiKey, sdk, metrics, errors) {
  const id = randomId();
  const payload = { v: 1, batch_id: id, sdk, metrics, errors };
  return { id, apiKey, body: JSON.stringify(payload) };
}
var Transport = class {
  constructor(endpoint, debug) {
    this.endpoint = endpoint;
    this.debug = debug;
  }
  endpoint;
  debug;
  pending = [];
  deliver(batch) {
    const delivery = { batch, dropped: false, done: Promise.resolve() };
    this.pending.push(delivery);
    while (this.pending.length > MAX_PENDING) {
      const oldest = this.pending.shift();
      if (!oldest) break;
      oldest.dropped = true;
      this.log(`dropped batch ${oldest.batch.id}: more than ${MAX_PENDING} batches pending`);
    }
    delivery.done = this.run(delivery).catch((error) => this.log(`batch ${batch.id} failed: ${describeError(error)}`)).finally(() => this.forget(delivery));
    return delivery.done;
  }
  settle() {
    return Promise.all(this.pending.map((delivery) => delivery.done)).then(() => void 0);
  }
  forget(delivery) {
    const index = this.pending.indexOf(delivery);
    if (index !== -1) this.pending.splice(index, 1);
  }
  // Every attempt sends the same serialized body, so the server can dedup on batch_id
  async run(delivery) {
    const { batch } = delivery;
    for (let attempt2 = 1; ; attempt2++) {
      const outcome = await this.send(batch);
      if (delivery.dropped || outcome === "done" || outcome === "drop") return;
      if (outcome === "split") return this.split(delivery);
      if (attempt2 >= MAX_ATTEMPTS) return this.log(`dropped batch ${batch.id} after ${MAX_ATTEMPTS} attempts`);
      await sleep(backoff(attempt2));
      if (delivery.dropped) return;
    }
  }
  async split(delivery) {
    this.forget(delivery);
    const halves = halve(delivery.batch);
    if (!halves) return this.log(`dropped batch ${delivery.batch.id}: too large and cannot be split`);
    await Promise.all(halves.map((half) => this.deliver(half)));
  }
  async send(batch) {
    let response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${batch.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT
        },
        body: batch.body,
        signal: timeoutSignal()
      });
    } catch (error) {
      this.log(`batch ${batch.id} failed: ${describeError(error)}`);
      return "retry";
    }
    const { status } = response;
    const text = await response.text().catch(() => "");
    if (status >= 200 && status < 300) {
      this.reportRejected(batch, text);
      return "done";
    }
    if (status === 401) {
      warnOnce("unauthorized", "ingest rejected the API key (401), analytics are being dropped. Check TOTALLYTICS_API_KEY.");
      return "drop";
    }
    if (status === 413) return "split";
    const retry = status === 408 || status === 429 || status >= 500;
    this.log(`batch ${batch.id} got HTTP ${status}, ${retry ? "retrying" : "dropping"}: ${text.slice(0, 200)}`);
    return retry ? "retry" : "drop";
  }
  reportRejected(batch, text) {
    if (!this.debug) return;
    try {
      const { rejected } = JSON.parse(text);
      if (typeof rejected === "number" && rejected > 0) this.log(`batch ${batch.id}: server rejected ${rejected} rows`);
    } catch {
    }
  }
  log(message) {
    if (this.debug) console.warn(`[totallytics] ${message}`);
  }
};
function halve(batch) {
  const { sdk, metrics, errors } = JSON.parse(batch.body);
  if (metrics.length + errors.length < 2) return void 0;
  const metricsCut = Math.ceil(metrics.length / 2);
  const errorsCut = Math.floor(errors.length / 2);
  return [
    createBatch(batch.apiKey, sdk, metrics.slice(0, metricsCut), errors.slice(0, errorsCut)),
    createBatch(batch.apiKey, sdk, metrics.slice(metricsCut), errors.slice(errorsCut))
  ];
}
function backoff(attempt2) {
  const base = BACKOFF_BASE_MS * 2 ** (attempt2 - 1);
  return base / 2 + Math.random() * base;
}
function timeoutSignal() {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return void 0;
  return AbortSignal.timeout(TIMEOUT_MS);
}

// src/core/client.ts
var DEFAULT_ENDPOINT = "https://totallytics.com/api/ingest";
var MAX_SDK = 64;
var MAX_PATH = 512;
var MAX_USER_AGENT = 512;
var MAX_CONSUMER = 128;
var MAX_MESSAGE = 1e3;
var STALE_FLUSH_MS = 6e4;
var Totallytics = class {
  apiKey;
  sdk;
  debug;
  maxBatchRows;
  flushIntervalMs;
  flushDelayMs;
  aggregator;
  transport;
  timer;
  scheduled;
  scheduledAt = 0;
  constructor(options = {}) {
    this.apiKey = normalizeKey(options.apiKey) ?? defaultKey();
    this.sdk = clip(options.integration ? `${USER_AGENT} ${options.integration}` : USER_AGENT, MAX_SDK);
    this.debug = options.debug === true;
    this.maxBatchRows = clampInt(options.maxBatchRows, 1, 5e3, 1e3);
    this.flushIntervalMs = clampInt(options.flushIntervalMs, 100, 36e5, 1e4);
    this.flushDelayMs = clampInt(options.flushDelayMs, 0, 2e4, 5e3);
    this.aggregator = new Aggregator(options.errorSamples !== false);
    this.transport = new Transport(options.endpoint || DEFAULT_ENDPOINT, this.debug);
  }
  get hasBufferedData() {
    return this.aggregator.size > 0;
  }
  /** Records one finished request. Pass `ctx.waitUntil` on Workers, omit it on long-lived servers. */
  record(entry, waitUntil) {
    try {
      if (!this.apiKey) return warnNoKey(this.debug);
      const measurement = measure(entry);
      if (!measurement || !this.aggregator.add(measurement)) return;
      if (waitUntil) this.scheduleWithWaitUntil(waitUntil);
      else this.scheduleWithTimer();
    } catch (error) {
      this.log(`record failed: ${describeError(error)}`);
    }
  }
  /** Sends everything buffered and waits for in-flight batches. Never rejects. */
  flush() {
    return this.flushBuffer().then(() => this.transport.settle());
  }
  flushBuffer() {
    try {
      const deliveries = this.seal().map((batch) => this.transport.deliver(batch));
      return Promise.all(deliveries).then(() => void 0);
    } catch (error) {
      this.log(`flush failed: ${describeError(error)}`);
      return Promise.resolve();
    }
  }
  seal() {
    const apiKey = this.apiKey;
    if (this.aggregator.size === 0 || !apiKey) return [];
    const { metrics, errors } = this.aggregator.drain();
    const batches = [];
    for (let start = 0; start < metrics.length; start += this.maxBatchRows) {
      const rows = metrics.slice(start, start + this.maxBatchRows);
      batches.push(createBatch(apiKey, this.sdk, rows, start === 0 ? errors : []));
    }
    return batches;
  }
  // Workers: the shared flush is created inside a request that also waitUntil's it
  scheduleWithWaitUntil(waitUntil) {
    const now = Date.now();
    const stale = now - this.scheduledAt > this.flushDelayMs + STALE_FLUSH_MS;
    if (this.aggregator.size >= this.maxBatchRows) waitUntil(this.flushBuffer());
    else if (!this.scheduled || stale) {
      const scheduled = sleep(this.flushDelayMs).then(() => this.flushBuffer()).finally(() => {
        if (this.scheduled === scheduled) this.scheduled = void 0;
      });
      this.scheduled = scheduled;
      this.scheduledAt = now;
    }
    if (this.scheduled) waitUntil(this.scheduled);
  }
  scheduleWithTimer() {
    if (this.aggregator.size >= MAX_KEYS) void this.flushBuffer();
    if (this.timer !== void 0) return;
    this.timer = startInterval(() => void this.flushBuffer(), this.flushIntervalMs);
    flushOnShutdown(this);
  }
  log(message) {
    if (this.debug) console.warn(`[totallytics] ${message}`);
  }
};
function measure(entry) {
  const status = Number(entry.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) return void 0;
  const durationMs = Number.isFinite(entry.durationMs) && entry.durationMs > 0 ? entry.durationMs : 0;
  const startedAt = Number(entry.startedAt);
  const path = clip(pathOf(String(entry.path || "/")), MAX_PATH);
  const measurement = {
    ts: Math.floor(Number.isFinite(startedAt) ? startedAt : Date.now() - durationMs),
    method: String(entry.method || "GET").toUpperCase(),
    route: entry.route ? clip(String(entry.route), MAX_PATH) : path,
    path,
    status,
    durationMs
  };
  if (entry.userAgent) measurement.userAgent = clip(String(entry.userAgent), MAX_USER_AGENT);
  if (entry.consumer != null && entry.consumer !== "") measurement.consumer = clip(String(entry.consumer), MAX_CONSUMER);
  const message = describeError(entry.error);
  if (message) measurement.message = clip(message, MAX_MESSAGE);
  return measurement;
}
function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

// src/workers.ts
function withTotallytics(handler, options = {}) {
  const original = handler.fetch;
  if (typeof original !== "function") return handler;
  const { apiKey, consumer, route, ignore, ...config } = options;
  const client = new Totallytics({ ...config, integration: "workers" });
  const log = debugLogger(config.debug);
  const track = (request, env, ctx, status, startedAt, durationMs, error) => {
    try {
      const key = typeof apiKey === "function" ? normalizeKey(attempt(() => apiKey(env), log)) : normalizeKey(apiKey) ?? defaultKey(env);
      if (!key) return warnNoKey(config.debug);
      if (ignore && attempt(() => ignore(request, env), log)) return;
      client.apiKey = key;
      client.record(
        {
          method: request.method,
          path: request.url,
          route: route && attempt(() => route(request, env), log),
          status: status ?? 0,
          durationMs,
          startedAt,
          userAgent: request.headers.get("User-Agent"),
          consumer: consumer && attempt(() => consumer(request, env), log),
          error
        },
        waitUntilOf(ctx)
      );
    } catch (trackingError) {
      log?.(`tracking failed: ${describeError(trackingError)}`);
    }
  };
  const fetch2 = async (request, env, ctx) => {
    const startedAt = Date.now();
    const start = performance.now();
    let response;
    try {
      response = await original.call(handler, request, env, ctx);
    } catch (error) {
      track(request, env, ctx, 500, startedAt, performance.now() - start, error);
      throw error;
    }
    track(request, env, ctx, response?.status, startedAt, performance.now() - start, void 0);
    return response;
  };
  return { ...handler, fetch: fetch2 };
}
function waitUntilOf(ctx) {
  return typeof ctx?.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : void 0;
}
