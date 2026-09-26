import { T as TotallyticsOptions, R as RequestEntry, W as WaitUntil } from './types-XdONTIYx.cjs';
export { E as ErrorRow, I as IngestPayload, M as MetricRow, S as SharedOptions } from './types-XdONTIYx.cjs';

declare const DEFAULT_ENDPOINT = "https://totallytics.com/api/ingest";
declare class Totallytics {
    apiKey: string | undefined;
    private readonly sdk;
    private readonly debug;
    private readonly maxBatchRows;
    private readonly flushIntervalMs;
    private readonly flushDelayMs;
    private readonly aggregator;
    private readonly transport;
    private timer;
    private scheduled;
    private scheduledAt;
    constructor(options?: TotallyticsOptions);
    get hasBufferedData(): boolean;
    /** Records one finished request. Pass `ctx.waitUntil` on Workers, omit it on long-lived servers. */
    record(entry: RequestEntry, waitUntil?: WaitUntil): void;
    /** Sends everything buffered and waits for in-flight batches. Never rejects. */
    flush(): Promise<void>;
    private flushBuffer;
    private seal;
    private scheduleWithWaitUntil;
    private scheduleWithTimer;
    private log;
}

declare function bucket(ms: number): number;

declare const VERSION = "0.1.0";

export { DEFAULT_ENDPOINT, RequestEntry, Totallytics, TotallyticsOptions, VERSION, WaitUntil, bucket };
