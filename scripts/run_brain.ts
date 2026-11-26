/**
 * Runs a task in plain words through the LLM decision loop on a fresh, judged world.
 *
 *   npm run brain -- brain_tasks/stone_pickaxe.json
 *   npm run brain -- brain_tasks/stone_pickaxe.json --seeds 20261109,7,42 --repeat 3
 *
 * Exit code: 0 if every run is PASS, 1 otherwise.
 */
import fs from 'fs';
import path from 'path';
import { loadBrainTask, runBrainTask } from '../src/harness/brain_runner.js';
import { BatchRunResult, formatBatchMarkdown, summarizeBatch } from '../src/harness/batch.js';
import { errorVerdict } from '../src/harness/judged_run.js';
import { logDir } from '../src/utils/paths.js';

async function loadRequirements() {
  try {
    const mod: any = await import('../src/brain/requirements.js');
    if (typeof mod.missingFor === 'function' && typeof mod.craftableNow === 'function') return { missingFor: mod.missingFor, craftableNow: mod.craftableNow };
  } catch {
    // Not built yet: the brief goes without the MISSING section.
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file || !fs.existsSync(file)) {
    console.log('Usage: npm run brain -- <task.json> [--seeds a,b,c] [--repeat n]');
    process.exit(2);
  }
  const spec = loadBrainTask(file);
  let seeds: Array<string | undefined> = [spec.seed];
  let repeat = 1;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--seeds') seeds = (args.shift() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--repeat') repeat = Math.max(1, parseInt(args.shift() ?? '1', 10));
    else throw new Error(`Unknown option ${flag}`);
  }
  const requirements = await loadRequirements();
  if (!requirements) console.log('[brain] requirements calculator not available; brief has no MISSING section');

  const results: (BatchRunResult & { calls?: number })[] = [];
  const total = seeds.length * repeat;
  let n = 0;
  for (const seed of seeds) {
    for (let i = 0; i < repeat; i++) {
      n++;
      if (total > 1) console.log(`[batch] run ${n}/${total} (seed ${seed ?? 'random'})`);
      try {
        const out = await runBrainTask({ ...spec, seed }, { requirements });
        results.push({ runId: out.runId, seed, verdict: out.verdict, calls: out.brain?.calls });
      } catch (err) {
        console.error(`[batch] run ${n} threw: ${(err as Error).message}`);
        results.push({ runId: `error_${n}`, seed, verdict: errorVerdict((err as Error).message) });
      }
    }
  }
  if (total > 1) {
    const summary = summarizeBatch(results);
    const calls = results.map((r) => r.calls ?? 0).sort((a, b) => a - b);
    const median = calls.length ? calls[Math.floor((calls.length - 1) / 2)] : 0;
    const md = `${formatBatchMarkdown(summary, `brain ${spec.id}`)}\nLLM calls per run: ${calls.join(', ')} (median ${median})\n`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
    const dir = path.resolve(logDir('runs', `batch_${stamp}_brain_${spec.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ taskId: spec.id, ...summary, calls }, null, 2));
    fs.writeFileSync(path.join(dir, 'summary.md'), md);
    console.log(`\n${md}\n[batch] summary written to ${dir}`);
  }
  process.exit(results.every((r) => r.verdict.status === 'PASS') ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
