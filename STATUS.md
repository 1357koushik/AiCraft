# Project Status

What has actually been shown to work, and how we know. Last reviewed **2026-11-11** against the code, tests and server-side evidence, not against earlier reports or commit titles.

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
| Wood → wooden pickaxe | **Server-judged PASS** (1 of 1 runs) | `logs/runs/run_20261109_135152_wooden_pickaxe`: seed 20261109, fresh world, no commands, 30 s; RCON inventory and stats file both show `crafted:wooden_pickaxe +1`. **Not reliable:** the stone pickaxe run below, on the same seed, needed a wooden pickaxe first and never made one. The passing run also crafted an `oak_button` by mistake |
| Wooden → stone pickaxe | **Server-judged FAIL** (1 of 1 runs) | `logs/runs/run_20261109_135253_stone_pickaxe`: 900 s timeout, no pickaxe of any kind at the end (see Known issues). Two old worlds from 2026-10-23 hold a crafted stone pickaxe, from runs with no command detection and before the planner rewrite |
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
- **`npm run task`** runs the agent on one task against a separate harness server in `runtime/server/` and writes a verdict to `logs/runs/<runId>/`. See README, "Server-judged task runs".

## Known issues

- **The stone pickaxe plan skips gathering wood (seen live, first cause of the failed run).** Its first task is a bare `craft_item wooden_pickaxe` with no prerequisites (`src/agent/goals.ts:500-506`). With an empty inventory it failed twice in two seconds and was marked `failed`.
- **No recovery after a failed task.** The failure cascades to every later task (`goals.ts:816-819, 923`) and the LLM takes over one action at a time. In that run it made 109 calls without progress.
- **Crafting loses items (seen live).** In the stone pickaxe run:
  - a stick craft from planks produced 0 sticks
  - 16 crafts failed with `bot.craft … Event updateSlot:0 did not fire within timeout of 20000ms`, and several reported "inventory only increased by 0".
  - The server's stats show 24 logs picked up and 12 planks crafted, with nothing dropped, yet the bot ended with 1 log. Items are probably stuck in a crafting window that never closed properly.
  - It never crafted a stick and never placed the crafting table.
  - These three issues block everything past wood. The crafting fix is Phase 1 in ROADMAP.md; the plan and recovery problems go away in Phase 2, when the LLM step-plan loop replaces the hand-written plans.
- **The judge has only four runs behind it**, and it can only check bot inventory, advancements, stat increases, final dimension and deaths. Items in an open crafting grid or on the cursor are not counted.
- **Crafting error messages in the same run:** "Cannot craft 1x wooden_pickaxe: missing required ingredients (1x wooden_pickaxe)" and "(1x crafting_table)" while holding one.
- **Risky movement:** the bot spent a lot of time underwater in that run (236 m walked underwater, 6 hearts of damage taken).
- **Type-check gaps:** `tsconfig.json` type-checks only `src/`. Strict `tsc` over `tests/`, `scripts/` and `tools/` reports about 80 existing errors, mostly mock objects in tests.
- **Ender Dragon helpers:** they don't move the bot to the fountain, they write `bot.entity.yaw` directly, and several late-game helpers still report success without checking (listed in `src/dimensions/README.md`).
- **A meaningless test:** `tests/survival_evaluation.test.ts` "tracks planning latency" checks random numbers it generates itself.

## How to check things yourself

```bash
npm test                                   # unit tests (mostly mocked bots; tests/oracle.test.ts uses real server output)
npm run typecheck                          # type-check src/
npm run task -- tasks/wooden_pickaxe.json  # server-judged run (stop any server on port 25565 first)
npm run task -- tasks/stone_pickaxe.json
```
