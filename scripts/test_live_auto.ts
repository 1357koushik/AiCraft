import { loadConfig } from '../src/config/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { ConnectionManager } from '../src/connection/index.js';
import { countResourceInInventory, updatePathfinderMovements } from '../src/actions/techniques.js';

async function testLive() {
  const config = loadConfig();
  const logger = new AgentLogger(config);
  const connection = new ConnectionManager(config, logger);

  console.log(`[TEST] Connecting to Minecraft server at ${config.server.host}:${config.server.port} as '${config.server.username}'...`);

  await connection.connect({
    onSpawn: (b) => {
      console.log(`[TEST] SUCCESS: Bot spawned at (${b.entity.position.x.toFixed(1)}, ${b.entity.position.y.toFixed(1)}, ${b.entity.position.z.toFixed(1)})`);
      console.log(`[TEST] Health: ${b.health}/20, Food: ${b.food}/20`);
      console.log(`[TEST] In water? ${(b.entity as any).isInWater}`);
      const inv = b.inventory.items().map((i) => `${i.name} x${i.count}`).join(', ');
      console.log(`[TEST] Inventory: ${inv || 'Empty'}`);
      console.log(`[TEST] Wood logs: ${countResourceInInventory(b, 'wood')}`);
      console.log(`[TEST] Stone/Cobble: ${countResourceInInventory(b, 'stone')}`);

      setTimeout(() => {
        console.log('[TEST] Verification complete. Disconnecting...');
        connection.disconnect();
        process.exit(0);
      }, 3000);
    },
  });
}

testLive().catch((err) => {
  console.error('[TEST] Live connection error:', err.message);
  process.exit(1);
});
