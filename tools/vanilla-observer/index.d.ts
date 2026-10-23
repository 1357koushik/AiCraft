import { Bot } from 'mineflayer';
import { RotatingJsonlWriter } from './writer.js';
import { VanillaBridgeServer } from './bridge.js';
export interface VanillaObserverConfig {
    serverHost?: string;
    serverPort?: number;
    observerUsername?: string;
    runId?: string;
    logDir?: string;
    bridgePort?: number;
    bridgeTokenFile?: string;
    snapshotIntervalMs?: number;
    logger?: any;
}
export declare class VanillaGroundTruthObserver {
    private config;
    private writer;
    private bridge;
    private bot;
    private snapshotInterval;
    private isRunning;
    constructor(config?: VanillaObserverConfig);
    get logWriter(): RotatingJsonlWriter;
    get bridgeServer(): VanillaBridgeServer;
    get observerBot(): Bot | null;
    start(): Promise<void>;
    private connectObserverBot;
    private setupEventListeners;
    private startSnapshotTimer;
    getLiveSnapshot(): any;
    stop(): Promise<void>;
}
