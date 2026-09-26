import {
  Totallytics,
  attempt,
  debugLogger,
  defaultKey,
  describeError,
  normalizeKey,
  warnNoKey
} from "./chunk-NH3LYXKE.js";

// src/hono.ts
function totallytics(options = {}) {
  const { apiKey, consumer, route, ignore, ...config } = options;
  const client = new Totallytics({ ...config, integration: "hono" });
  const log = debugLogger(config.debug);
  const track = (c, startedAt, durationMs, failed, thrown) => {
    try {
      const key = typeof apiKey === "function" ? normalizeKey(attempt(() => apiKey(c), log)) : normalizeKey(apiKey) ?? defaultKey(c.env);
      if (!key) return warnNoKey(config.debug);
      if (ignore && attempt(() => ignore(c), log)) return;
      client.apiKey = key;
      client.record(
        {
          method: c.req.method,
          path: c.req.path,
          route: route && attempt(() => route(c), log) || attempt(() => routeTemplate(c), log),
          status: failed ? 500 : c.res.status,
          durationMs,
          startedAt,
          userAgent: c.req.header("User-Agent"),
          consumer: consumer && attempt(() => consumer(c), log),
          error: failed ? thrown : c.error
        },
        waitUntilOf(c)
      );
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`);
    }
  };
  const middleware = async (c, next) => {
    const startedAt = Date.now();
    const start = performance.now();
    let failed = false;
    let thrown;
    try {
      await next();
    } catch (error) {
      failed = true;
      thrown = error;
      throw error;
    } finally {
      track(c, startedAt, performance.now() - start, failed, thrown);
    }
  };
  return Object.assign(middleware, { flush: () => client.flush() });
}
function routeTemplate(c) {
  const req = c.req;
  const routes = req.matchedRoutes;
  if (!Array.isArray(routes)) return void 0;
  for (let i = req.routeIndex ?? 0; i < routes.length; i++) {
    const candidate = routes[i];
    if (!candidate || typeof candidate.path !== "string") continue;
    if (candidate.method === "ALL" && candidate.path.endsWith("*")) continue;
    return candidate.path;
  }
  return void 0;
}
function waitUntilOf(c) {
  try {
    const ctx = c.executionCtx;
    return typeof ctx?.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : void 0;
  } catch {
    return void 0;
  }
}
export {
  totallytics
};
