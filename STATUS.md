# Project Status

What has actually been shown to work, and how we know. Last reviewed **2026-11-27** against the code, tests and server-side evidence, not against earlier reports or commit titles.

## Labels
| Label | Meaning |
| --- | --- |
| **Server-judged** | Verdict from the harness (`npm run task`, `npm run plan`, `npm run brain`), using only server evidence: RCON reads, the `bot_oracle` datapack log, the server log, and the world's stats and advancement files |
| **Live** | Seen on the real server, but not judged by the harness |
| **Unit only** | Exercised only in tests, with no server |
| **Not connected** | Code exists, but nothing in the bot calls it |

Nothing is called working below 5 judged runs; pass rates are always given.

## The new design (ROADMAP.md): an LLM brain driving skills

### The decision loop (Phase 2): task in plain words, LLM plans, skills act, server judges

`npm run brain -- brain_tasks/<task>.json`. The LLM (Gemini, from `config/config.yaml`) answers each decision point with a short list of skill steps, an answer, a question for the owner, or giving up; code validates and runs the steps and asks again only when the plan finishes or a step does not.

| Task (family) | Status | Notes |
| --- | --- | --- |
| "get me 4 oak logs" (obtain) | **Server-judged PASS**, 1 of 1 | |
| "go to 108 121 103" (go) | **Server-judged PASS**, 1 of 1 | |
| "put all your cobblestone in the chest at ..." (storage) | **Server-judged PASS**, 1 of 1 | chest contents checked by the judge |
| "smelt the raw iron that is in the chest at ..." (process) | **Server-judged PASS**, 1 of 1 | take, place furnace, smelt |
| "build a 3 block tall cobblestone pillar at ..." (build) | **Server-judged PASS**, 1 of 1 | each block checked by the judge |
| "break the row of cobblestone blocks from ... to ..." (dig) | **Server-judged PASS**, 1 of 1 | region checked by the judge |
| "how many oak logs do you have?" (question) | **PASS**, 1 of 1 | answer checked from the decision log |
| "what do I need to craft a crafting table?" (question) | **PASS**, 1 of 1 | |
| "give me a command block" (cannot do) | **PASS**, 1 of 1 | declined; inventory unchanged |
| "turn on the lever at ..." (interact) | **FAIL**, 0 of 1 | The LLM set "be near the lever" as its done-condition, already true, and the loop finished without acting. Both causes fixed (trivially true conditions are sent back; block states are compared); rerun pending |
| "craft a stone pickaxe" (progression) | **FAIL**, 0 of 2 | First run: the model wrote step arguments outside `args` (now folded in). Second run: one decision covered the whole wooden-tool stage (6 steps, all done), then mining stone in water lost the drops; the loop-breaker stopped it after 4 decisions. Waits for the `mine` rework |

All of these are single runs, so none meets the 5-run bar yet. The next step is the suite on three seeds.

### The body (Phase 1): skills tested with hand-written plans, no LLM

`npm run plan -- plans/<plan>.json`. A bare bot runs a fixed step plan on a fresh judged world; this tests the skills with no decision-making in the way.

| Skill or check | Status | Evidence |
| --- | --- | --- |
| `craft` (2x2 and table recipes, tags like `#planks`) | **Server-judged PASS** | `craft_basics`; part of every stone pickaxe plan |
| `use_station` (furnace, smoker, blast furnace, stonecutter) | **Server-judged PASS, 3 of 3 seeds** | `stations` |
| `store`, `take`, `equip`, `eat` | **Server-judged PASS, 6 of 6** | `storage` (3 seeds, twice) |
| `go_to`, `place` | **Server-judged PASS, 4 of 4** | `move_place` |
| `chop_tree` | **Server-judged PASS, 6 of 6** | `chop_basics`; pillaring up to high logs is not proven |
| `mine` | **6 of 6 in its own plans, but fails in the open world** | `mine_basics`, `mine_iron` pass on prepared platforms. In the full stone pickaxe plan it misses buried stone, counted a lost drop as done, and lost drops in water. Being reworked |
| `collect_drops` | **Server-judged PASS, 3 of 3** | `collect_basics` |
| `use_block` (levers, doors, gates) | **Not yet run live** | only through the failed lever task above |
| Reflexes (fight, flee, eat, escape lava, swim up) with pause and resume | **Server-judged PASS, 1 of 1** (zombie at night) | `reflex_fight`: the walk waited for the fight, then finished |
| Stone pickaxe from nothing, no setup, no LLM | **8 of 12, then 5 of 6 earlier** | failures: mining (3) and a zombie death before reflexes existed (1) |
| Mining with an enchanted pickaxe | **Server-judged PASS** | `enchanted_dig`, after the enchantments fix |

