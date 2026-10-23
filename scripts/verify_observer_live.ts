import fs from 'fs';
import path from 'path';
import http from 'http';
import { VanillaGroundTruthObserver } from '../tools/vanilla-observer/index.js';

function requestBridge(
  port: number,
  reqPath: string,
  method: string,
  token: string,
  body?: any
): Promise<{ status: number; json?: any; body: string }> {
  return new Promise((resolve, reject) => {
    const jsonStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'X-Observer-Token': token,
          'Connection': 'close',
          ...(jsonStr
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(jsonStr)),
              }
            : {}),
        },
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(resData);
          } catch {}
          resolve({ status: res.statusCode || 0, json, body: resData });
        });
      }
    );
    req.on('error', reject);
    if (jsonStr) req.write(jsonStr);
    req.end();
  });
}

async function main() {
  console.log('=== Step 1: Initializing Vanilla Ground-Truth Observer ===');
  const runId = `verify_live_${Date.now()}`;
  const observer = new VanillaGroundTruthObserver({
    serverHost: '127.0.0.1',
    serverPort: 25565,
    observerUsername: 'dragonai',
    runId,
    logDir: 'logs/integration',
    bridgePort: 25580,
    bridgeTokenFile: 'logs/integration/.bridge_token',
    snapshotIntervalMs: 500,
  });

  console.log('=== Step 2: Starting Observer and Connecting to Live Server ===');
  await observer.start();

  const token = observer.bridgeServer.authToken;
  console.log(`[Observer] Bridge started on port 25580. Generated token: ${token.substring(0, 8)}...`);

  // Verify status endpoint
  console.log('=== Step 3: Querying Bridge Status Endpoint ===');
  const statusRes = await requestBridge(25580, '/status', 'GET', token);
  console.log(`[Bridge] GET /status -> ${statusRes.status}`, statusRes.json);

  // Send action start
  console.log('=== Step 4: Binding Action Context via POST /action/start ===');
  const startRes = await requestBridge(25580, '/action/start', 'POST', token, {
    runId,
    goalId: 'goal_verify_ground_truth',
    actionId: 'act_live_probe_001',
    actionName: 'probe_server',
  });
  console.log(`[Bridge] POST /action/start -> ${startRes.status}`, startRes.json);

  // Wait 1.5 seconds for periodic snapshots to record active action context
  console.log('=== Step 5: Awaiting Real Server Events & Snapshots (1500ms) ===');
  await new Promise((r) => setTimeout(r, 1500));

  // Send action end
  console.log('=== Step 6: Unbinding Action Context via POST /action/end ===');
  const endRes = await requestBridge(25580, '/action/end', 'POST', token, {});
  console.log(`[Bridge] POST /action/end -> ${endRes.status}`, endRes.json);

  // Stop observer cleanly
  console.log('=== Step 7: Stopping Observer and Closing Writer ===');
  await observer.stop();

  console.log('=== Step 8: Inspecting Recorded Server Observations ===');
  const logDir = path.resolve(process.cwd(), 'logs/integration');
  const logFiles = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith(`observer-vanilla-${runId}`) && f.endsWith('.jsonl'));

  if (logFiles.length === 0) {
    throw new Error(`No log files found matching runId ${runId} in ${logDir}`);
  }

  const activeLog = path.join(logDir, logFiles[0]);
  console.log(`Reading generated log: ${activeLog}`);
  const lines = fs.readFileSync(activeLog, 'utf8').trim().split('\n');
  console.log(`Total events recorded: ${lines.length}`);

  const eventTypes: string[] = [];
  for (const line of lines) {
    const ev = JSON.parse(line);
    eventTypes.push(ev.eventType);
    console.log(
      `  [Seq #${ev.seq}] [${ev.timestamp}] [${ev.eventType}] ${
        ev.coordinates ? `pos=(${ev.coordinates.x}, ${ev.coordinates.y}, ${ev.coordinates.z})` : ''
      } ${ev.activeContext ? `activeContext=${JSON.stringify(ev.activeContext)}` : ''}`
    );
  }

  // Verification checks
  if (!eventTypes.includes('OBSERVER_STARTUP')) {
    throw new Error('Missing OBSERVER_STARTUP event');
  }
  if (!eventTypes.includes('PLAYER_JOIN')) {
    throw new Error('Missing PLAYER_JOIN event');
  }
  if (!eventTypes.includes('PERIODIC_SNAPSHOT')) {
    throw new Error('Missing PERIODIC_SNAPSHOT event');
  }
  if (!eventTypes.includes('OBSERVER_SHUTDOWN')) {
    throw new Error('Missing OBSERVER_SHUTDOWN event');
  }

  console.log('\n[SUCCESS] Ground-truth observer successfully recorded real live server events!');
}

main().catch((err) => {
  console.error('[ERROR] Verification failed:', err);
  process.exit(1);
});
