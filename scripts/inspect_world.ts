import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

async function main() {
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port: 25565,
    username: 'dragonai',
    version: '1.21.6',
    auth: 'offline',
  });

  bot.once('spawn', async () => {
    console.log(`[Spawn] Bot spawned at ${bot.entity.position}`);
    console.log(`[Inventory] Items in inventory:`);
    for (const item of bot.inventory.items()) {
      console.log(`  - ${item.name} x${item.count}`);
    }

    console.log('[Wait] Waiting 2500ms for world chunks to stream from server...');
    await new Promise((r) => setTimeout(r, 2500));

    const p = bot.entity.position.floored();
    console.log(`\n[Scan] Scanning 32 blocks around ${p}...`);

    const stoneBlocks: Vec3[] = [];
    const logBlocks: Vec3[] = [];
    const tableBlocks: Vec3[] = [];

    for (let dx = -32; dx <= 32; dx++) {
      for (let dz = -32; dz <= 32; dz++) {
        for (let dy = -16; dy <= 16; dy++) {
          const pos = p.offset(dx, dy, dz);
          const b = bot.blockAt(pos);
          if (!b) continue;
          if (b.name === 'crafting_table') tableBlocks.push(pos);
          if (b.name.includes('stone') || b.name === 'granite' || b.name === 'diorite' || b.name === 'andesite') {
            stoneBlocks.push(pos);
          }
          if (b.name.includes('_log')) logBlocks.push(pos);
        }
      }
    }

    const exposedStone: Vec3[] = [];
    for (const pos of stoneBlocks) {
      if (pos.y < 50) continue;
      // Check 6 orthogonal neighbors for air
      const neighbors = [
        pos.offset(0, 1, 0),
        pos.offset(0, -1, 0),
        pos.offset(1, 0, 0),
        pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1),
        pos.offset(0, 0, -1),
      ];
      if (neighbors.some((n) => bot.blockAt(n)?.name === 'air')) {
        exposedStone.push(pos);
      }
    }

    console.log(`\nExposed surface stone (Y >= 50 with air neighbor): ${exposedStone.length}`);
    exposedStone.sort((a, b) => a.distanceTo(p) - b.distanceTo(p));
    const table = bot.blockAt(new Vec3(28, 66, -52));
    console.log(`Crafting table at (28, 66, -52): ${table?.name}`);

    bot.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
