/**
 * Runs the real agent on one task and judges it with server-side evidence only.
 *
 *   npm run task -- tasks/stone_pickaxe.json
 *   npm run task -- "craft a wooden pickaxe" --seed 42 --timeout 5m --expect-item "wooden_pickaxe>=1"
 *   (quote comparisons: an unquoted > is a shell redirect)
 *
 *   npm run task -- tasks/wooden_pickaxe.json --repeat 5 --seeds 1,2,3
 *
 * Exit code (single run): 0 PASS · 1 FAIL / ASSISTED / UNVERIFIED · 2 ERROR
 * Exit code (batch, more than one run): 0 if every run is PASS, else 1
 */
import fs from 'fs';
import path from 'path';
import { loadTaskFile, runTask, TaskSpec } from '../src/harness/task_runner.js';
import { TaskExpectations } from '../src/oracle/expect.js';
import { BatchRunResult, formatBatchMarkdown, summarizeBatch } from '../src/harness/batch.js';
import type { Verdict } from '../src/oracle/session.js';
import { logDir } from '../src/utils/paths.js';

function usage(): never {
  console.log(`Usage:
  npm run task -- <task.json | "task text"> [options]

Options:
  --seed <seed>                  World seed (default: task file, else random)
  --seeds <a,b,c>                Run every listed seed (replaces --seed; task file is not changed)
  --repeat <n>                   Run each seed n times, sequentially (default 1); writes a batch summary
  --timeout <sec|Nm|Nh>          Time limit (default: task file, else 10m)
  --id <name>                    Task id used in the run folder name
  --expect-item "<id><op><n>"      e.g. "stone_pickaxe>=1" (repeatable; keep the quotes)
  --expect-advancement <id>        e.g. story/upgrade_tools (repeatable)
  --expect-stat "<type:id><op><n>" e.g. "crafted:stone_pickaxe>=1" (repeatable)
  --expect-dimension <id>        e.g. the_nether
  --max-deaths <n>
  --difficulty <peaceful|easy|normal|hard>
  --keep-server                  Leave the server running after the verdict`);
  process.exit(2);
}

function parseDuration(text: string): number {
  const match = text.match(/^(\d+)(s|m|h)?$/);
  if (!match) throw new Error(`Invalid duration "${text}"`);
  const n = parseInt(match[1], 10);
  return match[2] === 'h' ? n * 3600 : match[2] === 'm' ? n * 60 : n;
}

function errorVerdict(message: string): Verdict {
  const now = new Date().toISOString();
  return {
    status: 'ERROR',
    reason: message,
    checks: [],
    assists: [],
    deaths: 0,
    deathMessages: [],
    discrepancies: [],
    startedAt: now,
    endedAt: now,
    durationSec: 0,
    finalSnapshot: null,
  };
}

function splitComparison(text: string): [string, string] {
  const match = text.match(/^([^<>=]+)((?:>=|<=|==|=|>|<).+)$/);
  if (!match) throw new Error(`Expected <name><op><number>, got "${text}"`);
  return [match[1].trim(), match[2].trim()];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) usage();

  const target = args.shift()!;
  const spec: TaskSpec =
    target.endsWith('.json') && fs.existsSync(target)
      ? loadTaskFile(target)
      : { id: 'adhoc', text: target, timeoutSec: 600, expect: {} };
  const expect: TaskExpectations = spec.expect ?? {};
  let keepServer = false;
  let repeat = 1;
  let seeds: string[] | undefined;

  while (args.length) {
    const flag = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--seed':
        spec.seed = value();
        break;
      case '--seeds':
        seeds = value()
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        if (seeds.length === 0) throw new Error('--seeds needs at least one seed');
        break;
      case '--repeat':
        repeat = parseInt(value(), 10);
        if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
        break;
      case '--timeout':
        spec.timeoutSec = parseDuration(value());
        break;
      case '--id':
        spec.id = value();
        break;
      case '--expect-item': {
        const [item, cmp] = splitComparison(value());
        expect.inventory = { ...(expect.inventory ?? {}), [item]: cmp };
        break;
      }
      case '--expect-advancement':
        expect.advancements = [...(expect.advancements ?? []), value()];
        break;
      case '--expect-stat': {
        const [stat, cmp] = splitComparison(value());
        expect.stats = { ...(expect.stats ?? {}), [stat]: cmp };
        break;
      }
      case '--expect-dimension':
        expect.dimension = value();
        break;
      case '--max-deaths':
        expect.maxDeaths = parseInt(value(), 10);
        break;
      case '--difficulty':
        spec.properties = { ...(spec.properties ?? {}), difficulty: value() };
        break;
      case '--keep-server':
        keepServer = true;
        break;
      default:
        console.error(`Unknown option ${flag}`);
        usage();
    }
  }
  spec.expect = expect;

  const seedList: Array<string | undefined> = seeds ?? [spec.seed];
  if (seedList.length * repeat === 1) {
    const { verdict } = await runTask({ ...spec, seed: seedList[0] }, { keepServer });
    process.exit(verdict.status === 'PASS' ? 0 : verdict.status === 'ERROR' ? 2 : 1);
  }

  // Batch: one server at a time; a run that throws is recorded as ERROR and the batch continues.
  const total = seedList.length * repeat;
  const results: BatchRunResult[] = [];
  let index = 0;
  for (const seed of seedList) {
    for (let i = 1; i <= repeat; i++) {
      index++;
      console.log(`[batch] run ${index}/${total} (seed ${seed ?? 'random'}, repeat ${i}/${repeat})`);
      try {
        const run = await runTask({ ...spec, seed }, { keepServer: keepServer && index === total });
        results.push({ runId: run.runId, seed, verdict: run.verdict });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[batch] run ${index}/${total} threw: ${message}`);
        results.push({ runId: `error_${index}`, seed, verdict: errorVerdict(`runTask threw: ${message}`) });
      }
    }
  }

  const summary = summarizeBatch(results);
  const markdown = formatBatchMarkdown(summary, spec.id);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  const batchDir = path.resolve(logDir('runs', `batch_${stamp}_${spec.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`));
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify({ taskId: spec.id, ...summary }, null, 2));
  fs.writeFileSync(path.join(batchDir, 'summary.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`[batch] summary written to ${batchDir}`);
  process.exit(summary.overall.PASS === summary.overall.runs ? 0 : 1);
}

main().catch((err) => {
  console.error(`[harness] fatal: ${err.message}`);
  process.exit(2);
});
