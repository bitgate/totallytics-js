import { S as SharedOptions } from './types-XdONTIYx.js';

interface ExpressRequestLike {
    method: string;
    originalUrl?: string;
    url?: string;
    baseUrl?: string;
    route?: {
        path?: unknown;
    };
    headers: Record<string, string | string[] | undefined>;
}
interface ExpressResponseLike {
    statusCode: number;
    headersSent: boolean;
    writableFinished?: boolean;
    once(event: 'finish' | 'close', listener: () => void): unknown;
}
type NextFunctionLike = (error?: unknown) => void;
interface ExpressOptions<Req = ExpressRequestLike, Res = ExpressResponseLike> extends SharedOptions {
    /** Defaults to `process.env.TOTALLYTICS_API_KEY`. */
    apiKey?: string | (() => string | null | undefined);
    /** Opaque consumer id, called once the response has finished. */
    consumer?: (req: Req, res: Res) => string | null | undefined;
    /** Overrides the detected route template. */
    route?: (req: Req, res: Res) => string | null | undefined;
    /** Return true to skip the request. */
    ignore?: (req: Req, res: Res) => boolean;
    /** Flush interval. Default 10000. */
    flushIntervalMs?: number;
}
type TotallyticsMiddleware<Req = ExpressRequestLike, Res = ExpressResponseLike> = ((req: Req, res: Res, next: NextFunctionLike) => void) & {
    /** Sends everything buffered and waits for in-flight batches. Never rejects. */
    flush(): Promise<void>;
};
type ErrorCaptureMiddleware = (error: unknown, req: object, res: unknown, next: NextFunctionLike) => void;
declare function totallytics<Req extends ExpressRequestLike = ExpressRequestLike, Res extends ExpressResponseLike = ExpressResponseLike>(options?: ExpressOptions<Req, Res>): TotallyticsMiddleware<Req, Res>;
/** Error middleware that attaches `err.message` to error samples. Register it after your routes. */
declare function totallyticsErrors(): ErrorCaptureMiddleware;

export { type ErrorCaptureMiddleware, type ExpressOptions, type ExpressRequestLike, type ExpressResponseLike, type NextFunctionLike, type TotallyticsMiddleware, totallytics, totallyticsErrors };
