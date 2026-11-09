import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { encodePacket, decodePackets } from '../src/oracle/rcon.js';
import { parseSnbt, parseDataGetReply } from '../src/oracle/snbt.js';
import { offlinePlayerUuid, uuidFromIntArray, uuidFromIntArrayText } from '../src/oracle/uuid.js';
import { parseServerLogLine, isAssistingCommand } from '../src/oracle/log.js';
import { readStats, readAdvancements, diffStats, statCriterion } from '../src/oracle/files.js';
import { countItems } from '../src/oracle/probe.js';
import { parseComparison, compare, evaluateExpectations, validateExpectations, hasExpectations } from '../src/oracle/expect.js';
import { parseProperties, formatProperties } from '../src/harness/server.js';

// Inputs below are real replies and log lines captured from the vanilla 1.21.6 server on 2026-11-09.

describe('RCON packet framing', () => {
  it('round-trips packets and keeps a partial packet for the next read', () => {
    const a = encodePacket(7, 2, 'list');
    const b = encodePacket(8, 0, '');
    const joined = Buffer.concat([a, b.subarray(0, 5)]);
    const first = decodePackets(joined);
    expect(first.packets).toEqual([{ id: 7, type: 2, body: 'list' }]);
    expect(first.rest.length).toBe(5);
    const second = decodePackets(Buffer.concat([first.rest, b.subarray(5)]));
    expect(second.packets).toEqual([{ id: 8, type: 0, body: '' }]);
    expect(second.rest.length).toBe(0);
  });

  it('handles multi-byte UTF-8 bodies', () => {
    const { packets } = decodePackets(encodePacket(1, 0, 'Gave 1 [Stone Pickaxe] → ✓'));
    expect(packets[0].body).toBe('Gave 1 [Stone Pickaxe] → ✓');
  });
});

describe('SNBT parsing of data get replies', () => {
  it('parses an inventory list', () => {
    const reply =
      'dragonai has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:crafting_table"}, {count: 4, Slot: 1b, id: "minecraft:dirt"}]';
    expect(parseDataGetReply(reply)).toEqual([
      { count: 1, Slot: 0, id: 'minecraft:crafting_table' },
      { count: 4, Slot: 1, id: 'minecraft:dirt' },
    ]);
  });

  it('parses positions, strings, floats and item components', () => {
    expect(parseDataGetReply('dragonai has the following entity data: [6.5d, 68.0d, 44.5d]')).toEqual([6.5, 68, 44.5]);
    expect(parseDataGetReply('dragonai has the following entity data: "minecraft:overworld"')).toBe('minecraft:overworld');
    expect(parseDataGetReply('dragonai has the following entity data: 20.0f')).toBe(20);
    expect(parseSnbt('{components: {"minecraft:damage": 3}, count: 1, id: "minecraft:stone_pickaxe"}')).toEqual({
      components: { 'minecraft:damage': 3 },
      count: 1,
      id: 'minecraft:stone_pickaxe',
    });
  });

  it('parses typed arrays, negatives, booleans and escaped strings', () => {
    expect(parseSnbt('[I; 1119291960, -460115557, -1797042868, 1877887294]')).toEqual([1119291960, -460115557, -1797042868, 1877887294]);
    expect(parseSnbt('{a: true, b: -7, c: \'it\\\'s\', d: []}')).toEqual({ a: true, b: -7, c: "it's", d: [] });
  });

  it('returns null when the target does not exist and rejects garbage', () => {
    expect(parseDataGetReply('No entity was found')).toBeNull();
    expect(() => parseSnbt('{count 1}')).toThrow();
  });
});

describe('player UUIDs', () => {
  it('matches the offline UUIDs the server assigned', () => {
    expect(offlinePlayerUuid('dragonai')).toBe('42b70a38-e493-319b-94e3-4d4c6fee493e');
    expect(offlinePlayerUuid('1357koushik')).toBe('550a5e1c-5fd6-3f8f-a179-648805c1f772');
  });

  it('converts the NBT int-array form', () => {
    expect(uuidFromIntArray([1119291960, -460115557, -1797042868, 1877887294])).toBe('42b70a38-e493-319b-94e3-4d4c6fee493e');
    expect(uuidFromIntArrayText('[I;1119291960,-460115557,-1797042868,1877887294]')).toBe('42b70a38-e493-319b-94e3-4d4c6fee493e');
    expect(uuidFromIntArrayText('not a uuid')).toBeNull();
  });
});

