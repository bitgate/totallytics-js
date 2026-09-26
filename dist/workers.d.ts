import { S as SharedOptions } from './types-XdONTIYx.js';

interface ExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
}
interface WorkersHandler<Env = any> {
    fetch?(request: Request, env: Env, ctx: ExecutionContextLike): Response | Promise<Response>;
}
interface WorkersOptions<Env = any> extends SharedOptions {
    /** Defaults to `env.TOTALLYTICS_API_KEY`. */
    apiKey?: string | ((env: Env) => string | null | undefined);
    /** Opaque consumer id, called after the response is ready. */
    consumer?: (request: Request, env: Env) => string | null | undefined;
    /** Route template. Defaults to the raw path, which the server templates. */
    route?: (request: Request, env: Env) => string | null | undefined;
    /** Return true to skip the request. */
    ignore?: (request: Request, env: Env) => boolean;
    /** Delay before flushing through `ctx.waitUntil`, max 20000. Default 5000. */
    flushDelayMs?: number;
}
type EnvOf<H> = H extends {
    fetch?: (request: any, env: infer E, ...rest: any[]) => any;
} ? E : any;
declare function withTotallytics<H extends WorkersHandler>(handler: H, options?: WorkersOptions<EnvOf<H>>): H;

export { type ExecutionContextLike, type WorkersHandler, type WorkersOptions, withTotallytics };
