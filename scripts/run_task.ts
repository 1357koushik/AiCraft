/**
 * Runs the real agent on one task and judges it with server-side evidence only.
 *
 *   npm run task -- tasks/stone_pickaxe.json
 *   npm run task -- "craft a wooden pickaxe" --seed 42 --timeout 5m --expect-item "wooden_pickaxe>=1"
 *   (quote comparisons: an unquoted > is a shell redirect)
 *
 * Exit code: 0 PASS · 1 FAIL / ASSISTED / UNVERIFIED · 2 ERROR
 */
import fs from 'fs';
import { loadTaskFile, runTask, TaskSpec } from '../src/harness/task_runner.js';
import { TaskExpectations } from '../src/oracle/expect.js';

function usage(): never {
  console.log(`Usage:
  npm run task -- <task.json | "task text"> [options]

Options:
  --seed <seed>                  World seed (default: task file, else random)
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

  const { verdict } = await runTask(spec, { keepServer });
  process.exit(verdict.status === 'PASS' ? 0 : verdict.status === 'ERROR' ? 2 : 1);
}

main().catch((err) => {
  console.error(`[harness] fatal: ${err.message}`);
  process.exit(2);
});
