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

**Three-seed suite (seeds 20261109, 7, 42), on the current loop: 28 of 30 (93%).** 25 of the 30 runs needed one LLM call.

| Task (family) | Passed | Notes |
| --- | --- | --- |
| "go to 108 121 103" (go) | 3 of 3 | |
| "put all your cobblestone in the chest at ..." (storage) | 3 of 3 | chest contents checked by the judge |
| "build a 3 block tall cobblestone pillar at ..." (build) | 3 of 3 | each block checked by the judge |
| "break the row of cobblestone blocks from ... to ..." (dig) | 3 of 3 | region checked by the judge |
| "turn on the lever at ..." (interact) | 3 of 3 | done-condition `lever[powered=true]` |
| "how many oak logs do you have?" (question) | 3 of 3 | answer checked from the decision log |
| "what do I need to craft a crafting table?" (question) | 3 of 3 | |
| "give me a command block" (cannot do) | 3 of 3 | declined; inventory unchanged |
| "get me 4 oak logs" (obtain) | 2 of 3 | on one seed the only oak was unreachable from the spawn; the loop stopped after 4 decisions |
| "smelt the raw iron that is in the chest at ..." (process) | 2 of 3 | once smelted 1 of 3 and called it done; the brief now says "the X" means all of it (not yet re-run) |
| "craft a stone pickaxe" (progression) | **6 of 6** | median 4 LLM calls, 61 s |

**With an owner (scripted second player), three seeds each:** "come here" 3 of 3, "give me 5 oak logs" 3 of 3 (checked in the owner's inventory; re-run after the give fix below), "follow me for the next minute" 3 of 3 (93% of polls within 5 blocks), "protect me from the zombies for the next minute" 3 of 3 (3 zombies killed each time, owner took no damage), "guard me against the creeper for the next minute" 3 of 3 (creeper killed, owner unhurt, the yard's walls still intact), "get me 4 sand" 3 of 3.

### The companion (Phase 4): tasks given in chat

`npm run companion` connects to the server in `config/config.yaml`. Owners (`agent.owners`) type tasks in chat; they queue and run one at a time through the decision loop, and the bot reports the outcome in chat. `stop`, `stop all`, `pause`, `resume`, `status` and `what's next?` are answered by code at once, with no LLM call. Places memory is kept per server and survives restarts. `npm run companion:test -- companion_tasks/<task>.json` runs a judged chat scenario: a scripted owner speaks, and what the bot said is read from the server's own log.

