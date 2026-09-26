import {
  Totallytics,
  attempt,
  debugLogger,
  defaultKey,
  describeError,
  normalizeKey,
  warnNoKey
} from "./chunk-NH3LYXKE.js";

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
  const fetch = async (request, env, ctx) => {
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
  return { ...handler, fetch };
}
function waitUntilOf(ctx) {
  return typeof ctx?.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : void 0;
}
export {
  withTotallytics
};
