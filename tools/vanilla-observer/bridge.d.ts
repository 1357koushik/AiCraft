import { ActiveActionContext, RotatingJsonlWriter } from './writer.js';
export interface BridgeOptions {
    host?: string;
    port?: number;
    tokenFile?: string;
    runId: string;
    writer: RotatingJsonlWriter;
    getSnapshotHandler?: () => any;
    logger?: any;
}
export declare class VanillaBridgeServer {
    private host;
    private port;
    private tokenFile;
    private runId;
    private writer;
    private getSnapshotHandler?;
    private logger?;
    private server;
    private token;
    private currentContext;
    constructor(options: BridgeOptions);
    get authToken(): string;
    get activeContext(): ActiveActionContext | null;
    start(): Promise<void>;
    private generateOrLoadToken;
    private isLoopback;
    private handleRequest;
    private readBodyBounded;
    stop(): Promise<void>;
}
