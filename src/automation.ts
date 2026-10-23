import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { loadConfig } from './config/index.js';
import { AgentLogger } from './utils/logger.js';
import { ConnectionManager } from './connection/index.js';
import {
  techniqueChopTreeFull,
  techniqueCraftPipeline,
  techniqueCollectResource,
  techniqueBuildShelter,
  countResourceInInventory,
  updatePathfinderMovements,
} from './actions/techniques.js';

/**
 * Autonomous Survival Progression Automation Runner
 * Implements deterministic macro-pipeline inspired by Voyager & Mindcraft architectures:
 * - Real-time physics daemon (anti-drowning, auto-jump) runs continuously on physicsTick
 * - Autonomous tree harvesting (base to top + scaffolding teardown + vacuum drops)
 * - Workstation lifecycle management (crafting table placement, recursive crafting, teardown recovery)
 * - Safe resource mining with hazard detection & vacuum drop collection
 * - Autonomous survival shelter construction
 */

function formatInventory(bot: Bot): string {
  if (!bot.inventory) return 'Empty';
  const itemMap = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    itemMap.set(item.name, (itemMap.get(item.name) || 0) + item.count);
  }
  if (itemMap.size === 0) return 'Empty';
  return Array.from(itemMap.entries())
    .map(([name, count]) => `${name} x${count}`)
    .join(', ');
}

function hasItem(bot: Bot, nameSubstring: string): boolean {
  if (!bot.inventory) return false;
  return bot.inventory.items().some((i) => i.name.includes(nameSubstring));
}

function getItemCount(bot: Bot, exactName: string): number {
  if (!bot.inventory) return 0;
  return bot.inventory.items()
    .filter((i) => i.name === exactName)
    .reduce((sum, i) => sum + i.count, 0);
}

export class SurvivalAutomationPipeline {
  private bot: Bot;
  private logger: AgentLogger;
  private abortController: AbortController = new AbortController();
  private isPaused = false;
  private currentMilestone = 1;
  private wasInWater = false;

  private lastShoreSearchTime = 0;
  private currentShoreTarget: any = null;

  constructor(bot: Bot, logger: AgentLogger) {
    this.bot = bot;
    this.logger = logger;
    this.setupAntiDrowningDaemon();
    this.setupChatCommands();
  }

