import { Env, Context, MiddlewareHandler } from 'hono';
import { S as SharedOptions } from './types-XdONTIYx.js';

interface HonoOptions<E extends Env = any> extends SharedOptions {
    /** Defaults to `c.env.TOTALLYTICS_API_KEY`, then `process.env.TOTALLYTICS_API_KEY`. */
    apiKey?: string | ((c: Context<E>) => string | null | undefined);
    /** Opaque consumer id, called after the response is ready. */
    consumer?: (c: Context<E>) => string | null | undefined;
    /** Overrides the detected route template. */
    route?: (c: Context<E>) => string | null | undefined;
    /** Return true to skip the request. */
    ignore?: (c: Context<E>) => boolean;
    /** Flush interval without `executionCtx` (Node, Bun, Deno). Default 10000. */
    flushIntervalMs?: number;
    /** Delay before a `waitUntil` flush on Workers, max 20000. Default 5000. */
    flushDelayMs?: number;
}
type TotallyticsMiddleware<E extends Env = any> = MiddlewareHandler<E> & {
    /** Sends everything buffered and waits for in-flight batches. Never rejects. */
    flush(): Promise<void>;
};
declare function totallytics<E extends Env = any>(options?: HonoOptions<E>): TotallyticsMiddleware<E>;

export { type HonoOptions, type TotallyticsMiddleware, totallytics };
