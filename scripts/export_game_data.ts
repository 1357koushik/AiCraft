/**
 * Exports the game's own data (recipes, loot tables, tags, registries, ...) from server/server.jar
 * with the vanilla data generator and writes a compact copy into data/vanilla/<version>/.
 *
 *   npx tsx scripts/export_game_data.ts [--jar server/server.jar] [--version 1.21.6]
 *
 * Needs Java 21+ (HARNESS_JAVA or `java`). The jar is not started as a server.
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { javaMajorVersion } from '../src/harness/server.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_FOLDER_BYTES = 20 * 1024 * 1024;
const BLOCKS_FULL_LIMIT = 5 * 1024 * 1024;

class ExportError extends Error {}

/** Throws (instead of exiting) so the temp dir is always cleaned up. */
function fail(message: string): never {
  throw new ExportError(message);
}

/** Reads one entry from a zip/jar without extra tools (central directory + inflate). */
function readZipEntry(zipPath: string, name: string): string | undefined {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < entries && buf.readUInt32LE(pos) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const entryName = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (entryName === name) {
      const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function walkJson(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

/** Collects every json file under root into { "<relative/path/without/.json>": contents }. */
function collect(root: string, skip?: (rel: string) => boolean): Record<string, any> {
  const out: Record<string, any> = {};
  for (const file of walkJson(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/').replace(/\.json$/, '');
    if (skip && skip(rel)) continue;
    out[rel] = readJson(file);
  }
  return sortKeys(out);
}

function main(): void {
  const jarPath = path.resolve(REPO_ROOT, argValue('--jar') ?? 'server/server.jar');
  if (!fs.existsSync(jarPath)) fail(`server jar not found at ${jarPath}`);

  const java = process.env.HARNESS_JAVA || 'java';
  let javaMajor = 0;
  try {
    javaMajor = javaMajorVersion(java);
  } catch (e: any) {
    fail(`java not found or not runnable ("${java}"): ${e.message}. Install Java 21+ or set HARNESS_JAVA.`);
  }
  if (javaMajor < 21) fail(`Java 21+ is required, but "${java}" is Java ${javaMajor}. Set HARNESS_JAVA to a newer java.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-datagen-'));
  try {
    console.log(`Running the data generator (Java ${javaMajor}) into ${tmp} ...`);
    const run = spawnSync(
      java,
      ['-DbundlerMainClass=net.minecraft.data.Main', '-jar', jarPath, '--reports', '--server', '--output', tmp],
      { encoding: 'utf8', cwd: tmp, maxBuffer: 256 * 1024 * 1024 }
    );
    if (run.error) fail(`could not run java: ${run.error.message}`);
    if (run.status !== 0) {
      fail(`data generator exited with ${run.status}\n${(run.stderr || '').slice(-2000)}${(run.stdout || '').slice(-2000)}`);
    }
    const reports = path.join(tmp, 'reports');
    const data = path.join(tmp, 'data', 'minecraft');
    for (const need of [path.join(reports, 'blocks.json'), path.join(data, 'recipe'), path.join(data, 'loot_table')]) {
      if (!fs.existsSync(need)) fail(`export finished but ${need} is missing`);
    }

    // Version info comes from version.json at the top level of the jar.
    const versionJson: any = JSON.parse(readZipEntry(jarPath, 'version.json') ?? '{}');
    const version: string | undefined = argValue('--version') ?? versionJson.id ?? versionJson.name;
    if (!version) fail('could not read the game version from the jar; pass --version <x.y.z>');

    const files: Record<string, any> = {};
    files['recipes.json'] = collect(path.join(data, 'recipe'));
    files['loot_tables.json'] = collect(path.join(data, 'loot_table'));
    files['tags.json'] = collect(path.join(data, 'tags'));
    files['advancements.json'] = collect(path.join(data, 'advancement'), (rel) => rel.startsWith('recipes/'));
    files['enchantments.json'] = collect(path.join(data, 'enchantment'));
    files['structures.json'] = collect(path.join(data, 'worldgen', 'structure'));
    files['damage_types.json'] = collect(path.join(data, 'damage_type'));
    files['items.json'] = sortKeys(readJson(path.join(reports, 'items.json')));

    const blocksText = fs.readFileSync(path.join(reports, 'blocks.json'), 'utf8');
    let blocksTrimmed = false;
    let blocks = sortKeys(JSON.parse(blocksText));
    if (Buffer.byteLength(blocksText) > BLOCKS_FULL_LIMIT) {
      blocksTrimmed = true;
      const slim: Record<string, any> = {};
      for (const [name, block] of Object.entries<any>(blocks)) {
        const entry: any = {};
        if (block.properties) entry.properties = block.properties;
        entry.states = (block.states ?? []).map((s: any) => {
          const st: any = { id: s.id };
          if (s.properties) st.properties = s.properties;
          if (s.default) st.default = true;
          return st;
        });
        slim[name] = entry;
      }
      blocks = slim;
    }
    files['blocks.json'] = blocks;

    const registries: Record<string, Record<string, number>> = {};
    for (const [reg, body] of Object.entries<any>(readJson(path.join(reports, 'registries.json')))) {
      const m: Record<string, number> = {};
      for (const [name, e] of Object.entries<any>(body.entries ?? {})) m[name] = e.protocol_id;
      registries[reg] = m;
    }
    files['registries.json'] = sortKeys(registries);

    const counts: Record<string, number> = {};
    for (const [name, content] of Object.entries(files)) counts[name.replace(/\.json$/, '')] = Object.keys(content).length;
    counts.registry_entries = Object.values(registries).reduce((n, r) => n + Object.keys(r).length, 0);
    counts.block_states = Object.values<any>(files['blocks.json']).reduce((n, b) => n + (b.states?.length ?? 0), 0);

    const meta = {
      game_version: version,
      data_version: versionJson.world_version ?? null,
      protocol_version: versionJson.protocol_version ?? null,
      data_pack_version: versionJson.pack_version?.data ?? null,
      server_jar_sha256: crypto.createHash('sha256').update(fs.readFileSync(jarPath)).digest('hex'),
      exported_at: new Date().toISOString(),
      java_major_version: javaMajor,
      blocks_trimmed: blocksTrimmed,
      counts,
    };

    const serialize = (pretty: boolean): Record<string, string> =>
      Object.fromEntries(
        Object.entries({ ...files, 'meta.json': meta }).map(([n, c]) => [n, JSON.stringify(c, null, pretty ? 2 : undefined) + '\n'])
      );
    const sizeOf = (o: Record<string, string>) => Object.values(o).reduce((n, s) => n + Buffer.byteLength(s), 0);
    let out = serialize(true);
    let pretty = true;
    if (sizeOf(out) > MAX_FOLDER_BYTES) {
      out = serialize(false);
      pretty = false;
    }
    const total = sizeOf(out);

    const outDir = path.join(REPO_ROOT, 'data', 'vanilla', version);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, text] of Object.entries(out)) fs.writeFileSync(path.join(outDir, name), text);

    console.log(`Wrote ${outDir} (${pretty ? 'pretty' : 'minified'} JSON, ${(total / 1048576).toFixed(2)} MB total)`);
    for (const [name, text] of Object.entries(out)) {
      const key = name.replace(/\.json$/, '');
      console.log(`  ${name.padEnd(20)} ${(Buffer.byteLength(text) / 1024).toFixed(0).padStart(7)} KB  ${key in counts ? counts[key] : ''}`);
    }
    if (blocksTrimmed) console.log('  blocks.json trimmed to per-block properties + states {id, properties, default}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e: any) {
  console.error(`export_game_data: ${e instanceof ExportError ? e.message : e?.stack ?? e}`);
  process.exit(1);
}
