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

**Staying alive (Phase 5), three seeds each:** "it's getting dark, get through the night safely" with a bed held 3 of 3 (the LLM chose `sleep`; the server's `sleep_in_bed` stat and its clock confirm the night was skipped), "make me 2 cooked beef" with cows in a pen 3 of 3, "kill that zombie" 3 of 3 (and 3 of 3 with the zombie standing off so `hunt` walks to it; one LLM call each, ended by the new `killed` done-condition), "guard me for the night" with 12 mobs summoned through a 4-minute night 3 of 3 after two fixes below (every mob killed including the creeper, owner hurt at most 5 hp, the platform round the owner uncratered), "how many oak logs are in the chest at ...?" 3 of 3 (look first, then answer; 2 LLM calls), and "build a pillar of 3 cobblestone at ..." with the bot killed 3 seconds in (`death_recovery`) 3 of 3: code waited for the respawn, walked back 44 blocks, picked up everything it had dropped, and the LLM then finished the pillar with the recovered blocks.

### The companion (Phase 4): tasks given in chat

`npm run companion` connects to the server in `config/config.yaml`. Owners (`agent.owners`) type tasks in chat; they queue and run one at a time through the decision loop, and the bot reports the outcome in chat. `stop`, `stop all`, `pause`, `resume`, `status`, `what's next?`, `orders` and `cancel orders` are answered by code at once, with no LLM call.

**Standing orders** ("always guard me", "every minute, put the cobblestone in the chest", "every night, sleep in your bed"): the LLM turns the request into a plan once, marked `standing`, and code keeps the plan and runs it again by itself, every N minutes, once a night or day, or whenever nothing else is running for a step that runs until stopped. A task from the owner sets a running order aside, and the order picks up again afterwards. The LLM is asked again only when an order's plan fails, and an order that fails 3 times in a row is set aside and the owner told. "stop" while an order runs ends it; so does "stop guarding" naming it.

**Looking after itself:** after a death, code goes back for the dropped items before anything else (a running task does the same inside the decision loop and then tells the LLM what happened). When the food bar falls to 8 with nothing safe to eat, the companion starts its own errand to get food (the LLM picks how), and any task from the owner interrupts it. Places memory is kept per server and survives restarts. `npm run companion:test -- companion_tasks/<task>.json` runs a judged chat scenario: a scripted owner speaks, and what the bot said is read from the server's own log.

| Chat scenario | Passed (seeds 20261109, 7, 42) | Checked |
| --- | --- | --- |
| "give me 5 oak logs" | 3 of 3 | owner's inventory on the server; "On it" and "Done" in the server log |
| "follow me", then "stop" | 3 of 3 | task cancelled; "Stopped" reply |
| "how many oak logs do you have?" | 3 of 3 | "I have 10 oak logs." in the server log |
| two tasks queued, "what's next?" asked while the first runs | 3 of 3 | both done in order (logs in the owner's inventory, pillar blocks in the world); queue listed in chat |
| "from now on, always guard me", then "give me 2 bread", then zombies arrive | 3 of 3 | the guard order was set aside for the bread and resumed by itself; 3 zombies killed each time, owner took no damage, bread in the owner's inventory |
| "every minute, put all the cobblestone you have into the chest at ...", with cobblestone arriving twice | 3 of 3 | 24 cobblestone in the chest (three rounds) from one LLM call to set it up and one to repair the first round's plan |
| "every night, sleep in your bed" said by day, night falls 30 s later | 3 of 3 after the bed-spot fix (3 of 6 before) | `sleep_in_bed` stat and the server clock; one LLM call to set it up on two seeds |
| **2-hour soak**: standing guard, nightly sleep and 5-minute store orders, 11 requests spread over 2 hours, two forced disconnects and two LLM outages | 1 run (seed 20261109) | every world check passed: pillar built, 101 cobblestone stored, 8 logs handed over, owner unhurt, no deaths; all 11 nights slept through; both reconnects on the first try with queue and orders kept; tasks during the outages retried and finished; 19 LLM calls in all. 10 of 11 requests done ("craft a wooden pickaxe" stalled: the LLM guessed a chest's position, which the brief now gives). The verdict file says FAIL because the run crossed midnight and the judge then saw only the last 9 of 34 chat lines; re-read from the judge's own timeline with the fixed runner, all chat checks pass |
| killed while idle, 44 blocks from the respawn point | 3 of 3 | inventory on the server matches what was carried; no LLM call |
| food drained to 6 with no food held, cows and a furnace nearby | 3 of 3 | food bar 20 on the server at the end; cows killed per the stats file |

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
| `sleep` (finds or places a bed, skips the night) | **Server-judged PASS, 3 of 3** | `sleep_bed`: `sleep_in_bed` stat 1 and the clock back to morning. Server refusals (monsters nearby, too far, occupied) are matched from message text in unit tests only |
| `shelter` (walls or a capped hole, wait out the night, open again) | **Server-judged PASS, 6 of 6** | `shelter_night` (zombies summoned 22 blocks off) and `shelter_walls` (stone floor, walls only): no deaths, at most 40 tenths of damage, the clock back to morning |
| `hunt` (passive animals, spares 2, never pets, villagers or named mobs) | **Server-judged PASS, 3 of 3** | `hunt_cows`; only cows tried live |
| `obtain` of cooked food (hunt, then smelt) | **Server-judged PASS, 3 of 3** | `obtain_cooked_beef` |
| Armor upkeep (code puts on better armor and a shield) | **Server-judged PASS, 3 of 3** | `armor_upkeep`: leather boots and a golden helmet swapped for iron; all five slots read from the server's `equipment` data |
| `descend` + `obtain diamond` (staircase down to y -58, from an iron pickaxe start) | **Server-judged PASS, 3 of 3** | `obtain_diamonds`: 3 diamonds each in 4 to 9 minutes, no deaths. It picks a shaft column without caves or liquid, turns away from lava and water next to any cell it digs, bridges small gaps, hands off to the pathfinder for a few blocks when only an open cave is left, lights the way, digs with stone pickaxes (crafting enough at the surface first) and keeps the iron one for the ore. Earlier versions failed 12 runs on the way |
| `recover_items` (back to the death spot for the drops) | **Server-judged PASS, 6 of 6** | `death_recovery` and `idle_death` |

### The judge
| Check | Status |
| --- | --- |
| Inventory, advancements, stat increases, dimension, deaths, commands used | Verified live 2026-11-09; a `/give` gives ASSISTED, a `/kill` counts as a death |
| Blocks (with states or tags), regions, container contents | Verified live (`world_checks`): all checks agreed, and the read-only queries never reach the server log, so they are not mistaken for assistance |
| Bot position | Used by the go task above |
| Owner's inventory, owner nearby, owner's damage taken | Used by the owner, guard and companion tasks (damage from the owner's `damage_taken` stat, in hit points) |
| What the bot said in chat | Read from the server log by the companion runner |
| What the bot wears, the bot's food bar, the time of day | `equipment`, `food` and `daytime` checks over RCON, used by the armor, hunger and night tasks |
| Things the world does during a run | A task file's `events` (a kill, a mob, nightfall, items arriving) are run by the harness at set times and listed in the verdict as world events, apart from assistance |
| Items in a crafting grid or on the cursor | Not visible to RCON |

Across all judged runs so far (counted from the run folders): 354 PASS, 101 FAIL, 14 ERROR, 7 UNVERIFIED, 2 ASSISTED (the deliberate `/give` check, and the first idle-death run, before declared world events were told apart from help). The UNVERIFIED runs are early chat scenarios that had no server-checkable expectation. The errors are harness problems, mostly runs that collided on the server before the queueing lock existed.

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
- **The verdict called a test's own kill "assistance".** Commands a task file declares as world events are now matched to their log lines and listed apart.
- **"Always guard me" guarded the bot's own spot on one seed:** the LLM sent `guard {}` with no player. The prompt now says "me" means the owner and must be passed to guard, follow, come_to and give; the rerun named the owner.
- **A nightly sleep order failed on one seed** because the LLM gave the owner's position as the bed's; the repair kept the mistake and the order was set aside after 3 tries. `sleep` now falls back to a bed nearby or the one held when the given spot has none.
- **A creeper killed the guard mid-fight:** while the fight reflex held the body, nothing else was checked, so a creeper lighting its fuse next to a zombie fight could not be fled. A fight now breaks off the moment a fuse is lit or a creeper is at arm's length.
- **Skeletons shot the owner from out of guard range;** guard now meets archers as far out as creepers.
- **"Kill that zombie" wandered 241 blocks:** the reflex had already killed the zombie, and done_when could not say so. done_when gained `killed`, counted from the bot's own hits.
- **A spider on a cave wall held the bot for 8 minutes:** the fight reflex retried a mob it could not reach. A mob not hurt in a whole fight is now left alone for 30 s.
- **Digging down to diamonds:** the step walked past its cell and the loop kept planning from where the bot had been; the iron pickaxe wore out on the staircase; a crafting table cannot be placed in a 2x2 shaft. Fixed in that order.
- **The companion lost its state on a reconnect,** and an LLM outage failed the owner's task; now the companion keeps its queue and orders across a new connection and retries a task after an outage.
- **"Always guard me" never let a nightly order run;** a scheduled standing order now interrupts a guard-style one.
- **A midnight log rotation hid the bot's chat from the judge;** chat is now read from the judge's own timeline.
- **The bed went on the owner's feet:** `sleep` looked only at blocks when choosing where to put a held bed, so next to the owner it picked the cells the owner stood in and the server refused it. It now skips cells any player or mob stands in.
- **"Get through the night" stalled on all seeds:** done_when could not say "the night is over", and the LLM kept writing conditions that were already true. done_when gained `time_of_day` (and `food_at_least` for eating); then 3 of 3.
- **A JSON task file wrote the regex `\b10\b` with single backslashes, so `\b` became a backspace,** which failed a correct answer; the companion runner now refuses patterns with control characters.

## Known issues
- **Navigation on hilly terrain:** a tree visible but unreachable from the spawn defeats chop_tree and go_to; the loop gives up honestly but cannot route around it.
- **`guard_me` on seed 20261109 is flaky:** 2 of its 4 runs on 2026-11-28 had only one zombie leave the pen (the zombies must see a player through the door). Seeds 7 and 42 pass every time.
- **Deep mining is proven for diamonds from a surface start with sticks, cobblestone and torches in the kit;** iron from nothing to diamond armor (24 diamonds) is not tried yet.
- **Repairing a failed standing order can repeat the mistake:** the LLM sees the failure, but the nightly sleep order got the same wrong coordinates twice before being set aside.
- **`give` to a player who stands still:** in the standing-guard runs, 1 of 2 bread landed about 1.5 blocks beside the owner and was not picked up; the loop gave again and once the owner ended with 3. A real player would walk over; the scripted owner does not.
- **No fuel-only furnace step yet,** so "keep the furnace fuelled" is not possible; the periodic order was tested with storing instead.
- **Exploration is proven only up to 256 blocks;** the nearest villages on the test seeds are 700 to 1250 blocks away, so village finding is untested. Places memory starts empty in judged runs, so reloading it from disk is tested only in unit tests.
- **`guard` does not fetch its own gear:** the guard tasks give an iron sword and iron armor in setup.
- **Zombie test fragility:** mobs come out only if their pen is within their 35-block follow range of the owner.
- **Reflexes are basic:** melee only, no shield or bow, no fall prediction. Fighting or fleeing can run the bot off a ledge, and a reflex weapon swap can race a skill's equip and leave a stack on the cursor. Shelter is a skill the LLM or a standing order chooses, not a reflex.
- **`shelter` with a mob already next to the bot:** the hole method has no answer; the live tests start mobs 22 blocks away.
- **`hunt` cannot search:** `explore_for` finds blocks, not animals, so with no animals near, hunt can only suggest walking to grassland or a village. Only cows were hunted live.
- **Harness lock is not fair:** queued runs can wait behind another batch for half an hour (`HARNESS_LOCK_WAIT_SEC` raises the limit).
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
