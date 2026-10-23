"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RotatingJsonlWriter = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class RotatingJsonlWriter {
    logDir;
    runId;
    maxSizeBytes;
    maxFiles;
    seq = 0;
    currentFileIndex = 0;
    currentFilePath = '';
    currentBytesWritten = 0;
    isClosed = false;
    constructor(options) {
        this.logDir = path_1.default.resolve(process.cwd(), options.logDir);
        this.runId = options.runId || `run_${Date.now()}`;
        this.maxSizeBytes = options.maxSizeBytes || 50 * 1024 * 1024; // 50 MB
        this.maxFiles = options.maxFiles || 5;
    }
    async start() {
        if (!fs_1.default.existsSync(this.logDir)) {
            fs_1.default.mkdirSync(this.logDir, { recursive: true });
        }
        this.rotate();
    }
    nextSeq() {
        this.seq++;
        return this.seq;
    }
    get currentSequence() {
        return this.seq;
    }
    get activeFilePath() {
        return this.currentFilePath;
    }
    static redact(text) {
        if (!text)
            return text;
        return text
            .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
            .replace(/(["']?(?:token|password|secret|bearer)["']?\s*[:=]\s*["']?)([^"',\s\}]+)(["']?)/gi, '$1***REDACTED***$3');
    }
    write(event) {
        if (this.isClosed)
            return;
        const line = JSON.stringify(event) + '\n';
        const redacted = RotatingJsonlWriter.redact(line);
        const lineBytes = Buffer.byteLength(redacted, 'utf8');
        if (this.currentBytesWritten > 0 && this.currentBytesWritten + lineBytes >= this.maxSizeBytes) {
            this.rotate();
        }
        fs_1.default.appendFileSync(this.currentFilePath, redacted, 'utf8');
        this.currentBytesWritten += lineBytes;
    }
    rotate() {
        this.currentFileIndex++;
        const fileName = `observer-vanilla-${this.runId}-part${String(this.currentFileIndex).padStart(2, '0')}.jsonl`;
        this.currentFilePath = path_1.default.join(this.logDir, fileName);
        fs_1.default.appendFileSync(this.currentFilePath, '', 'utf8');
        this.currentBytesWritten = 0;
        this.purgeOldFiles();
    }
    purgeOldFiles() {
        try {
            const files = fs_1.default
                .readdirSync(this.logDir)
                .filter((f) => f.startsWith(`observer-vanilla-${this.runId}-part`) && f.endsWith('.jsonl'))
                .sort(); // Lexicographical sort by part number: part01, part02, part03...
            if (files.length > this.maxFiles) {
                const toDelete = files.slice(0, files.length - this.maxFiles);
                for (const file of toDelete) {
                    const filePath = path_1.default.join(this.logDir, file);
                    // Do not delete current active file
                    if (filePath !== this.currentFilePath) {
                        try {
                            fs_1.default.unlinkSync(filePath);
                        }
                        catch { }
                    }
                }
            }
        }
        catch { }
    }
    async close() {
        this.isClosed = true;
    }
}
exports.RotatingJsonlWriter = RotatingJsonlWriter;