describe('server log classification', () => {
  const players = ['dragonai', '1357koushik'];

  it('reads oracle events and maps the UUID', () => {
    const entry = parseServerLogLine(
      '[18:53:34] [Server thread/INFO]: [Not Secure] [Server] [oracle] {"ev":"death","uuid":"[I;1119291960,-460115557,-1797042868,1877887294]","dim":"minecraft:the_nether","x":0,"y":78,"z":0,"t":194}',
      players
    );
    expect(entry?.kind).toBe('oracle');
    if (entry?.kind !== 'oracle') return;
    expect(entry.event).toMatchObject({ ev: 'death', uuid: '42b70a38-e493-319b-94e3-4d4c6fee493e', dim: 'minecraft:the_nether', y: 78 });
  });

  it('reads the harness mark, which the server prints with an [Rcon] prefix', () => {
    const entry = parseServerLogLine('[19:43:51] [Server thread/INFO]: [Not Secure] [Rcon] [oracle] {"ev":"mark","label":"t0"}');
    expect(entry).toMatchObject({ kind: 'oracle', event: { ev: 'mark', label: 't0' } });
  });

  it('does not treat a player imitating the oracle as an oracle event', () => {
    const chat = parseServerLogLine('[19:50:00] [Server thread/INFO]: [Not Secure] <1357koushik> [Server] [oracle] {"ev":"mark","label":"t0"}');
    const say = parseServerLogLine('[19:50:01] [Server thread/INFO]: [Not Secure] [1357koushik] [oracle] {"ev":"death"}');
    expect(chat?.kind).toBe('chat');
    expect(say?.kind).not.toBe('oracle');
  });

  it('separates harness bookkeeping from commands that change the game', () => {
    const give = parseServerLogLine('[18:52:41] [Server thread/INFO]: [Rcon: Gave 1 [Crafting Table] to dragonai]');
    const save = parseServerLogLine('[18:52:48] [Server thread/INFO]: [Rcon: Saved the game]');
    const mark = parseServerLogLine('[18:54:58] [Server thread/INFO]: [Rcon: Running function bot_oracle:mark]');
    const playerCmd = parseServerLogLine('[19:01:02] [Server thread/INFO]: [1357koushik: Gave 64 [Diamond] to dragonai]');
    expect(give?.kind).toBe('command');
    expect(isAssistingCommand(give!)).toBe(true);
    expect(isAssistingCommand(save!)).toBe(false);
    expect(isAssistingCommand(mark!)).toBe(false);
    expect(isAssistingCommand(playerCmd!)).toBe(true);
  });

  it('classifies chat, joins, advancements and death messages', () => {
    expect(parseServerLogLine('[16:33:01] [Server thread/INFO]: [Not Secure] <1357koushik> get me some iron', players)).toMatchObject({
      kind: 'chat',
      player: '1357koushik',
      message: 'get me some iron',
    });
    expect(parseServerLogLine('[18:52:38] [Server thread/INFO]: dragonai joined the game', players)?.kind).toBe('join');
    expect(parseServerLogLine('[16:53:36] [Server thread/INFO]: dragonai has made the advancement [Getting an Upgrade]', players)).toMatchObject({
      kind: 'advancement',
      title: 'Getting an Upgrade',
    });
    expect(parseServerLogLine('[10:21:00] [Server thread/INFO]: dragonai was slain by Zombie', players)).toMatchObject({
      kind: 'player_message',
      text: 'was slain by Zombie',
    });
    expect(parseServerLogLine('[18:52:50] [Server thread/INFO]: dragonai lost connection: Disconnected', players)?.kind).toBe('other');
    expect(parseServerLogLine('not a log line')).toBeNull();
  });
});

