import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { FixtureOperator } from './types.js';

export const FIXTURE_COMMAND_ALLOWLIST = new Set([
  'setblock',
  'fill',
  'give',
  'clear',
  'tp',
  'teleport',
  'kill',
  'summon',
  'weather',
  'time',
  'gamemode',
  'effect',
  'experience',
  'xp',
  'execute',
]);

export class DisposableFixtureManager implements FixtureOperator {
  private operatorBot: Bot;
  private logger?: any;

  constructor(operatorBot: Bot, logger?: any) {
    this.operatorBot = operatorBot;
    this.logger = logger;
  }

  public async executeCommand(command: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = command.startsWith('/') ? command.slice(1).trim() : command.trim();
    const verb = trimmed.split(/\s+/)[0]?.toLowerCase();

    if (!verb || !FIXTURE_COMMAND_ALLOWLIST.has(verb)) {
      const err = `Command '${verb}' is not permitted by test fixture allowlist.`;
      this.logger?.warn?.(`[FixtureManager] ${err}`);
      return { ok: false, error: err };
    }

    try {
      this.operatorBot.chat(`/${trimmed}`);
      // Short delay to allow server processing
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true };
    } catch (err: any) {
      this.logger?.error?.(`[FixtureManager] Failed executing /${trimmed}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  public async setBlock(pos: Vec3, blockName: string): Promise<boolean> {
    const res = await this.executeCommand(`setblock ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)} ${blockName}`);
    return res.ok;
  }

  public async fillBlocks(from: Vec3, to: Vec3, blockName: string): Promise<boolean> {
    const res = await this.executeCommand(
      `fill ${Math.floor(from.x)} ${Math.floor(from.y)} ${Math.floor(from.z)} ${Math.floor(to.x)} ${Math.floor(to.y)} ${Math.floor(to.z)} ${blockName}`
    );
    return res.ok;
  }

  public async giveItem(player: string, item: string, count: number = 1): Promise<boolean> {
    const res = await this.executeCommand(`give ${player} ${item} ${count}`);
    return res.ok;
  }

  public async clearInventory(player: string): Promise<boolean> {
    const res = await this.executeCommand(`clear ${player}`);
    return res.ok;
  }

  public async teleport(player: string, pos: Vec3): Promise<boolean> {
    const res = await this.executeCommand(`tp ${player} ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}`);
    return res.ok;
  }

  public async prepareSandboxPlatform(center: Vec3, radius: number = 5): Promise<boolean> {
    const from = center.offset(-radius, -1, -radius);
    const to = center.offset(radius, -1, radius);
    const airFrom = center.offset(-radius, 0, -radius);
    const airTo = center.offset(radius, 4, radius);

    await this.fillBlocks(from, to, 'smooth_stone');
    await this.fillBlocks(airFrom, airTo, 'air');
    await this.executeCommand('time set day');
    await this.executeCommand('weather clear');
    return true;
  }
}
