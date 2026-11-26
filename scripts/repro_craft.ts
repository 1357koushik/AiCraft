/**
 * Reproduces the crafting failures seen live (sticks crafted as 0, updateSlot:0 timeouts, items vanishing,
 * a stray oak_button) on a fresh harness world, with no agent and no LLM in the loop.
 *
 * Setup uses RCON (/give), which is allowed for diagnosis. Every inventory-related packet in both directions
 * is logged, and after each craft the bot's own view is compared with the server's (RCON) view.
 *
 *   npx tsx scripts/repro_craft.ts [--native] [--back-to-back] [--loops N]
 *
 * --back-to-back runs the crafts with no pause between them, the way the agent does.
 * --reliable uses craftReliably (src/actions/reliable_craft.ts) instead of bot.craft.
 *
 * --native uses bot.recipesFor (Mineflayer's own recipe lookup) instead of the agent's RecipeResolver.
 */
import fs from 'fs';
import path from 'path';
import mineflayer, { Bot } from 'mineflayer';
import { HarnessServer } from '../src/harness/server.js';
import { snapshotPlayer } from '../src/oracle/probe.js';
import { RecipeResolver } from '../src/actions/crafting.js';
import { craftReliably } from '../src/actions/reliable_craft.js';
import { logDir } from '../src/utils/paths.js';

const BOT = 'dragonai';
const native = process.argv.includes('--native');
const backToBack = process.argv.includes('--back-to-back');
const reliable = process.argv.includes('--reliable');
const loopsArg = process.argv.indexOf('--loops');
const loops = loopsArg >= 0 ? parseInt(process.argv[loopsArg + 1], 10) : 1;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
const outDir = path.resolve(logDir('repro', `craft_${stamp}${native ? '_native' : ''}${process.argv.includes('--reliable') ? '_reliable' : ''}${process.argv.includes('--back-to-back') ? '_b2b' : ''}`));
fs.mkdirSync(outDir, { recursive: true });
const logFile = fs.createWriteStream(path.join(outDir, 'repro.log'));
const t0 = Date.now();
function log(line: string): void {
  const s = `[${((Date.now() - t0) / 1000).toFixed(2)}] ${line}`;
  console.log(s);
  logFile.write(`${s}\n`);
}

const WATCH_IN = new Set(['set_slot', 'window_items', 'set_cursor_item', 'set_player_inventory', 'open_window', 'close_window', 'craft_recipe_response', 'declare_recipes', 'recipe_book_add', 'recipe_book_settings']);
const WATCH_OUT = new Set(['window_click', 'close_window', 'craft_recipe_request', 'held_item_slot', 'set_creative_slot']);

function itemText(it: any): string {
  return it ? `${it.name}x${it.count}` : '-';
}

function botView(bot: Bot): string {
  const s = bot.inventory.slots;
  const grid = [0, 1, 2, 3, 4].map((i) => `${i}:${itemText(s[i])}`).join(' ');
  const cursor = itemText((bot.inventory as any).selectedItem);
  const items: Record<string, number> = {};
  for (const it of bot.inventory.items()) items[it.name] = (items[it.name] ?? 0) + it.count;
  const win = bot.currentWindow ? `${bot.currentWindow.type}#${bot.currentWindow.id}` : 'none';
  return `grid[${grid}] cursor=${cursor} window=${win} items=${JSON.stringify(items)}`;
}

async function serverView(rcon: any): Promise<string> {
  const snap = await snapshotPlayer(rcon, BOT);
  return JSON.stringify(snap.items);
}

