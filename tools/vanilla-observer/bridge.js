"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VanillaBridgeServer = void 0;
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
class VanillaBridgeServer {
    host;
    port;
    tokenFile;
    runId;
    writer;
    getSnapshotHandler;
    logger;
    server = null;
    token = '';
    currentContext = null;
    constructor(options) {
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 25580;
        this.tokenFile = path_1.default.resolve(process.cwd(), options.tokenFile || 'logs/integration/.bridge_token');
        this.runId = options.runId;
        this.writer = options.writer;
        this.getSnapshotHandler = options.getSnapshotHandler;
        this.logger = options.logger;
    }
    get authToken() {
        return this.token;
    }
    get activeContext() {
        return this.currentContext;
    }
    async start() {
        this.token = this.generateOrLoadToken();
        this.server = http_1.default.createServer((req, res) => {
            this.handleRequest(req, res);
        });
        return new Promise((resolve, reject) => {
            this.server?.listen(this.port, this.host, () => {
                this.logger?.info?.(`[VanillaBridge] Server listening on http://${this.host}:${this.port} (loopback only)`);
                resolve();
            });
            this.server?.on('error', reject);
        });
    }
    generateOrLoadToken() {
        try {
            if (fs_1.default.existsSync(this.tokenFile)) {
                const content = fs_1.default.readFileSync(this.tokenFile, 'utf8').trim();
                if (content.length > 0)
                    return content;
            }
        }
        catch { }
        const generated = crypto_1.default.randomBytes(24).toString('base64url');
        try {
            const parent = path_1.default.dirname(this.tokenFile);
            if (!fs_1.default.existsSync(parent)) {
                fs_1.default.mkdirSync(parent, { recursive: true });
            }
            fs_1.default.writeFileSync(this.tokenFile, generated + '\n', { mode: 0o600 });
        }
        catch { }
        return generated;
    }
    isLoopback(remoteAddress) {
        if (!remoteAddress)
            return false;
        return (remoteAddress === '127.0.0.1' ||
            remoteAddress === '::1' ||
            remoteAddress === '::ffff:127.0.0.1');
    }
    handleRequest(req, res) {
        // 1. Strict loopback enforcement
        if (!this.isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden: Local loopback connections only' }));
            return;
        }
        // 2. Token authentication
        const authHeader = req.headers['x-observer-token'] || req.headers['authorization'];
        let providedToken = '';
        if (typeof authHeader === 'string') {
            providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
        }
        if (!providedToken || providedToken !== this.token) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
            return;
        }
        // 3. Routing
        const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
        const method = (req.method || 'GET').toUpperCase();
        if (method === 'GET' && url.pathname === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ACTIVE',
                version: '1.0.0',
                serverRunId: this.runId,
                currentSeq: this.writer.currentSequence,
                loopbackOnly: true,
                activeContext: this.currentContext,
            }));
            return;
        }
        if (method === 'GET' && url.pathname === '/snapshot') {
            const snapshot = this.getSnapshotHandler ? this.getSnapshotHandler() : null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ timestamp: Date.now(), snapshot }));
            return;
        }
        if (method === 'POST' && url.pathname === '/action/start') {
            this.readBodyBounded(req, res, (body) => {
                try {
                    const parsed = JSON.parse(body);
                    this.currentContext = {
                        runId: parsed.runId || this.runId,
                        goalId: parsed.goalId || 'unspecified_goal',
                        actionId: parsed.actionId || `act_${Date.now()}`,
                        actionName: parsed.actionName || 'unknown_action',
                    };
                    const seq = this.writer.nextSeq();
                    const event = {
                        seq,
                        timestamp: new Date().toISOString(),
                        serverRunId: this.runId,
                        dimension: 'server',
                        playerName: 'agent',
                        eventType: 'ACTION_BOUND',
                        activeContext: this.currentContext,
                        details: { ...this.currentContext },
                    };
                    this.writer.write(event);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, seq, actionId: this.currentContext.actionId }));
                }
                catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Bad Request: ${err.message}` }));
                }
            });
            return;
        }
        if (method === 'POST' && url.pathname === '/action/end') {
            this.readBodyBounded(req, res, () => {
                const prev = this.currentContext;
                this.currentContext = null;
                const seq = this.writer.nextSeq();
                const event = {
                    seq,
                    timestamp: new Date().toISOString(),
                    serverRunId: this.runId,
                    dimension: 'server',
                    playerName: 'agent',
                    eventType: 'ACTION_UNBOUND',
                    activeContext: prev,
                    details: { completedAction: prev },
                };
                this.writer.write(event);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, seq, clearedActionId: prev?.actionId || null }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
    readBodyBounded(req, res, callback) {
        const maxBytes = 16384; // 16 KB max
        let total = 0;
        const chunks = [];
        let exceeded = false;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                if (!exceeded) {
                    exceeded = true;
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Payload Too Large: exceeds 16KB limit' }));
                }
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!exceeded) {
                const body = Buffer.concat(chunks).toString('utf8');
                callback(body);
            }
        });
    }
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server?.close(() => {
                    this.server = null;
                    resolve();
                });
            });
        }
    }
}
exports.VanillaBridgeServer = VanillaBridgeServer;
