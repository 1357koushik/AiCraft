/**
 * Runs a companion task: the scripted owner gives tasks in chat; the companion hears, queues and runs them;
 * the server judges the world, and the server's chat log judges what the bot said.
 *
 *   npm run companion:test -- companion_tasks/chat_queue.json [--seeds a,b,c] [--repeat n]
 */
import fs from 'fs';
import path from 'path';
import { loadCompanionSpec, runCompanionSpec } from '../src/harness/companion_runner.js';
import { BatchRunResult, formatBatchMarkdown, summarizeBatch } from '../src/harness/batch.js';
import { errorVerdict } from '../src/harness/judged_run.js';
import { logDir } from '../src/utils/paths.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file || !fs.existsSync(file)) {
    console.log('Usage: npm run companion:test -- <companion_task.json> [--seeds a,b,c] [--repeat n]');
    process.exit(2);
  }
  const spec = loadCompanionSpec(file);
  let seeds: Array<string | undefined> = [spec.seed];
  let repeat = 1;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--seeds') seeds = (args.shift() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--repeat') repeat = Math.max(1, parseInt(args.shift() ?? '1', 10));
    else throw new Error(`Unknown option ${flag}`);
  }
  let requirements: any;
  try {
    const mod: any = await import('../src/brain/requirements.js');
    requirements = { missingFor: mod.missingFor, craftableNow: mod.craftableNow };
  } catch {
    requirements = undefined;
  }
  const results: BatchRunResult[] = [];
  for (const seed of seeds) {
    for (let i = 0; i < repeat; i++) {
      try {
        const out = await runCompanionSpec({ ...spec, seed }, { requirements });
        results.push({ runId: out.runId, seed, verdict: out.verdict });
        console.log(`[companion] ${out.verdict.status}: ${out.verdict.reason} (${out.runId})`);
      } catch (err) {
        console.error(`[companion] run threw: ${(err as Error).message}`);
        results.push({ runId: 'error', seed, verdict: errorVerdict((err as Error).message) });
      }
    }
  }
  if (results.length > 1) {
    const md = formatBatchMarkdown(summarizeBatch(results), `companion ${spec.id}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
    const dir = path.resolve(logDir('runs', `batch_${stamp}_companion_${spec.id}`));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.md'), md);
    console.log(`\n${md}`);
  }
  process.exit(results.every((r) => r.verdict.status === 'PASS') ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
