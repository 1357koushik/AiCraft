import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { RotatingJsonlWriter, ObserverEvent } from '../tools/vanilla-observer/writer.js';
import { VanillaBridgeServer } from '../tools/vanilla-observer/bridge.js';

describe('Vanilla Ground-Truth Observer & Loopback Bridge', () => {
  let tempDir: string;
  let writer: RotatingJsonlWriter;
  let bridge: VanillaBridgeServer;
  const testPort = 25585;

  beforeEach(async () => {
    tempDir = path.resolve(process.cwd(), `tmp_observer_test_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    writer = new RotatingJsonlWriter({
      logDir: tempDir,
      runId: 'test_run',
      maxSizeBytes: 1024 * 1024,
      maxFiles: 3,
    });
    await writer.start();

    bridge = new VanillaBridgeServer({
      host: '127.0.0.1',
      port: testPort,
      tokenFile: path.join(tempDir, '.token'),
      runId: 'test_run',
      writer,
      getSnapshotHandler: () => ({ mockHealth: 20 }),
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await writer.close();

    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  function makeRequest(
    reqPath: string,
    method: string,
    token: string | null,
    body?: string
  ): Promise<{ status: number; body: string; json?: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Connection: 'close',
      };
      if (token) headers['X-Observer-Token'] = token;
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: testPort,
          path: reqPath,
          method,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let json;
            try {
              json = JSON.parse(data);
            } catch {}
            resolve({ status: res.statusCode || 0, body: data, json });
          });
        }
      );

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('verifies structured event serialization and monotonic sequence numbering', async () => {
    for (let i = 1; i <= 5; i++) {
      const seq = writer.nextSeq();
      const event: ObserverEvent = {
        seq,
        timestamp: new Date().toISOString(),
        serverRunId: 'test_run',
        dimension: 'minecraft:overworld',
        playerName: 'dragonai',
        eventType: 'TEST_EVENT',
        coordinates: { x: i, y: 64, z: i },
        amount: i,
        details: { stepIndex: i },
      };
      writer.write(event);
    }

    await writer.close();

    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);

    const lines = fs.readFileSync(path.join(tempDir, files[0]), 'utf8').trim().split('\n');
    expect(lines.length).toBe(5);

    for (let idx = 0; idx < lines.length; idx++) {
      const parsed = JSON.parse(lines[idx]);
      expect(parsed.seq).toBe(idx + 1);
      expect(parsed.serverRunId).toBe('test_run');
      expect(parsed.eventType).toBe('TEST_EVENT');
    }
  });

  it('rejects unauthorized bridge requests when token is missing or invalid', async () => {
    const resNoToken = await makeRequest('/status', 'GET', null);
    expect(resNoToken.status).toBe(401);

    const resWrongToken = await makeRequest('/status', 'GET', 'fake_token_xyz');
    expect(resWrongToken.status).toBe(401);
  });

  it('authorizes requests with valid token and returns active status', async () => {
    const res = await makeRequest('/status', 'GET', bridge.authToken);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ACTIVE');
    expect(res.json.serverRunId).toBe('test_run');
    expect(res.json.loopbackOnly).toBe(true);
  });

  it('binds and unbinds agent action context via authenticated bridge endpoints', async () => {
    const token = bridge.authToken;

    // 1. Action start
    const startPayload = JSON.stringify({
      runId: 'test_run',
      goalId: 'goal_logs_32',
      actionId: 'act_chop_tree_001',
      actionName: 'chop_tree',
    });
    const startRes = await makeRequest('/action/start', 'POST', token, startPayload);
    expect(startRes.status).toBe(200);
    expect(startRes.json.ok).toBe(true);
    expect(bridge.activeContext?.actionId).toBe('act_chop_tree_001');

    // 2. Action end
    const endRes = await makeRequest('/action/end', 'POST', token, '{}');
    expect(endRes.status).toBe(200);
    expect(endRes.json.ok).toBe(true);
    expect(bridge.activeContext).toBeNull();
  });

  it('rejects payloads exceeding the 16KB limit with 413 Payload Too Large', async () => {
    const token = bridge.authToken;
    const oversizedBody = JSON.stringify({
      data: 'x'.repeat(20 * 1024), // 20KB
    });

    const res = await makeRequest('/action/start', 'POST', token, oversizedBody);
    expect(res.status).toBe(413);
  });

  it('redacts sensitive tokens and secret keys before writing to log', () => {
    const sensitive = '{"token":"secretToken123","auth":"Bearer sk-antigravityKey9876543210"}';
    const redacted = RotatingJsonlWriter.redact(sensitive);

    expect(redacted).not.toContain('secretToken123');
    expect(redacted).not.toContain('sk-antigravityKey9876543210');
    expect(redacted).toContain('"token":"***REDACTED***"');
    expect(redacted).toContain('sk-***REDACTED***');
  });

  it('rotates log files and purges files exceeding maxFiles cap', async () => {
    const rotDir = path.resolve(tempDir, 'rot_sub');
    fs.mkdirSync(rotDir, { recursive: true });

    const rotWriter = new RotatingJsonlWriter({
      logDir: rotDir,
      runId: 'rot_test',
      maxSizeBytes: 200, // Very small threshold (200 bytes)
      maxFiles: 3,
    });
    await rotWriter.start();

    // Write 15 events
    for (let i = 0; i < 15; i++) {
      rotWriter.write({
        seq: rotWriter.nextSeq(),
        timestamp: new Date().toISOString(),
        serverRunId: 'rot_test',
        dimension: 'overworld',
        eventType: 'EVENT_FILL',
        details: { padding: 'padding_data_to_exceed_200_bytes_' + i },
      });
    }

    await rotWriter.close();

    const files = fs.readdirSync(rotDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