  /**
   * Real-time anti-drowning daemon (Mindcraft modes.js pattern).
   * Runs directly on the Mineflayer physics loop (every 50ms) independent of async operations.
   */
  private setupAntiDrowningDaemon(): void {
    this.bot.on('physicsTick', () => {
      if (!this.bot.entity) return;
      const inWater = Boolean((this.bot.entity as any).isInWater);
      const feetBlock = this.bot.blockAt ? this.bot.blockAt(this.bot.entity.position) : null;
      const headBlock = this.bot.blockAt ? this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0)) : null;
      const isSubmerged = feetBlock?.name === 'water' || headBlock?.name === 'water';

      if (inWater || isSubmerged) {
        this.bot.setControlState('jump', true);
        this.wasInWater = true;
        this.swimToShore();
      } else if (this.wasInWater) {
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', false);
        this.wasInWater = false;
        this.currentShoreTarget = null;
      }
    });

    this.logger.info('Anti-drowning physics daemon activated (swimming on 50ms physics tick).');
  }

  private swimToShore(): void {
    const now = Date.now();
    if (now - this.lastShoreSearchTime > 400 || !this.currentShoreTarget) {
      this.lastShoreSearchTime = now;
      this.currentShoreTarget = this.findNearestShoreBlock();
      if (this.currentShoreTarget) {
        console.log(`[WATER_SAFETY] Shore detected at (${this.currentShoreTarget.x}, ${this.currentShoreTarget.y}, ${this.currentShoreTarget.z}). Steering and swimming to dry land!`);
      }
    }

    if (this.currentShoreTarget && this.bot.lookAt) {
      this.bot.lookAt(this.currentShoreTarget.offset(0.5, 1.2, 0.5), true).catch(() => {});
      this.bot.setControlState('forward', true);
      this.bot.setControlState('jump', true);
    } else {
      // In open water without immediate shore: keep head above water and paddle
      this.bot.setControlState('forward', true);
      this.bot.setControlState('jump', true);
    }
  }

  private findNearestShoreBlock(): any {
    if (!this.bot.entity || !this.bot.blockAt) return null;
    const botPos = this.bot.entity.position.floored();
    let bestPos: any = null;
    let bestDist = Infinity;

    for (let dx = -10; dx <= 10; dx++) {
      for (let dz = -10; dz <= 10; dz++) {
        for (let dy = -1; dy <= 2; dy++) {
          const checkPos = botPos.offset(dx, dy, dz);
          const ground = this.bot.blockAt(checkPos);
          if (!ground || ground.boundingBox !== 'block') continue;
          if (ground.name === 'water' || ground.name === 'flowing_water' || ground.name === 'lava' || ground.name === 'fire') continue;

          const feet = this.bot.blockAt(checkPos.offset(0, 1, 0));
          const head = this.bot.blockAt(checkPos.offset(0, 2, 0));
          if (!feet || feet.name === 'water' || feet.name === 'flowing_water' || feet.boundingBox === 'block') continue;
          if (!head || head.name === 'water' || head.name === 'flowing_water' || head.boundingBox === 'block') continue;

          const dist = Math.hypot(dx, dz) + Math.abs(dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestPos = checkPos.offset(0, 1, 0);
          }
        }
      }
    }
    return bestPos;
  }

  /**
   * In-game chat listener allowing players on the server to interact with the automation pipeline.
   */
  private setupChatCommands(): void {
    this.bot.on('chat', async (username: string, message: string) => {
      if (username === this.bot.username) return;
      const trimmed = message.trim();

      if (trimmed === '!status') {
        const pos = this.bot.entity?.position;
        const hp = this.bot.health;
        const food = this.bot.food;
        const inv = formatInventory(this.bot);
        this.bot.chat(`[Status] HP: ${hp}/20 | Food: ${food}/20 | Pos: ${pos?.x.toFixed(0)}, ${pos?.y.toFixed(0)}, ${pos?.z.toFixed(0)} | Milestone: ${this.currentMilestone}`);
        this.bot.chat(`[Inventory] ${inv.slice(0, 100)}...`);
      } else if (trimmed === '!pause') {
        this.isPaused = true;
        this.bot.chat('Automation paused.');
        this.logger.info('Automation paused via chat command.');
      } else if (trimmed === '!resume') {
        this.isPaused = false;
        this.bot.chat('Automation resumed.');
        this.logger.info('Automation resumed via chat command.');
      } else if (trimmed === '!help') {
        this.bot.chat('Commands: !status, !pause, !resume, !help');
      }
    });
  }

  public async run(): Promise<void> {
    this.logger.info('===========================================================');
    this.logger.info('    STARTING AUTONOMOUS SURVIVAL PROGRESSION PIPELINE     ');
    this.logger.info('===========================================================');

    // Wait 1.5 seconds for chunks to settle
    await new Promise((res) => setTimeout(res, 1500));
    updatePathfinderMovements(this.bot);

    while (!this.abortController.signal.aborted) {
      if (this.isPaused) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }

      try {
        await this.executeNextMilestone();
      } catch (err: any) {
        this.logger.error(`Error during milestone execution: ${err.message}`);
        await new Promise((res) => setTimeout(res, 3000));
      }

      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  private async executeNextMilestone(): Promise<void> {
    const logs = countResourceInInventory(this.bot, 'wood');
    const cobble = countResourceInInventory(this.bot, 'stone');
    const hasWoodPick = hasItem(this.bot, 'wooden_pickaxe') || hasItem(this.bot, 'stone_pickaxe') || hasItem(this.bot, 'iron_pickaxe');
    const hasStonePick = hasItem(this.bot, 'stone_pickaxe') || hasItem(this.bot, 'iron_pickaxe');
    const hasStoneAxe = hasItem(this.bot, 'stone_axe') || hasItem(this.bot, 'iron_axe');
    const hasFurnace = hasItem(this.bot, 'furnace');

    this.logger.info(
      `[Progression State] Logs: ${logs} | Cobble: ${cobble} | WoodPick: ${hasWoodPick} | StonePick: ${hasStonePick} | StoneAxe: ${hasStoneAxe} | Furnace: ${hasFurnace}`
    );
    this.logger.info(`[Current Inventory] ${formatInventory(this.bot)}`);

    // -------------------------------------------------------------
    // MILESTONE 1: Gather Tree Logs (>= 4 logs)
    // -------------------------------------------------------------
    if (logs < 4 && !hasWoodPick) {
      this.currentMilestone = 1;
      this.logger.info(`🌲 [Milestone 1: Wood Harvesting] Bot has ${logs} logs. Searching for trees within 48 blocks...`);
      this.bot.chat(`[Milestone 1] Chopping trees for wood...`);

      const chopResult = await techniqueChopTreeFull(this.bot, 48, this.abortController.signal);
      this.logger.info(`Chop tree result: ${chopResult.status} - ${chopResult.reason}`);

      if (chopResult.status !== 'success') {
        // If no tree immediately visible, explore safely to find trees
        this.logger.warn(`No tree found nearby. Exploring to find trees...`);
        await this.exploreSafely();
      }
      return;
    }

    // -------------------------------------------------------------
    // MILESTONE 2: Craft Wooden Pickaxe (Logs -> Planks -> Table -> Sticks -> Wooden Pickaxe)
    // -------------------------------------------------------------
    if (!hasWoodPick) {
      this.currentMilestone = 2;
      this.logger.info(`🔨 [Milestone 2: Wooden Pickaxe] Crafting wooden pickaxe pipeline...`);
      this.bot.chat(`[Milestone 2] Crafting wooden pickaxe...`);

      const craftRes = await techniqueCraftPipeline(this.bot, 'wooden_pickaxe', this.abortController.signal);
      this.logger.info(`Craft wooden pickaxe result: ${craftRes.status} - ${craftRes.reason}`);

      if (craftRes.status === 'success') {
        this.bot.chat(`[Milestone 2 Complete] Wooden pickaxe crafted!`);
      }
      return;
    }

    // -------------------------------------------------------------
    // MILESTONE 3: Mine Cobblestone (>= 8 cobblestone)
    // -------------------------------------------------------------
    if (cobble < 8 && !hasStonePick) {
      this.currentMilestone = 3;
      const needed = 8 - cobble;
      this.logger.info(`⛏️ [Milestone 3: Cobblestone] Bot has ${cobble} cobblestone. Mining ${needed} more...`);
      this.bot.chat(`[Milestone 3] Mining cobblestone with wooden pickaxe...`);

      const mineRes = await techniqueCollectResource(this.bot, 'stone', needed, this.abortController.signal);
      this.logger.info(`Mine stone result: ${mineRes.status} - ${mineRes.reason}`);

      if (mineRes.status !== 'success') {
        this.logger.warn(`Could not find surface stone. Exploring or clearing dirt...`);
        await this.exploreSafely();
      }
      return;
    }

    // -------------------------------------------------------------
    // MILESTONE 4: Craft Stone Pickaxe and Stone Axe
    // -------------------------------------------------------------
    if (!hasStonePick || !hasStoneAxe) {
      this.currentMilestone = 4;
      if (!hasStonePick) {
        this.logger.info(`🔨 [Milestone 4: Stone Pickaxe] Crafting stone pickaxe...`);
        this.bot.chat(`[Milestone 4] Crafting stone pickaxe...`);
        const craftPickRes = await techniqueCraftPipeline(this.bot, 'stone_pickaxe', this.abortController.signal);
        this.logger.info(`Craft stone pickaxe result: ${craftPickRes.status} - ${craftPickRes.reason}`);
      }

      if (!hasStoneAxe) {
        this.logger.info(`🪓 [Milestone 4: Stone Axe] Crafting stone axe...`);
        this.bot.chat(`[Milestone 4] Crafting stone axe...`);
        const craftAxeRes = await techniqueCraftPipeline(this.bot, 'stone_axe', this.abortController.signal);
        this.logger.info(`Craft stone axe result: ${craftAxeRes.status} - ${craftAxeRes.reason}`);
      }

      if (hasItem(this.bot, 'stone_pickaxe')) {
        this.bot.chat(`[Milestone 4 Complete] Stone tools ready!`);
      }
      return;
    }

    // -------------------------------------------------------------
    // MILESTONE 5: Craft Furnace (requires 8 cobblestone)
    // -------------------------------------------------------------
    if (!hasFurnace) {
      this.currentMilestone = 5;
      if (cobble < 8) {
        const needed = 8 - cobble;
        this.logger.info(`⛏️ [Milestone 5 Pre-requisite] Need ${needed} more cobblestone for furnace.`);
        await techniqueCollectResource(this.bot, 'stone', needed, this.abortController.signal);
      }

      this.logger.info(`🔥 [Milestone 5: Furnace] Crafting furnace with cobblestone...`);
      this.bot.chat(`[Milestone 5] Crafting furnace...`);
      const furnaceRes = await techniqueCraftPipeline(this.bot, 'furnace', this.abortController.signal);
      this.logger.info(`Craft furnace result: ${furnaceRes.status} - ${furnaceRes.reason}`);

      if (furnaceRes.status === 'success') {
        this.bot.chat(`[Milestone 5 Complete] Furnace crafted!`);
      }
      return;
    }

    // -------------------------------------------------------------
    // MILESTONE 6: Resource Gathering & Survival (Coal, Iron, Shelter)
    // -------------------------------------------------------------
    this.currentMilestone = 6;
    this.logger.info(`✨ [Milestone 6: Advanced Survival] Initial core milestones complete!`);
    this.logger.info(`[Full Inventory Status] ${formatInventory(this.bot)}`);

    // Look for coal ore or iron ore within 48 blocks
    const coal = countResourceInInventory(this.bot, 'coal');
    const iron = countResourceInInventory(this.bot, 'iron');

    if (coal < 4) {
      this.logger.info(`Scanning for coal ore...`);
      const coalRes = await techniqueCollectResource(this.bot, 'coal', 4 - coal, this.abortController.signal);
      if (coalRes.status === 'success') {
        this.logger.info(`Mined coal successfully! Current coal: ${countResourceInInventory(this.bot, 'coal')}`);
      }
    }

    if (iron < 3) {
      this.logger.info(`Scanning for iron ore...`);
      const ironRes = await techniqueCollectResource(this.bot, 'iron', 3 - iron, this.abortController.signal);
      if (ironRes.status === 'success') {
        this.logger.info(`Mined iron successfully! Current iron: ${countResourceInInventory(this.bot, 'iron')}`);
      }
    }

    // Check time of day; if night (time > 13000), build shelter
    const timeOfDay = (this.bot as any).time?.timeOfDay ?? 0;
    if (timeOfDay > 13000 && timeOfDay < 23000) {
      this.logger.info(`Night falls (time: ${timeOfDay}). Constructing emergency survival shelter...`);
      this.bot.chat('Night detected. Building survival shelter...');
      await techniqueBuildShelter(this.bot, this.abortController.signal);
    } else {
      this.logger.info(`Daytime survival routine active (time: ${timeOfDay}). Gathering surplus wood and stone.`);
      if (logs < 8) {
        await techniqueChopTreeFull(this.bot, 48, this.abortController.signal);
      } else if (cobble < 16) {
        await techniqueCollectResource(this.bot, 'stone', 4, this.abortController.signal);
      } else {
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  }

  /**
   * Explores safely onto dry land, avoiding water hazards.
   */
  private async exploreSafely(): Promise<void> {
    updatePathfinderMovements(this.bot);
    const botPos = this.bot.entity.position;
    const directions = [
      { dx: 16, dz: 0 },
      { dx: -16, dz: 0 },
      { dx: 0, dz: 16 },
      { dx: 0, dz: -16 },
    ];

    for (const dir of directions) {
      const candidateX = botPos.x + dir.dx;
      const candidateZ = botPos.z + dir.dz;

      // Check if target candidate ground is water
      const blockAtTarget = this.bot.blockAt(new (botPos.constructor as any)(candidateX, botPos.y, candidateZ));
      if (blockAtTarget && (blockAtTarget.name === 'water' || blockAtTarget.name === 'flowing_water')) {
        continue;
      }

      try {
        const goal = new goals.GoalNearXZ(candidateX, candidateZ, 2.0);
        await (this.bot as any).pathfinder.goto(goal);
        return;
      } catch {
        continue;
      }
    }
  }

  public stop(): void {
    this.abortController.abort();
    try {
      (this.bot as any).pathfinder?.stop();
      this.bot.clearControlStates();
    } catch {}
  }
}

async function main() {
  console.log('===========================================================');
  console.log('     Minecraft 1.21.6 Autonomous Survival Pipeline         ');
  console.log('  (Voyager & Mindcraft Real-Time Anti-Drowning & Macros)   ');
  console.log('===========================================================');

  const config = loadConfig();
  const logger = new AgentLogger(config);
  const connection = new ConnectionManager(config, logger);

  let pipeline: SurvivalAutomationPipeline | null = null;

  const handleShutdown = () => {
    logger.info('Shutting down automation pipeline cleanly...');
    if (pipeline) pipeline.stop();
    connection.disconnect();
    setTimeout(() => process.exit(0), 1000);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    await connection.connect({
      onSpawn: (connectedBot) => {
        logger.info(
          `Bot spawned at ${connectedBot.entity.position.x.toFixed(1)}, ${connectedBot.entity.position.y.toFixed(1)}, ${connectedBot.entity.position.z.toFixed(1)}`
        );

        if (!pipeline) {
          pipeline = new SurvivalAutomationPipeline(connectedBot, logger);
          pipeline.run().catch((err) => {
            logger.error(`Pipeline stopped: ${err.message}`);
          });
        }
      },
    });
  } catch (err: any) {
    logger.error(`Failed to connect to Minecraft server: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Fatal automation runner error:', err);
  process.exit(1);
});
