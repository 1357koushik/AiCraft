import readline from 'readline';
import type { Bot } from 'mineflayer';
import { loadConfig } from '../config/index.js';
import { AgentLogger } from '../utils/logger.js';
import { ConnectionManager } from '../connection/index.js';
import { buildRegistry } from '../skills/registry.js';
import { createChatClient } from '../brain/llm_client.js';
import { missingFor, craftableNow } from '../brain/requirements.js';
import { installReflexGuard } from '../reflexes/guard.js';
import { Companion } from './companion.js';
import { PlacesMemory, placesFileFor, setActivePlaces, startPlacesScan } from '../memory/places.js';

/**
 * `npm run companion`: the bot as a companion on the server in config/config.yaml. Owners (config agent.owners)
 * give tasks in chat; lines typed here are tasks from the operator. Replaces the old agent loop in src/main.ts.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new AgentLogger(config);
  const owners: string[] = config.agent.owners ?? [];
  const registry = buildRegistry();
  const llm = createChatClient();
  const connection = new ConnectionManager(config, logger);
  const log = (line: string) => logger.info(line);

  let companion: Companion | null = null;
  let stopReflexes: (() => void) | null = null;
  let stopPlaces: (() => void) | null = null;
  // Places memory persists per server, so what the bot saw (and the names owners gave places) survives restarts.
  const places = new PlacesMemory(placesFileFor(`${config.server.host}-${config.server.port}`));
  setActivePlaces(places);

  const attach = async (bot: Bot) => {
    // A reconnect gives a new bot object: restart the reflexes on it, and move the companion over with its queue,
    // standing orders and history intact.
    stopReflexes?.();
    stopPlaces?.();
    stopPlaces = startPlacesScan(bot, places, { log });
    stopReflexes = installReflexGuard(bot, (e) => log(`[reflex] ${e.reflex}: ${e.detail}`));
    bot.once('end', () => companion?.detach());
    if (companion) return companion.rebind(bot);
    companion = new Companion({ bot, owners, registry, llm, requirements: { missingFor, craftableNow }, log });
    companion.start();
    log(`[companion] ready; listening to ${owners.join(', ') || 'no owners (set agent.owners in config.yaml)'} using ${llm.model}`);
  };

  const shutdown = async () => {
    log('[companion] shutting down');
    stopReflexes?.();
    stopPlaces?.();
    await companion?.shutdown();
    connection.disconnect();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await connection.connect({ onSpawn: (bot) => void attach(bot) });

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      if (text === '/quit') return void shutdown();
      companion?.submit(text, owners[0] ?? 'console');
    });
    log('[companion] type a task here (or /quit)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