describe('world files', () => {
  it('reads and diffs stats and advancements written by the server', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-world-'));
    const uuid = '42b70a38-e493-319b-94e3-4d4c6fee493e';
    fs.mkdirSync(path.join(world, 'stats'));
    fs.mkdirSync(path.join(world, 'advancements'));
    fs.writeFileSync(
      path.join(world, 'stats', `${uuid}.json`),
      JSON.stringify({ stats: { 'minecraft:mined': { 'minecraft:dirt': 1 }, 'minecraft:custom': { 'minecraft:deaths': 1 } }, DataVersion: 4435 })
    );
    fs.writeFileSync(
      path.join(world, 'advancements', `${uuid}.json`),
      JSON.stringify({
        'minecraft:story/root': { criteria: { crafting_table: '2026-11-09 18:52:41 +0530' }, done: true },
        'minecraft:adventure/adventuring_time': { criteria: { 'minecraft:swamp': '2026-11-09 18:52:39 +0530' }, done: false },
        DataVersion: 4435,
      })
    );
    const stats = readStats(world, uuid);
    expect(stats).toEqual({ 'mined:dirt': 1, 'custom:deaths': 1 });
    expect(diffStats({ 'mined:dirt': 1 }, { 'mined:dirt': 4, 'crafted:stick': 4 })).toEqual({ 'mined:dirt': 3, 'crafted:stick': 4 });
    const adv = readAdvancements(world, uuid);
    expect(adv['story/root'].done).toBe(true);
    expect(adv['adventure/adventuring_time'].done).toBe(false);
    expect(readStats(world, 'missing')).toEqual({});
    expect(statCriterion('crafted:stone_pickaxe')).toBe('minecraft.crafted:minecraft.stone_pickaxe');
  });
});

describe('item counting', () => {
  it('adds equipment (armor, offhand) to inventory counts', () => {
    const inventory = [
      { count: 1, Slot: 0, id: 'minecraft:stone_pickaxe' },
      { count: 3, Slot: 1, id: 'minecraft:dirt' },
      { count: 2, Slot: 2, id: 'minecraft:dirt' },
    ];
    const equipment = { head: { count: 1, id: 'minecraft:iron_helmet' }, offhand: { count: 1, id: 'minecraft:shield' } };
    expect(countItems(inventory, equipment)).toEqual({ stone_pickaxe: 1, dirt: 5, iron_helmet: 1, shield: 1 });
    expect(countItems(null, null)).toEqual({});
  });
});

describe('expectations', () => {
  it('parses comparisons', () => {
    expect(parseComparison('>=3')).toEqual({ op: '>=', value: 3 });
    expect(parseComparison('5')).toEqual({ op: '>=', value: 5 });
    expect(parseComparison('=1')).toEqual({ op: '==', value: 1 });
    expect(compare(2, parseComparison('<3'))).toBe(true);
    expect(() => parseComparison('lots')).toThrow();
  });

  it('evaluates every kind of check against evidence', () => {
    const results = evaluateExpectations(
      {
        inventory: { 'minecraft:stone_pickaxe': '>=1', cobblestone: '>=8' },
        advancements: ['minecraft:story/upgrade_tools'],
        stats: { 'crafted:stone_pickaxe': '>=1' },
        dimension: 'overworld',
        maxDeaths: 0,
      },
      {
        items: { stone_pickaxe: 1, cobblestone: 3 },
        advancements: new Set(['story/upgrade_tools']),
        statDeltas: { 'crafted:stone_pickaxe': 1 },
        dimension: 'minecraft:overworld',
        deaths: 1,
      },
      { stats: 'file', advancements: 'file' }
    );
    const byCheck = Object.fromEntries(results.map((r) => [r.check, r.ok]));
    expect(byCheck).toEqual({
      'inventory stone_pickaxe': true,
      'inventory cobblestone': false,
      'advancement story/upgrade_tools': true,
      'stat crafted:stone_pickaxe (increase)': true,
      dimension: true,
      deaths: false,
    });
  });

  it('rejects malformed task expectations before a run', () => {
    expect(() => validateExpectations({ stats: { 'stone pickaxe': '>=1' } })).toThrow();
    expect(() => validateExpectations({ inventory: { dirt: 'many' } })).toThrow();
    expect(hasExpectations({})).toBe(false);
    expect(hasExpectations({ advancements: ['story/root'] })).toBe(true);
  });
});

describe('server.properties handling', () => {
  it('round-trips properties and ignores comments', () => {
    const props = parseProperties('# comment\nlevel-name=run_1\nlevel-type=minecraft\\:normal\n\nmotd=a=b\n');
    expect(props).toEqual({ 'level-name': 'run_1', 'level-type': 'minecraft\\:normal', motd: 'a=b' });
    expect(parseProperties(formatProperties(props))).toEqual(props);
  });

  it('the kit template keeps the server ticking when empty and enables RCON', () => {
    const template = parseProperties(fs.readFileSync(path.join(process.cwd(), 'server-kit', 'properties', 'test.properties'), 'utf8'));
    expect(template['pause-when-empty-seconds']).toBe('0');
    expect(template['enable-rcon']).toBe('true');
    expect(template['online-mode']).toBe('false');
  });
});
