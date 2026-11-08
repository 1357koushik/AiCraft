# Project Status

What has actually been shown to work, and how we know. Last reviewed **2026-11-08** against the code, tests, observer logs and the server log, not against earlier reports or commit titles.

Labels: **Live** = seen on the real server · **Self-reported** = live, but only the bot's own client confirmed the result · **Unit only** = exercised only against mocked bots · **Not connected** = code exists, nothing in the bot calls it.

## Progression

| Stage | Status | Evidence |
| --- | --- | --- |
| Connect / reconnect to the server | **Live** | `data/action_contract_manifest.json` (the only `LIVE_PASS` entry) |
| Wood → wooden pickaxe (Milestone 1) | **Self-reported** | `logs/survival/milestone_01_wood_tools.*` — empty start inventory, no operator commands, 5 logs + wooden pickaxe in 49 s |
| Stone pickaxe + shelter (Milestone 2) | **Failed** | `logs/survival/milestone_02_stone_age.*` — stone pickaxe crafted, but only 3/23 shelter blocks placed; inventory and position were set with `/give` and `/tp` (confirmed in the server log) |
| Iron, armor, food, diamonds, obsidian | **Unit only** | Code in `src/actions/` and `src/actions/mining/`, never run live |
| Nether, fortress, blaze, piglin, ender pearls | **Not connected** | `src/dimensions/nether/`, `src/actions/combat/{enderman,wither_skeleton}_tactics.ts` |
| Stronghold, End, Ender Dragon | **Not connected** | `src/dimensions/stronghold/`, `src/dimensions/the_end/` |

The manifest lists building a Nether portal and defeating the Ender Dragon as `NOT_IMPLEMENTED`. The planner has "farm blaze rods" and "craft eye of ender" steps, but they only call the generic `attack` / `craft_item` actions; nothing takes the bot to the Nether.

## What runs today

`npm start` runs the real agent (`src/main.ts`): a Mineflayer bot with safety reflexes, a deterministic goal executor, and an LLM fallback (LM Studio by default). About 60 actions are registered in `src/actions/registry.ts`, all overworld basics (move, mine, chop, craft, smelt, attack, build shelter).

## Verification limits

- The observer (`tools/vanilla-observer`) records block, pickup and snapshot events, but it does **not** say which player caused a block or pickup event, and it cannot read inventories. So it can support a result but cannot confirm one on its own.
- Milestone reports therefore top out at `SELF_REPORTED_PASS`; `PASS` is reserved for an independent check that doesn't exist yet. The server's own log (`server/logs/latest.log`) records operator commands and could serve as part of such a check.
- `MultiSeedSurvivalEvaluator` (`src/campaign/full_survival_evaluation.ts`) only aggregates results from a runner you pass in. Its earlier built-in "10-seed benchmark" was hardcoded and has been removed; no real multi-seed run has been done.

## Known issues

- `tsconfig.json` type-checks only `src/`. Running strict `tsc` over `tests/`, `scripts/` and `tools/` reports about 80 existing errors (mostly mock objects in tests); vitest still runs them because it strips types.
- The Ender Dragon helpers don't move the bot to the fountain, turn by setting `bot.entity.yaw` directly (not sent to the server), and report success even with 0 hits.
- `tests/survival_evaluation.test.ts` "tracks planning latency" checks random numbers it generates itself; it doesn't measure the agent.

## How to check things yourself

```bash
npm test                    # unit tests (mocked bots; output goes to the OS temp folder)
npm run typecheck           # type-check src/
npm run milestone -- 1      # live Milestone 1 (needs the server running)
npm run milestone -- 2      # live Milestone 2
```
