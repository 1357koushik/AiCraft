# Project Status

What has actually been shown to work, and how we know. Last reviewed **2026-11-27** against the code, tests and server-side evidence, not against earlier reports or commit titles.

## Labels
| Label | Meaning |
| --- | --- |
| **Server-judged** | Verdict from `npm run task`, using only server evidence: RCON, the `bot_oracle` datapack log, the server log, and the world's stats and advancement files |
| **Live** | Seen on the real server, but not judged by the harness |
| **Self-reported** | Live, but only the bot's own client confirmed it |
| **Unit only** | Exercised only against mocked bots |
| **Not connected** | Code exists, but nothing in the bot calls it |

## Progression

| Stage | Status | Evidence |
| --- | --- | --- |
| Connect / reconnect to the server | **Live** | Every harness run |
| Wood → wooden pickaxe | **Server-judged, part of every stone run below** | Each stone pickaxe run below crafted a wooden pickaxe first, unassisted |
| Wooden → stone pickaxe | **Server-judged PASS, 9 of 9 runs since the crafting fix** (seeds 20261109, 7, 42; 3 runs each) | Batches `logs/runs/batch_20261126_205330_stone_pickaxe` (6 of 6) and the next batch (3 of 3). Median 116 s, 0 deaths, 0 commands. No crafting errors in any run's log. Before the fix: 1 PASS, 1 FAIL on seed 20261109 (2026-11-09), and 2 PASS in traced runs on 2026-11-27, one of which shows the inventory drift in its trace. These runs still use the old agent loop (LLM fallback, hand-written goal plans); between 1 and 32 LLM calls per run |
| Iron, armor, food, diamonds, obsidian | **Unit only** | Code in `src/actions/` and `src/actions/mining/`, never run live |
| Nether, fortress, blaze, piglin, ender pearls | **Not connected** | `src/dimensions/nether/`, `src/actions/combat/{enderman,wither_skeleton}_tactics.ts`; see `src/dimensions/README.md` |
| Stronghold, End, Ender Dragon | **Not connected** | `src/dimensions/stronghold/`, `src/dimensions/the_end/` |

Older milestone reports in `logs/survival/` predate the harness. Milestone 1 there is self-reported. Milestone 2 failed and used `/give` and `/tp`.

## Harness checks (the judge itself, verified live 2026-11-09)

| Check | Result |
| --- | --- |
| A `/give` sent over a second RCON client mid-run | Verdict **ASSISTED** with the command listed (`run_20261109_141451_assist_check`) |
| A `/kill` mid-run with `maxDeaths: 0` | Death counted from the datapack event, command listed, verdict **FAIL** (`run_20261109_141533_death_check`) |
| Inventory | Includes armor and offhand (1.21.5+ stores them under `equipment`) |
| Stat scoreboard vs stats file | Agreed (`mined:dirt`) |
| Dimension-change and death events | Carry the player UUID, dimension, coordinates and game tick |

**A bug found and fixed during this:** the start-of-measurement mark prints as `[Rcon] [oracle]`, and the parser first accepted only `[Server]`, so commands and deaths went uncounted. A missing mark is now a harness error. The two earlier verdicts (wooden PASS, stone FAIL) were re-checked against their server logs, and both stand.

## What runs today

- **`npm start`** runs the agent (`src/main.ts`): a Mineflayer bot with:
  - safety reflexes
  - a deterministic goal executor
  - an LLM fallback (Gemini through an OpenAI-compatible endpoint in `config/config.yaml`)
  - about 58 actions in `src/actions/registry.ts`, all overworld basics
- **`AGENT_GOAL="…"`** gives it a startup task, treated as an owner instruction. **`AGENT_HEADLESS=1`** skips the console UI.
- **`npm run task`** runs the agent on one task against a separate harness server in `runtime/server/` and writes a verdict to `logs/runs/<runId>/`. `--seeds` and `--repeat` run a batch and write a pass-rate table. See README, "Server-judged task runs".
- **Phase 1 groundwork (not yet used by the agent):** the skill contract and step-plan runner (`src/skills/contract.ts`, 79 unit tests), and the game's own data for 1.21.6 in `data/vanilla/1.21.6/` with a loader (`src/knowledge/vanilla.ts`).

## Known issues

- **Crafting lost items: fixed 2026-11-27, proven live.** Cause, from a packet trace of a live run: Mineflayer's `bot.craft` sends clicks back to back; a late server reply makes a click's state number out of date; a 1.21.6 server then resends the whole inventory mid-sequence, which overwrites Mineflayer's picture of the grid. It then took results early (the stray `oak_button`), left items in the grid, or waited 20 s for a result that never changed (`updateSlot:0 did not fire`). The fix is `src/actions/reliable_craft.ts`, which clicks one slot at a time and checks with the server. `scripts/repro_craft.ts --back-to-back` reproduces it: `bot.craft` lost wood in 5 of 6 loops, the new routine in 0 of 20.
- **The stone pickaxe plan skips gathering wood** (`src/agent/goals.ts:500-506`). It now passes anyway, because the first LLM step usually chops a tree before the task arrives, and the crafting planner fills in the chain. With an empty inventory and no tree chopped first, it still fails twice and stops.
- **No recovery after a failed task.** The failure cascades to every later task (`goals.ts:816-819, 923`) and the LLM takes over one action at a time. Both go away in Phase 2, when the step-plan loop replaces the hand-written plans.
- **Actions keep running after they are replaced.** Preempting an action only fires its abort signal; skills that ignore it (Mineflayer calls cannot be cancelled) keep going while the next action starts. The packet trace shows actions that are never finished. Crafting is now protected by an inventory lock; other skills are not yet.
- **The task arrives 2 s after the agent starts,** so each run opens with an LLM call for a default goal.
- **The judge can only check** bot inventory, advancements, stat increases, final dimension and deaths. Items in an open crafting grid or on the cursor are not visible to it (RCON does not report them). It has judged 18 runs: 12 PASS, 2 FAIL, 1 ASSISTED (the deliberate `/give` check) and 3 ERROR. All 3 errors came from a test server started alongside a batch, which shut the batch's server down; a lock now prevents that.
- **Risky movement:** the bot spent a lot of time underwater in that run (236 m walked underwater, 6 hearts of damage taken).
- **Type-check gaps:** `tsconfig.json` type-checks only `src/`, not `tests/` or `scripts/`.
- **Ender Dragon helpers:** they don't move the bot to the fountain, they write `bot.entity.yaw` directly, and several late-game helpers still report success without checking (listed in `src/dimensions/README.md`).

## How to check things yourself

```bash
npm test                                   # unit tests (mostly mocked bots; tests/oracle.test.ts uses real server output)
npm run typecheck                          # type-check src/
npm run task -- tasks/wooden_pickaxe.json  # server-judged run (stop any server on port 25565 first)
npm run task -- tasks/stone_pickaxe.json --seeds 20261109,7,42 --repeat 3   # pass-rate table
npx tsx scripts/repro_craft.ts --back-to-back --reliable --loops 20        # crafting under stress
npm run export:data                        # regenerate data/vanilla/<version>/ from server/server.jar
```

Every harness run writes `agent-logs/packets.ndjson`: inventory packets and action changes on one timeline.