| Chat scenario | Passed (seeds 20261109, 7, 42) | Checked |
| --- | --- | --- |
| "give me 5 oak logs" | 3 of 3 | owner's inventory on the server; "On it" and "Done" in the server log |
| "follow me", then "stop" | 3 of 3 | task cancelled; "Stopped" reply |
| "how many oak logs do you have?" | 3 of 3 | "I have 10 oak logs." in the server log |
| two tasks queued, "what's next?" asked while the first runs | 3 of 3 | both done in order (logs in the owner's inventory, pillar blocks in the world); queue listed in chat |

### The body (Phase 1): skills tested with hand-written plans, no LLM

`npm run plan -- plans/<plan>.json`. A bare bot runs a fixed step plan on a fresh judged world; this tests the skills with no decision-making in the way.

| Skill or check | Status | Evidence |
| --- | --- | --- |
| `craft` (2x2 and table recipes, tags like `#planks`) | **Server-judged PASS** | `craft_basics`; part of every stone pickaxe plan |
| `use_station` (furnace, smoker, blast furnace, stonecutter) | **Server-judged PASS, 3 of 3 seeds** | `stations` |
| `store`, `take`, `equip`, `eat` | **Server-judged PASS, 6 of 6** | `storage` (3 seeds, twice) |
| `go_to`, `place` | **Server-judged PASS, 4 of 4** | `move_place` |
| `chop_tree` | **Server-judged PASS, 6 of 6** | `chop_basics`; pillaring up to high logs is not proven |
| `mine` | **Server-judged PASS** in its own plans (6 of 6) and in the stone pickaxe plan (9 of 9) | reworked to dig through soft cover, count drops collected rather than blocks broken, and avoid water; the water and lost-drop recovery paths have not been exercised live |
| `collect_drops` | **Server-judged PASS, 3 of 3** | `collect_basics` |
| `use_block` (levers, doors, gates) | **Server-judged PASS** through the lever task (3 of 3) | |
| Reflexes (fight, flee, eat, escape lava, swim up) with pause and resume | **Server-judged PASS, 2 of 2** (zombie at night) | `reflex_fight`: the walk waited for the fight, then finished. Creepers are fled only when the fuse is lit (metadata 16, confirmed live) or within 3 blocks |
| Stone pickaxe from nothing, no setup, no LLM | **Server-judged PASS, 9 of 9** after the `mine` rework (8 of 12 before) | `stone_pickaxe` plan, three seeds |
| `obtain` (any item: chop, craft, smelt, mine, with tools, fuel and stations) | **Stone pickaxe from nothing 3 of 3; iron ingots from nothing on all three seeds (4 of 4 after the fixes)** | `obtain_stone_pickaxe`, `obtain_iron` |
| `come_to`, `follow`, `give` | **Server-judged PASS** through the owner tasks above | `give` now drops with settled single clicks and counts the owner's pickups from collect packets |
| `guard` (a player or a place, for N minutes) | **Server-judged PASS, 6 of 6** | `guard_me`, `guard_creeper` (brain tasks, three seeds) |
| `explore_for`, `remember_place`, `go_to {place}`, places memory | **Server-judged PASS, 9 of 9** | `explore_far_block` (a red sand patch set 150 blocks away), `remember_and_return` (walk 180 blocks off, return by name), `find_sand`; three seeds each |
| `inspect_container` | used by the process task | |
| Mining with an enchanted pickaxe | **Server-judged PASS** | `enchanted_dig`, after the enchantments fix |

### The judge
| Check | Status |
| --- | --- |
| Inventory, advancements, stat increases, dimension, deaths, commands used | Verified live 2026-11-09; a `/give` gives ASSISTED, a `/kill` counts as a death |
| Blocks (with states or tags), regions, container contents | Verified live (`world_checks`): all checks agreed, and the read-only queries never reach the server log, so they are not mistaken for assistance |
| Bot position | Used by the go task above |
| Owner's inventory, owner nearby, owner's damage taken | Used by the owner, guard and companion tasks (damage from the owner's `damage_taken` stat, in hit points) |
| What the bot said in chat | Read from the server log by the companion runner |
| Items in a crafting grid or on the cursor | Not visible to RCON |

Across all judged runs so far (counted from the run folders): 270 PASS, 60 FAIL, 14 ERROR, 7 UNVERIFIED, 1 ASSISTED (the deliberate `/give` check). The UNVERIFIED runs are early chat scenarios that had no server-checkable expectation. The errors are harness problems, mostly runs that collided on the server before the queueing lock existed.

### The old agent (`npm start`, `npm run task`)
Still runs: a Mineflayer bot with an LLM picking one action about once a second, hand-written goal plans, and about 58 older actions. With the crafting fix it passed "craft a stone pickaxe" 9 of 9 on three seeds. It is replaced by the decision loop above and is no longer developed.

### Not connected
Nether, fortress, blaze, piglin, stronghold, End and Ender Dragon code in `src/dimensions/` and `src/actions/combat/`. Nothing calls it and most of it reports success without checking (see `src/dimensions/README.md`). It will be rewritten against the skill contract in Phase 8.

## Bugs found and fixed on the way (all proven live)
- **Crafting lost items.** Mineflayer sends crafting clicks back to back; a late server reply made a click's state number stale, and the server's full inventory resend scrambled Mineflayer's picture of the grid. `src/actions/reliable_craft.ts` clicks one slot at a time and checks with the server. Reproduction: 5 of 6 loops lost wood before, 0 of 20 after.
- **The bot never sprinted, could not wake, and sent an invalid elytra action.** Mineflayer sends old `entity_action` ids on 1.21.6. Sprinted distance went from 0 to 44.7 m of 45.5 m once fixed (`src/connection/protocol_fixes.ts`).
- **Digging threw with any enchanted tool.** 1.21.6 item enchantments arrive in a shape Mineflayer's dig-time code cannot read; fixed in the same file.
- **Navigation skipped its arrival check under test fakes;** it now always checks.
- **`give` lost items.** `bot.toss` sends a pick-up, several drop clicks and a put-back in one burst with one state number; the server applied only some (5 meant, 2 arrived). From 1 block away the bot also picked its own drops back up. `give` now drops one settled click at a time (`dropReliably`), keeps 1.8 to 2.6 blocks away, steps back during the pickup delay, and counts what the player picked up from the server's collect packets. The chat version of "give me 5 oak logs" passed 1 of 3 before; after the fix, every give task (chat_bring_logs, chat_queue, bring_logs) passes 9 of 9 across the three seeds.
- **The places scan blocked the event loop for seconds,** which stalls the 4 Hz reflexes; it now yields every 3 ms (longest slice 3 to 5 ms live).
- **A JSON task file wrote the regex `\b10\b` with single backslashes, so `\b` became a backspace,** which failed a correct answer; the companion runner now refuses patterns with control characters.

## Known issues
- **Navigation on hilly terrain:** a tree visible but unreachable from the spawn defeats chop_tree and go_to; the loop gives up honestly but cannot route around it.
- **No standing orders yet** ("always guard me", "keep the furnace fueled"); a task runs once and ends.
- **Exploration is proven only up to 256 blocks;** the nearest villages on the test seeds are 700 to 1250 blocks away, so village finding is untested. Places memory starts empty in judged runs, so reloading it from disk is tested only in unit tests.
- **`guard` does not fetch its own gear:** the guard tasks give an iron sword and iron armor in setup.
- **Zombie test fragility:** mobs come out only if their pen is within their 35-block follow range of the owner.
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
npm run companion:test -- companion_tasks/chat_queue.json        # a chat scenario: the owner speaks, the bot queues and reports
npm run companion                                                # the companion on your own server (owners in config agent.owners)
npm run export:data                                              # regenerate data/vanilla/<version>/ from server/server.jar
```
Every judged run writes `logs/runs/<runId>/`: the verdict, the server log, a timeline of server snapshots, a packet trace, and for LLM runs `decisions.ndjson` with every prompt and reply.
