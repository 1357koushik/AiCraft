import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PlacesMemory, kindOf, normalizeName } from '../src/memory/places.js';
import { resolveTarget, searchWaypoints, compass } from '../src/skills/explore_for.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'places-')), 'places.json');

describe('PlacesMemory', () => {
  it('names are case, article and separator insensitive', () => {
    expect(normalizeName('The Furnace')).toBe('furnace');
    expect(normalizeName('my_base')).toBe('base');
    const p = new PlacesMemory();
    p.setNamed('Base', { x: 1.9, y: 64, z: -3.2 });
    expect(p.getNamed('the base')).toMatchObject({ name: 'base', x: 1, y: 64, z: -4 });
    expect(p.getNamed('nowhere')).toBeNull();
  });

  it('overwriting a name reports the old position', () => {
    const p = new PlacesMemory();
    p.setNamed('base', { x: 0, y: 64, z: 0 });
    expect(p.setNamed('base', { x: 10, y: 64, z: 0 }).replaced).toMatchObject({ x: 0 });
    expect(p.listNamed()).toHaveLength(1);
  });

  it('merges nearby sightings and keeps the newest', () => {
    let t = 1;
    const p = new PlacesMemory(undefined, { now: () => t++ });
    expect(p.see('sand', { x: 0, y: 63, z: 0 })).toBe(true);
    expect(p.see('sand', { x: 3, y: 63, z: 0 })).toBe(false);
    expect(p.known('sand')).toHaveLength(1);
    expect(p.known('sand')[0]).toMatchObject({ x: 3, t: 2 });
  });

  it('stays bounded per kind and drops the stalest', () => {
    let t = 0;
    const p = new PlacesMemory(undefined, { maxPerKind: 3, now: () => ++t });
    for (let i = 0; i < 6; i++) p.see('iron_ore', { x: i * 100, y: 20, z: 0 });
    const xs = p.known('iron_ore').map((s) => s.x).sort((a, b) => a - b);
    expect(xs).toEqual([300, 400, 500]);
  });

  it('orders by distance from a point, recent first without one', () => {
    let t = 0;
    const p = new PlacesMemory(undefined, { now: () => ++t });
    p.see('water', { x: 100, y: 62, z: 0 });
    p.see('water', { x: 30, y: 62, z: 0 });
    p.see('water', { x: -60, y: 62, z: 0 });
    expect(p.nearest('water', { x: 0, y: 64, z: 0 })!.x).toBe(30);
    expect(p.known('water').map((s) => s.x)).toEqual([-60, 30, 100]);
  });

  it('forget removes one sighting and empties the kind', () => {
    const p = new PlacesMemory();
    p.see('lava', { x: 5, y: 10, z: 5 });
    p.forget('lava', { x: 5, y: 10, z: 5 });
    expect(p.kinds()).toEqual([]);
  });

  it('keeps structures apart from resources', () => {
    const p = new PlacesMemory();
    p.see('village', { x: 200, y: 70, z: 200 }, 'bell', true);
    expect(p.known('village')).toHaveLength(0);
    expect(p.known('village', undefined, true)).toHaveLength(1);
  });

  it('survives a save and a reload, and a damaged file starts empty', () => {
    const file = tmp();
    const p = new PlacesMemory(file);
    p.setNamed('base', { x: 4, y: 70, z: 9 });
    p.see('diamond_ore', { x: 10, y: -50, z: 10 }, 'deepslate_diamond_ore');
    p.save();
    const q = new PlacesMemory(file);
    expect(q.getNamed('base')).toMatchObject({ x: 4, y: 70, z: 9 });
    expect(q.known('diamond_ore')[0].block).toBe('deepslate_diamond_ore');
    fs.writeFileSync(file, '{ not json');
    expect(new PlacesMemory(file).listNamed()).toEqual([]);
  });

  it('summary lists named places first, hides what is near, groups logs and caps the lines', () => {
    const p = new PlacesMemory();
    p.setNamed('base', { x: 0, y: 64, z: 0 });
    p.see('diamond_ore', { x: 500, y: -50, z: 0 });
    p.see('sand', { x: 10, y: 63, z: 0 }); // near: hidden
    p.see('oak_log', { x: 100, y: 70, z: 0 });
    p.see('birch_log', { x: 60, y: 70, z: 0 });
    p.see('village', { x: 300, y: 70, z: 0 }, 'bell', true);
    const lines = p.summary({ x: 0, y: 64, z: 0 }, 6, 32, (k) => (k.endsWith('_log') ? 'logs' : k));
    expect(lines[0]).toMatch(/^base: 0 64 0/);
    expect(lines.some((l) => l.startsWith('sand'))).toBe(false);
    expect(lines.filter((l) => l.startsWith('logs'))).toEqual([expect.stringContaining('60 70 0')]);
    expect(lines.some((l) => l.startsWith('village (structure)'))).toBe(true);
    expect(p.summary({ x: 0, y: 64, z: 0 }, 2)).toHaveLength(2);
  });
});

describe('kindOf', () => {
  it('folds deepslate ores into the plain ore', () => {
    expect(kindOf('deepslate_iron_ore')).toBe('iron_ore');
    expect(kindOf('deepslate')).toBe('deepslate');
    expect(kindOf('oak_log')).toBe('oak_log');
  });
});

describe('explore_for pure parts', () => {
  const blocks = ['sand', 'iron_ore', 'deepslate_iron_ore', 'oak_log', 'birch_log', 'stripped_oak_log', 'bell', 'lectern', 'stone', 'diamond_ore', 'deepslate_diamond_ore'];
  it('resolves blocks, ore words, logs and villages', () => {
    expect(resolveTarget(blocks, 'sand')).toEqual({ label: 'sand', names: ['sand'] });
    expect(resolveTarget(blocks, 'iron_ore')!.names).toEqual(['iron_ore', 'deepslate_iron_ore']);
    expect(resolveTarget(blocks, 'diamond')!.label).toBe('diamond_ore');
    expect(resolveTarget(blocks, 'raw_iron')!.label).toBe('iron_ore');
    expect(resolveTarget(blocks, 'logs')!.names).toEqual(['oak_log', 'birch_log']);
    expect(resolveTarget(blocks, 'oak_log')!.names).toEqual(['oak_log']);
    expect(resolveTarget(blocks, 'village')).toMatchObject({ label: 'village', structure: true, names: ['bell', 'lectern'] });
    expect(resolveTarget(blocks, 'unicorn')).toBeNull();
  });

  it('a directional search goes straight out and ends at maxDistance', () => {
    expect(searchWaypoints(200, 'north', 80)).toEqual([{ dx: 0, dz: -80 }, { dx: 0, dz: -160 }, { dx: 0, dz: -200 }]);
    expect(searchWaypoints(100, 'east', 80)[1]).toEqual({ dx: 100, dz: 0 });
  });

  it('the spiral visits every cell of each ring once and respects the limit', () => {
    const w = searchWaypoints(160, undefined, 80); // rings 1 and 2: 8 + 16 cells
    expect(w).toHaveLength(24);
    expect(new Set(w.map((p) => `${p.dx},${p.dz}`)).size).toBe(24);
    expect(Math.max(...w.map((p) => Math.max(Math.abs(p.dx), Math.abs(p.dz))))).toBe(160);
    expect(w[0]).toEqual({ dx: 80, dz: 0 });
    expect(searchWaypoints(16, undefined, 80).length).toBeGreaterThan(0);
  });

  it('compass names headings', () => {
    expect(compass(10, 0)).toBe('east');
    expect(compass(0, -10)).toBe('north');
    expect(compass(-10, 10)).toBe('south-west');
  });
});
