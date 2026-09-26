import {
  Totallytics,
  attempt,
  debugLogger,
  defaultKey,
  describeError,
  normalizeKey,
  warnNoKey
} from "./chunk-NH3LYXKE.js";

// src/express.ts
var CLIENT_CLOSED_REQUEST = 499;
var capturedErrors = /* @__PURE__ */ new WeakMap();
function totallytics(options = {}) {
  const { apiKey, consumer, route, ignore, ...config } = options;
  const client = new Totallytics({ ...config, integration: "express" });
  const log = debugLogger(config.debug);
  const track = (req, res, startedAt, durationMs, aborted) => {
    try {
      const key = typeof apiKey === "function" ? normalizeKey(attempt(apiKey, log)) : normalizeKey(apiKey) ?? defaultKey();
      if (!key) return warnNoKey(config.debug);
      if (ignore && attempt(() => ignore(req, res), log)) return;
      const userAgent = req.headers["user-agent"];
      client.apiKey = key;
      client.record({
        method: req.method,
        path: req.originalUrl ?? req.url ?? "/",
        route: route && attempt(() => route(req, res), log) || routeTemplate(req),
        status: aborted && !res.headersSent ? CLIENT_CLOSED_REQUEST : res.statusCode,
        durationMs,
        startedAt,
        userAgent: typeof userAgent === "string" ? userAgent : void 0,
        consumer: consumer && attempt(() => consumer(req, res), log),
        error: capturedErrors.get(req)
      });
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`);
    }
  };
  const middleware = (req, res, next) => {
    try {
      const startedAt = Date.now();
      const start = performance.now();
      let recorded = false;
      const done = (aborted) => {
        if (recorded) return;
        recorded = true;
        track(req, res, startedAt, performance.now() - start, aborted);
      };
      res.once("finish", () => done(false));
      res.once("close", () => done(!res.writableFinished));
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`);
    }
    next();
  };
  return Object.assign(middleware, { flush: () => client.flush() });
}
function totallyticsErrors() {
  return function totallyticsErrorCapture(error, req, _res, next) {
    try {
      capturedErrors.set(req, error);
    } catch {
    }
    next(error);
  };
}
function routeTemplate(req) {
  const path = req.route?.path;
  if (typeof path !== "string") return void 0;
  const base = req.baseUrl ?? "";
  return base && path === "/" ? base : base + path;
}
export {
  totallytics,
  totallyticsErrors
};