### The judge
| Check | Status |
| --- | --- |
| Inventory, advancements, stat increases, dimension, deaths, commands used | Verified live 2026-11-09; a `/give` gives ASSISTED, a `/kill` counts as a death |
| Blocks (with states or tags), regions, container contents | Verified live (`world_checks`): all checks agreed, and the read-only queries never reach the server log, so they are not mistaken for assistance |
| Bot position | Used by the go task above |
| Items in a crafting grid or on the cursor | Not visible to RCON |

Across all judged runs so far: 115 PASS, 20 FAIL, 11 ERROR, 1 ASSISTED (the deliberate `/give` check). The errors are harness problems, mostly runs that collided on the server before the queueing lock existed.

### The old agent (`npm start`, `npm run task`)
Still runs: a Mineflayer bot with an LLM picking one action about once a second, hand-written goal plans, and about 58 older actions. With the crafting fix it passed "craft a stone pickaxe" 9 of 9 on three seeds. It is replaced by the decision loop above and is no longer developed.

### Not connected
Nether, fortress, blaze, piglin, stronghold, End and Ender Dragon code in `src/dimensions/` and `src/actions/combat/`. Nothing calls it and most of it reports success without checking (see `src/dimensions/README.md`). It will be rewritten against the skill contract in Phase 8.

## Bugs found and fixed on the way (all proven live)
- **Crafting lost items.** Mineflayer sends crafting clicks back to back; a late server reply made a click's state number stale, and the server's full inventory resend scrambled Mineflayer's picture of the grid. `src/actions/reliable_craft.ts` clicks one slot at a time and checks with the server. Reproduction: 5 of 6 loops lost wood before, 0 of 20 after.
- **The bot never sprinted, could not wake, and sent an invalid elytra action.** Mineflayer sends old `entity_action` ids on 1.21.6. Sprinted distance went from 0 to 44.7 m of 45.5 m once fixed (`src/connection/protocol_fixes.ts`).
- **Digging threw with any enchanted tool.** 1.21.6 item enchantments arrive in a shape Mineflayer's dig-time code cannot read; fixed in the same file.
- **Navigation skipped its arrival check under test fakes;** it now always checks.

## Known issues
- **`mine` in the open world** (above): buried stone, drops lost in water, and a lost drop once counted as done.
- **Tasks with an owner** (deliver, follow, guard) need the owner simulator and owner-inventory checks (Phase 4).
- **Reflexes are basic:** melee only, no shield or bow, no shelter at night, no fall prediction.
- **`use_station` paths not tried live:** running out of fuel mid-job, a full inventory, a station at given coordinates.
- **Type-check gaps:** `tsconfig.json` covers only `src/`, not `tests/` or `scripts/`.

## How to check things yourself
```bash
npm test                                                         # unit tests (pure logic and real game data; no fake game behaviour in new tests)
npm run typecheck                                                # type-check src/
npm run coverage                                                 # every game registry entry maps to the capability catalogue
npm run plan  -- plans/stone_pickaxe.json --seeds 20261109,7,42  # body alone, no LLM
npm run brain -- brain_tasks/store_cobblestone.json              # one task through the LLM loop
bash scripts/run_brain_suite.sh --seeds 20261109,7,42            # every family task, three seeds
npm run export:data                                              # regenerate data/vanilla/<version>/ from server/server.jar
```
Every judged run writes `logs/runs/<runId>/`: the verdict, the server log, a timeline of server snapshots, a packet trace, and for LLM runs `decisions.ndjson` with every prompt and reply.
