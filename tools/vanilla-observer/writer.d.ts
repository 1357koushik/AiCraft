export interface ObserverEventCoordinates {
    x: number;
    y: number;
    z: number;
}
export interface ObserverEventCancellation {
    cancelled: boolean;
    reason?: string | null;
}
export interface ActiveActionContext {
    runId?: string;
    goalId?: string;
    actionId?: string;
    actionName?: string;
}
export interface ObserverEvent {
    seq: number;
    timestamp: string;
    serverRunId: string;
    dimension: string;
    playerUuid?: string | null;
    playerName?: string | null;
    eventType: string;
    coordinates?: ObserverEventCoordinates | null;
    blockId?: string | null;
    itemId?: string | null;
    amount?: number | null;
    cancellation?: ObserverEventCancellation | null;
    activeContext?: ActiveActionContext | null;
    details?: Record<string, any>;
}
export interface WriterOptions {
    logDir: string;
    runId: string;
    maxSizeBytes?: number;
    maxFiles?: number;
}
export declare class RotatingJsonlWriter {
    private logDir;
    private runId;
    private maxSizeBytes;
    private maxFiles;
    private seq;
    private currentFileIndex;
    private currentFilePath;
    private currentBytesWritten;
    private isClosed;
    constructor(options: WriterOptions);
    start(): Promise<void>;
    nextSeq(): number;
    get currentSequence(): number;
    get activeFilePath(): string;
    static redact(text: string): string;
    write(event: ObserverEvent): void;
    private rotate;
    private purgeOldFiles;
    close(): Promise<void>;
}
