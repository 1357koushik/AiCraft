/**
 * Runs a hand-written step plan with a bare bot (no agent, no LLM) on a fresh, judged world.
 *
 *   npm run plan -- plans/stone_pickaxe.json
 *   npm run plan -- plans/stone_pickaxe.json --seeds 20261109,7,42 --repeat 3
 *
 * Exit code: 0 if every run is PASS, 1 otherwise.
 */
import fs from 'fs';
import path from 'path';
import { loadPlanFile, runPlanSpec } from '../src/harness/plan_runner.js';
import { BatchRunResult, formatBatchMarkdown, summarizeBatch } from '../src/harness/batch.js';
import type { Verdict } from '../src/oracle/session.js';
import { logDir } from '../src/utils/paths.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file || !fs.existsSync(file)) {
    console.log('Usage: npm run plan -- <plan.json> [--seeds a,b,c] [--repeat n]');
    process.exit(2);
  }
  const spec = loadPlanFile(file);
  let seeds: Array<string | undefined> = [spec.seed];
  let repeat = 1;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--seeds') seeds = (args.shift() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--repeat') repeat = Math.max(1, parseInt(args.shift() ?? '1', 10));
    else throw new Error(`Unknown option ${flag}`);
  }

  const results: BatchRunResult[] = [];
  const total = seeds.length * repeat;
  let n = 0;
  for (const seed of seeds) {
    for (let i = 0; i < repeat; i++) {
      n++;
      if (total > 1) console.log(`[batch] run ${n}/${total} (seed ${seed ?? 'random'})`);
      try {
        const out = await runPlanSpec({ ...spec, seed });
        results.push({ runId: out.runId, seed, verdict: out.verdict });
      } catch (err) {
        const now = new Date().toISOString();
        const verdict: Verdict = { status: 'ERROR', reason: (err as Error).message, checks: [], assists: [], deaths: 0, deathMessages: [], discrepancies: [], startedAt: now, endedAt: now, durationSec: 0, finalSnapshot: null };
        console.error(`[batch] run ${n} threw: ${(err as Error).message}`);
        results.push({ runId: `error_${n}`, seed, verdict });
      }
    }
  }

  if (total > 1) {
    const summary = summarizeBatch(results);
    const md = formatBatchMarkdown(summary, `plan ${spec.id}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
    const dir = path.resolve(logDir('runs', `batch_${stamp}_plan_${spec.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ planId: spec.id, ...summary }, null, 2));
    fs.writeFileSync(path.join(dir, 'summary.md'), md);
    console.log(`\n${md}\n[batch] summary written to ${dir}`);
  }
  process.exit(results.every((r) => r.verdict.status === 'PASS') ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