async function main(): Promise<void> {
  const server = new HarnessServer({ players: [BOT] });
  server.ensureInstance();
  const world = { name: `repro_craft_${stamp}`, seed: '20261109' };
  server.prepareWorld(world);
  log(`starting server, world ${world.name}`);
  const running = await server.start(world, { stdoutPath: path.join(outDir, 'server-stdout.log') });
  const rcon = running.rcon;
  let bot: Bot | null = null;
  try {
    bot = mineflayer.createBot({ host: '127.0.0.1', port: server.port, username: BOT, version: '1.21.6', auth: 'offline' });
    const b = bot;
    const client: any = (b as any)._client;
    client.on('packet', (data: any, meta: any) => {
      if (!WATCH_IN.has(meta.name)) return;
      const brief = meta.name === 'window_items' ? { windowId: data.windowId, stateId: data.stateId, n: data.items?.length, carried: data.carriedItem?.itemId } : meta.name === 'declare_recipes' ? '(declare_recipes)' : data;
      log(`<< ${meta.name} ${JSON.stringify(brief)}`);
    });
    const write = client.write.bind(client);
    client.write = (name: string, params: any) => {
      if (WATCH_OUT.has(name)) log(`>> ${name} ${JSON.stringify(params)}`);
      return write(name, params);
    };
    await new Promise<void>((res, rej) => {
      b.once('spawn', () => res());
      b.once('kicked', (r) => rej(new Error(`kicked: ${r}`)));
      b.once('error', rej);
    });
    log(`spawned at ${b.entity.position}`);
    await b.waitForTicks(40);

    let failures = 0;
    const step = async (label: string, fn: () => Promise<void>) => {
      log(`==== ${label}`);
      log(`   before bot: ${botView(b)}`);
      log(`   before srv: ${await serverView(rcon)}`);
      try {
        await fn();
        log(`   result: ok`);
      } catch (err) {
        failures++;
        log(`   result: THREW ${(err as Error).message}`);
      }
      if (!backToBack) await b.waitForTicks(10);
      log(`   after  bot: ${botView(b)}`);
      log(`   after  srv: ${await serverView(rcon)}`);
    };

    const craft = async (item: string, count: number, table: any = null) => {
      if (native) {
        const def = b.registry.itemsByName[item];
        const recipes = b.recipesFor(def.id, null, 1, table);
        log(`   native recipesFor(${item}) -> ${recipes.length} recipe(s)`);
        if (!recipes.length) throw new Error(`no recipe for ${item}`);
        await b.craft(recipes[0], count, table ?? undefined);
        return;
      }
      const plan = new RecipeResolver(b).resolvePlan(item, count);
      log(`   plan feasible=${plan.feasible} steps=${plan.steps.map((s) => `${s.targetItemName}x${s.executionCount}exec${s.requiresTable ? '(table)' : ''}`).join(',')} missing=${JSON.stringify(plan.missingIngredients)}`);
      for (const s of plan.steps) {
        const shape = JSON.stringify(s.recipe.inShape ?? s.recipe.ingredients);
        log(`   step ${s.targetItemName}: recipe result=${JSON.stringify(s.recipe.result)} shape=${shape} delta=${JSON.stringify(s.recipe.delta)}`);
        if (reliable) await craftReliably(b, s.recipe, s.executionCount, s.requiresTable ? table : null);
        else await b.craft(s.recipe, s.executionCount, s.requiresTable ? table : undefined);
      }
    };

    const lost: string[] = [];
    for (let loop = 1; loop <= loops; loop++) {
      await rcon.command(`clear ${BOT}`);
      await rcon.command(`give ${BOT} oak_log 6`);
      await b.waitForTicks(20);
      log(`######## loop ${loop}/${loops}${backToBack ? ' (back to back)' : ''}`);
      const have = (n: string) => b.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
      await step('A: 4 oak_planks (1 execution)', () => craft('oak_planks', 4));
      await step('B: 12 oak_planks (3 executions, the "expected 12, got 8" case)', () => craft('oak_planks', 12));
      await step('C: crafting_table in the 2x2 grid', () => craft('crafting_table', 1));
      await step('D: 4 sticks in the 2x2 grid', () => craft('stick', 4));
      await step('E: 8 sticks (2 executions)', () => craft('stick', 8));
      await rcon.command(`execute at ${BOT} run setblock ~2 ~ ~ crafting_table`);
      await b.waitForTicks(10);
      const tableBlock = b.findBlock({ matching: (bl: any) => bl.name === 'crafting_table', maxDistance: 4 });
      await step('F: wooden_pickaxe on a crafting table (3x3)', async () => {
        if (!tableBlock) throw new Error('setup: no crafting table placed');
        await craft('wooden_pickaxe', 1, tableBlock);
      });
      await rcon.command(`execute at ${BOT} run setblock ~2 ~ ~ air`);
      await b.waitForTicks(20);
      const srv = JSON.parse(await serverView(rcon));
      // 6 logs = 24 planks of wood. Expected end state: 3 logs left is not guaranteed by the resolver, so check
      // conservation instead: logs*4 + planks + table*4 + sticks/2 must equal 24.
      const wood = (srv.oak_log ?? 0) * 4 + (srv.oak_planks ?? 0) + (srv.crafting_table ?? 0) * 4 + (srv.stick ?? 0) / 2 + (srv.oak_button ?? 0) + (srv.oak_pressure_plate ?? 0) * 2 + (srv.wooden_pickaxe ?? 0) * 4;
      const verdict = wood === 24 && !srv.oak_button && srv.wooden_pickaxe === 1 ? 'ok' : `LOST/WRONG (wood units ${wood}/24, items ${JSON.stringify(srv)})`;
      if (verdict !== 'ok') lost.push(`loop ${loop}: ${verdict}`);
      log(`######## loop ${loop} conservation: ${verdict}; bot sticks ${have('stick')}`);
    }
    log(`SUMMARY: ${loops} loop(s), ${failures} craft call(s) threw, ${lost.length} loop(s) lost or mis-crafted items${lost.length ? `: ${lost.join(' | ')}` : ''}`);

    log('==== closing inventory and re-reading');
    await b.waitForTicks(20);
    log(`   final bot: ${botView(b)}`);
    log(`   final srv: ${await serverView(rcon)}`);
  } finally {
    bot?.quit();
    await new Promise((r) => setTimeout(r, 2000));
    log(`   after logout srv file will be in ${running.worldDir}/playerdata`);
    await running.stop();
    log(`done; log at ${outDir}`);
    logFile.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
