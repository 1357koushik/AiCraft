# Production Roadmap: an AI companion that takes any Minecraft task and finishes it

It handles two kinds of task with the same system:
- **Help tasks** a player asks for: "bring me 20 iron", "build a house here", "follow me and keep zombies off me", "find a village", "keep my furnace running", "how do I make a piston?"
- **The largest task**: "beat the game" (kill the Ender Dragon).

Revised 2026-11-09. This plan is built on:
- a code-level audit of this repo,
- live tests run today on this repo's own server (`server/`, vanilla 1.21.6),
- a survey of the reference repos in `references/` (mindcraft, mindcraft-ce, Voyager, mc-planner/DEPS), read for ideas only. Their code was not assumed to be correct.

**The bar is production quality:** no mocks standing in for game behaviour, no arbitrary caps, no success the server can't confirm, and enough tooling to see exactly what went wrong in any run.

---

## 0. Ground rules

1. **The server is the judge.** A task or milestone passes only when server-side evidence confirms it: RCON queries, the datapack event log, advancement and stat files, and the server log. The bot's own claims are logged but never decide a pass (AGENTS.md).
2. **No mocked game behaviour in tests.** Unit tests are only for pure logic: maths, parsers, planner output over real vanilla data, config. Any test of a skill runs against the real server, in a prepared arena, and is checked by the server.
3. **No arbitrary caps.** Every limit is either:
   - derived from the task (a deadline based on distance, a budget based on the quantity asked for), or
   - a real game constant (reach 4.5 blocks, build height, stack size).

   Progress watchdogs replace fixed timeouts.
4. **No unverified success.** Every skill reads the world or inventory after acting, and reports `success` only when that read matches the intended outcome.
5. **Code executes, the LLM decides.** The LLM never writes executable code, never runs per tick, and is never the judge of success.
6. **Everything leaves a trace.** Each run produces one timeline that lines up the bot's intentions, its actions, server events and LLM decisions, so any failure can be explained after the fact.

---

## 1. What's true today (verified)

### The bot
| Area | Real state |
| --- | --- |
| Wood → stone pickaxe | Works live, unassisted (server `stats/` and advancements confirm it) |
| Iron | Smelted live only with items handed over by `/give` |
| Shelter | Failed live (3/23 blocks) |
| Diamonds and later | Never run live |
| Nether / stronghold / End code | Not imported by the running bot. Most of it reports success unconditionally (e.g. `exit_portal_navigator.ts:51` returns `victory: true`) |
| LLM role | Picks one action about once a second. It can't call the planner (`loop.ts:319-394`) |
| Task intake | Regex (`goals.ts:163-269`). "Beat the game" becomes a goal with no plan |
| Replanning | None. A failed plan stalls for good |
| Tests | 496 pass, all against hand-built fake bots. The campaign summary claiming "21 independently confirmed" passes is hardcoded text (`scripts/generate_coverage_report.ts:78,183`) |

### The server (`server/`, tested today on a throwaway world `oracle_smoke`, original settings restored afterwards)
| Channel | Result |
| --- | --- |
| **RCON** | Works once enabled. `data get entity dragonai Inventory/Pos/Dimension/Health` returned exact values. The selector `@a[advancements={minecraft:story/root=true}]` works for advancement checks. Kills and give commands work |
| **Datapack events** | A custom datapack loaded on a new world. Advancement triggers `inventory_changed`, `placed_block` and `changed_dimension` call a function that runs `say`, and each line lands in `latest.log` tagged with the player: `[dragonai] [oracle] placed_block`. **Macro functions** can write structured JSON with coordinates, e.g. `[oracle] {"ev":"placed_block","x":12,"y":64,"z":-7}` |
| `tellraw` | Does **not** reach the server log, so `say` is the logging channel |
| `recipe_crafted` trigger | Requires a `recipe_id`. Use the `crafted` stats instead |
| **Stat files** | `world/stats/<uuid>.json` recorded exactly what the bot did: `mined.oak_leaves: 1`, `used.dirt: 1` |
| **Advancement files** | Per-criterion timestamps (e.g. `story/root` at 18:52:41) |
| **Server log** | Logs RCON commands as `[Rcon: …]`, deaths (`dragonai was killed`), joins and leaves, so assisted runs are easy to detect |
| Scoreboard stat criteria | `deathCount` works. `minecraft.mined:<block>` objectives work. Mine tracking still needs a live dig to confirm: the test bot happened to dig leaves |
| Startup | A new world was ready in about 5 s, so a fresh world per test is cheap |
| **Gotcha** | `pause-when-empty-seconds=60`: the server stops ticking when no player is online. Set it to 0 for test runs |
| Offline UUID | `dragonai` = `42b70a38-e493-319b-94e3-4d4c6fee493e` |
| Java | JDK 22 runs the server. JDK 11 is also installed, and Maven picks it up by default; that's why the observer plugin build failed before |

### Sources of truth for game knowledge (checked locally)
| Source | What it gives | Status |
| --- | --- | --- |
| **Vanilla data export** (`java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --server --reports`) | **1,407 recipes, 1,246 loot tables** (block drops, mob drops, piglin bartering, chests), **1,520 advancements**, `commands.json`, `blocks.json`, `packets.json`, registries and tags, all exactly 1.21.6 | Tested today. Use as the authoritative knowledge base |
| `minecraft-data` 3.117 | Block and item IDs, collision shapes, protocol, foods, entities | Good. Its **1.21.6 `blockLoot`/`entityLoot` point to 1.20 data**, so don't use it for drops |
| `node_modules/mineflayer/docs/api.md`, `mineflayer-pathfinder/readme.md` | Exact API for our versions | Local |
| Minecraft Wiki (minecraft.wiki) | Mechanics not in the data files: dragon phases, stronghold layout, eye-of-ender behaviour, fortress generation, bartering timing, mob AI | Read as needed and cite in code comments |
| `references/*` | Design ideas and Mineflayer workarounds | Ideas only. Every borrowed trick gets its own live test |

**No extra docs are needed from you.** Between the vanilla data export, the local API docs and the wiki, the data side is covered. What makes the bot work is live testing against the server.

---

## 2. Target architecture

```
 owner chat / CLI / API ──► L4 STRATEGIST (LLM, event-driven, budgeted)
                              intake · strategy choice · go/no-go gates
                              failure diagnosis · exploration direction · designs
                                      │ validated tool calls (Zod)
                              L3 GOAL TREE (code, persisted)
                              goal stack · progress · replanning · maintenance goals
                                      │
                              L2 PLANNER (code, built from vanilla data export)
                              recipes · smelting · loot tables · tool tiers
                              acquisition strategies with cost estimates
                                      │
                              L1 SKILLS (code, verified, resumable)
                              travel · mine · craft · smelt · build · fight · portal …
                                      │
                              L0 REFLEXES (code, per tick, preempt → pause → resume)
                              lava · drowning · fall · creeper · low HP · suffocation
 ─────────────────────────────────────────────────────────────────────────────
 GROUND TRUTH (separate from the bot): RCON poller · datapack event log ·
 stats/advancements diff · server log tail  ──► oracle verdicts + timeline
```

### The LLM is the brain; code is the hands
The LLM is what makes this an AI agent rather than a script:
- It understands what the player wants.
- It decides **what** to do and in what order.
- It chooses between strategies, and judges risk.
- It handles surprises and talks to the player.
- It can **change the plan at any time**.

Code never overrules those choices. Code owns three things the LLM is bad at:
- **How** to carry out a decision precisely: block-by-block movement, recipe maths, aiming.
- Reacting within **milliseconds** to lava, falls and creepers, faster than any LLM call returns.
- **Proving** the result on the server.

Why the LLM doesn't steer every single step:
- This repo does that today, and it never gets past early game.
- mindcraft and Voyager do it too, and they stall on long tasks.
- A call takes 1-5 s and costs money each time.

So the LLM makes the decisions that matter, and code carries out each one quickly and reliably.

### Who decides what
| Decision | Decided by |
| --- | --- |
| Reflexes, eating, combat timing, shield, flee | Code (L0/L1) |
| Recipe maths, tool choice, harvest tier, block to mine, path | Code (L2/L1), from vanilla data |
| Which subgoal next (ready, nearest, cheapest) | Code (DEPS-style selector, implemented properly) |
| Free text → goal tree | **LLM** (validated against real item and block IDs) |
| Choosing between viable routes (pearls: hunt vs barter; iron: caves vs strip mining) | **LLM**, with code-computed costs |
| Ready for the Nether or End? | **LLM**, with a code-computed checklist |
| What to do after deterministic recovery has failed | **LLM**, with a structured failure report and evidence |
| Where to explore for an unseen structure | **LLM**, with a map summary from memory |
| Builds, farms, open-ended creative work | **LLM** blueprint, placed and verified by code |
| What "here", "this", "that tree" or "my base" refers to | Code (owner position, look direction, named places); **LLM** only when still ambiguous, and then it asks |
| Which request comes first when several are pending | Code priority policy; **LLM** only for real conflicts ("you asked for X, but Y is running") |
| Answers to game questions ("how do I make a piston?") | **LLM** writes the answer from facts code looks up in the vanilla data, never from memory alone |
| Done? | **Server oracle only** |

### LLM interface
- The LLM is called at decision points:
  - `task_intake`, `choose_strategy`, `gate`, `recover`, `explore_direction`, `design`, and owner chat
  - **`review`**: a regular check-in every few minutes of task time, and after any notable event (a death, low supplies, finding a structure, a subgoal finished or abandoned). It sees progress and recent events and can keep going, reorder, change strategy or rewrite the plan. This is how it stays in charge without steering every step.
- It answers with exactly one validated tool call: `set_goal_tree`, `revise_goal_tree`, `pick`, `run_skill`, `blueprint`, `ask_owner`, `continue` or `abandon`.
- **Budgets:** limits on calls per hour and tokens per run. When the budget runs out, code takes the safe default and logs that it did.
- Decisions are cached by situation key, and stale responses are discarded when newer input arrives (from mindcraft).
- **Provider-agnostic:** today that's Gemini through the OpenAI-compatible endpoint. Provider failover and the strategist model are set in config. Update the Anthropic provider's outdated default model.

---

## 3. Task system: any request, not just progression

"Beat the game" is just the biggest task. Every request, large or small, goes through the same path:

**Chat → intake (LLM) → typed task → goal tree → planner → skills → server verifier → report back**

Adding a new kind of request means adding a **task type**: a typed spec, a planner expansion and a server verifier. The loop itself doesn't change.

### Task types (each with a server-side verifier)
| Type | Example requests | What code does | How the server confirms it |
| --- | --- | --- | --- |
| **Obtain** | "get 20 iron", "get diamond armor" | planner → gather/craft/smelt | RCON bot inventory |
| **Deliver** | "bring me 10 bread", "give me your diamonds" | obtain → travel to owner → toss to owner | RCON **owner** inventory delta |
| **Process** | "smelt the ores in that chest", "cook this meat" | container → furnace → container | `data get block x y z Items` |
| **Build** | "build a small house here", "bridge this river", "wall around my base" | LLM blueprint → material plan → place in order | blueprint checked block by block with `execute if block`, plus `placed_block` events |
| **Clear / dig** | "clear this area", "dig a 2×3 tunnel to there", "flatten this hill" | region plan → dig in order; asks before breaking player-placed blocks | block checks over the region (air or the target block) |
| **Farm / husbandry** | "make a wheat farm", "harvest my crops", "breed cows" | layout → till/plant/water; breeding loop | blocks plus entity counts (`execute store result … if entity @e[type=cow,distance=..r]`) |
| **Find / scout** | "find a village", "find diamonds", "where's the nearest desert?" | explore guided by memory → report coordinates | `locate` (oracle only) or a block check at the reported spot |
| **Go / meet** | "come here", "go home", "meet me at the portal" | travel to a position, a named place or the owner | heartbeat position within range |
| **Escort / guard** | "follow me", "protect me", "kill zombies near my house" | ongoing follow/guard behaviour that keeps running | heartbeat distance over time, owner damage stats, kill counters |
| **Storage** | "put your stuff in the chest", "sort my chests", "fetch my pickaxe from storage" | container plan, with an index of storage contents in memory | container `Items` data before and after |
| **Trade / enchant / brew / repair** | "trade with that villager for books", "enchant my sword", "make fire resistance potions" | villager window, enchanting table and anvil, brewing stand | item components in RCON inventory data |
| **Standing orders** | "keep my furnace fueled", "light up the base at night", "always guard me" | recurring goals with a check interval, running between other tasks | periodic server checks, e.g. light level with an inline `location_check` predicate (verify in Phase 0) |
| **Questions / advice** | "how do I make a piston?", "what are you doing?", "how much iron do you have?" | facts looked up in the vanilla data, perception and memory, worded by the LLM | answers checked against the data in an offline test set |
| **Progression** | "beat the game", "get to the Nether" | milestone tree M1-M10 | advancements |

### Understanding what the player means
- **"here", "me", "come to me":** the owner's position, from the bot's view of the player entity. If the owner is out of range, the bot uses the last known position or asks for coordinates.
- **"this", "that tree", "that chest":** the block or entity under the owner's crosshair, computed from the owner's position and look direction, which Mineflayer receives for player entities. If there are two candidates, the bot asks.
- **"my base", "the portal", "home":** named places in memory, which the owner can set ("this is my base").
- **Quantities and sizes:** "some" or "a few" come from config defaults, and the bot says what it assumed ("getting 16 iron"). Anything large or destructive is confirmed first.

### Task lifecycle (what a player experiences)
- **Acknowledge** every request with the bot's interpretation, e.g. "Building a 7×7 oak house at your position. Need 120 planks, I have 40, gathering the rest."
- **Priorities:**
  1. Safety reflexes
  2. Direct owner commands: "stop", "come here", "help"
  3. The current task
  4. Standing orders
  5. Maintenance (food, tools, sleep)
  6. Idle

  A new request either queues behind the current one or interrupts it, by policy. Interrupted tasks resume later.
- **Control commands:** `stop`, `cancel`, `pause`, `resume`, `what are you doing?`, `queue`, `forget that`, all answered by code with no LLM call.
- **Progress reports** at subgoal boundaries (configurable, so it isn't spammy), and a **completion report with evidence** ("10 bread delivered, your inventory went 0→10").
- **Failure reports:** what was tried, why it failed, and what the bot suggests next. These come from the structured failure trail, not invented text.
- **Honest about what it can't do yet:** intake checks the request against the list of skills that exist. If the request needs one that doesn't exist yet (e.g. complex redstone), the bot says so instead of flailing.

### Permissions and safety for help tasks
- Only configured owners can give tasks. Other players' chat is data, not instructions.
- **Never damage what a player built** without asking:
  - Blocks recorded as player-placed are protected.
  - Owners can set protected zones.
  - "Clear this area" lists any player-placed blocks it would break and waits for a yes.
- Never attack players, pets or villagers. Never take items from an owner's chests unless asked. Refuse griefing requests.
- Destructive or long tasks (large digs, using up the owner's resources) are confirmed before starting.

---

## 4. Ground truth and server kit (in the repo, versioned)

`server-kit/` holds everything the harness needs to run a judged session:
- `datapacks/bot_oracle/`, the prototype tested today, extended:
  - **Event advancements** that log JSON through macro `say`, each followed by a revoke:
    - `placed_block`, `inventory_changed`
    - `changed_dimension`, `entity_killed_player`, `player_killed_entity`
    - `item_used_on_block`, `enter_block`, `consume_item`, `player_interacted_with_entity` (bartering), `slept_in_bed`
  - **Each event carries** player, dimension, x/y/z, game tick, and an item or entity ID where the trigger allows it.
  - **Scoreboards:** deaths, plus mined/crafted/killed counters for tracked items, created on load.
  - **Positions over time** for the bot and every owner come from RCON polling (built in Phase 0), not a datapack heartbeat. Datapack `say` lines also reach every player's chat, so a 1 Hz heartbeat would spam a human owner. RCON reads appear in neither chat nor the server log. "Follow me" and "come here" are judged from these snapshots.
- `server.properties` templates:
  - **test:** RCON on, `pause-when-empty-seconds=0`, fixed seed, `white-list=true`, `spawn-protection=0`
  - **survival-benchmark:** normal difficulty, no cheats, random or fixed seed
- `scripts/server.ts`:
  - start/stop the vanilla jar with JDK 22, using a generated RCON password stored only in `.env`
  - create a fresh world per run (seeded), copy in a checkpoint world, install the datapack
  - wait for RCON to be ready
  - save the server log slice with the run
- `src/oracle/`:
  - **RCON client**, with a reconnect loop.
  - **Poller:** inventory, position, dimension, health and food at 1-2 Hz, for the bot and the owner. Delivery tasks are judged by the owner's inventory.
  - **File readers:** advancement and stat files, diffed before and after.
  - **Log tailer:** parses `[oracle] {json}`, deaths, `[Rcon: …]` commands and advancements.
  - **Verdict API:** for example `await oracle.expect({ inventory: { obsidian: '>=10' }, advancement: 'story/enter_the_nether', noCommandsSince: t0 })`.
- **Observer identity:** the harness uses RCON. It never logs in as the owner account and never uses the owner's op rights.
- **Optional, later:** Paper and the existing `observer-plugin`. It builds under JDK 22, but Paper is a different server and needs a download. Use it only if the datapack proves too limited.

Note: `say` messages also reach every player's chat. The agent's chat handler must drop `[oracle]` lines, and the agent must never use them as information about the world (test that this holds).

---

## 5. Debugging and observability

1. **Trace IDs** through every layer: run → goal → task → skill → primitive. Each log line carries them.
2. **Agent trace (NDJSON):**
   - every decision point and the LLM's answer
   - every skill start and end, with params, `failureKind`, inventory before/after and duration
   - every reflex activation, pathfinder event and stuck event
3. **Merged timeline** (`npm run timeline <runId>`): merges the agent trace, oracle events, RCON snapshots and the server log by time into one HTML/Markdown report, with a map of server-recorded positions.
4. **Discrepancy detector, running live:** when the bot's belief disagrees with the server (e.g. the bot thinks it has 3 iron but RCON says 2, or a skill says "placed" but no `placed_block` event arrived), it's flagged immediately with both sides. This turns silent bugs into visible ones.
5. **Repro bundles:** for any failed run, save the seed, a checkpoint world, the config, the git commit, the trace and the decisions, so `npm run replay <bundle>` restarts at the failing step.
6. **Live dashboard:** current goal tree, skill, vitals and recent oracle events, served locally. Optional 3D view with `prismarine-viewer` (it needs installing, so get your OK first).
7. **LLM decision log:** prompt, response, latency, tokens and outcome. Recorded decisions can be re-run against other models or prompts to compare them.

---

## 6. Live test framework (replaces the mocks)

- **Arenas:** small, deterministic test setups built by the harness over RCON on a fresh, seeded flat or normal world. They use `fill`/`setblock`, `place structure` (e.g. `minecraft:fortress`, `minecraft:stronghold`) and `place template`. Examples:
  - a lava moat crossing
  - an ore wall at Y=-58
  - a furnace and fuel
  - a portal frame site
  - a fortress corridor in the Nether
  - a stronghold portal room
  - a creeper ambush
  - a 30-block drop with water below for the clutch
- **Each skill test has a setup phase and a measured phase:**
  - **Setup** uses commands (labelled ASSISTED-SETUP).
  - **Measured:** the oracle confirms that **no commands** ran, and checks the outcome on the server.
- **Ground truth the bot never sees:** for example `locate structure minecraft:stronghold`, to score how accurate eye-of-ender triangulation is.
- **Owner simulator:** a second scripted Mineflayer client (`owner_sim`), listed as an owner in the **test config only**, plays the human so help tasks can be tested unattended:
  - It types requests in chat.
  - It walks routes for "follow me", and stands somewhere for "come here" or "build a house here".
  - It looks at a block for "mine that".
  - It answers the bot's clarifying questions from a script, and holds still while items are delivered.

  It is a test actor, not a judge. Verdicts still come from the server.
- **Help-task benchmark:** a JSON file of requests. Each entry has:
  - the chat text
  - the arena or seed
  - the owner simulator's script
  - the server verifier (owner inventory delta, block checks, heartbeat distance, container contents, and so on)
  - a time budget

  Every task type in section 3 has several entries, worded different ways ("bring me", "can you get me", "I need").
- **Tiers:**
  - `test:unit`: pure logic only (planner over the vanilla data, parsers, maths). Runs in seconds.
  - `test:skills`: each skill in its arena, judged by the server. Minutes.
  - `test:tasks`: real tasks from a fresh world ("get an iron pickaxe", "get 10 obsidian").
  - `test:help`: the help-task benchmark with the owner simulator.
  - `test:milestones`: M1-M10, first from checkpoint worlds, then from scratch.
  - `bench:survival`: multi-seed, unassisted, recording success rate, time, deaths and LLM calls.
- **Delete** every test that mocks the bot. Each one is replaced by a skill test that covers the same behaviour on the real server. Keep the pure-logic tests (`math`, `json_parser`, `plan_cache`, `config`, `memory`, the triangulation maths, `dynamic_dag_planner` once it runs over real data).
- Type-check everything (`src`, `tests`, `scripts`, `tools`) and fix the 80 existing type errors in the tests.

---

## 7. Limits to remove (current values in code)

| Where | Current | Replace with |
| --- | --- | --- |
| `movement.ts:77`, `navigator.ts:284` | refuses targets > 48 blocks | Long-distance travel in chunk-sized legs, with no distance cap |
| `navigator.ts:357` | deadline clamped to 4-30 s | Deadline scales with distance, plus a progress watchdog (fails only when no progress is made toward the goal) |
| `navigator.ts:366` | "stuck" after 2 s still | Tied to pathfinder state: computing or digging is not stuck |
| `techniques.ts:91-101` | always avoids water on land | Swimming and boats allowed; danger from memory adds path cost |
| pathfinder Movements | towers and parkour off | On where safe, with scaffold blocks managed |
| `movement.ts:444` | explore ≤ 24 blocks | Explore session lasts until the target is found or the budget runs out, guided by memory |
| `findBlock maxDistance: 48/32/16/8/4` (about 20 places; the 4.5 reach checks are legitimate) | fixed radius | Search loaded chunks, then the memory index, then explore |
| `mining_building.ts:150` | mine ≤ 8 blocks | Count comes from the goal |
| `techniques.ts:141`, `end_crystal_destroyer.ts:95` | pillar ≤ 12 | Up to the height needed (dragon pillars are 76-103 blocks), with safety checks |
| `techniques.ts:289, 1242` | bridge/staircase ≤ 16 | Up to the distance needed |
| `deepslate_branch.ts:135` | staircase ≤ 12 steps | Down to the target Y |
| `perception/blocks.ts:141-146` | scan ≤ 16, every second block | Full chunk scan with an indexed block cache (no stepping), so single diamonds aren't missed |
| `meta.ts` | `wait` ≤ 10 s | Wait on an event, with a timeout from the task |
| `loop.ts:400`, config | 1-5 actions per step | Removed: the loop now drives the goal tree, not single actions |
| `smelt` | ≤ 64 items, one stack checked, fixed 12 s per item | Batches across stacks, driven by furnace events, with a timeout from the expected smelting time |
| `navigator.ts:474` | `_isMockFunction` check in production code | Deleted |

---

## 8. Ideas taken from the reference repos (each verified live before relying on it)

**Adopt**
- **mindcraft:**
  - typed command schema with parameter ranges and ID checks
  - try a path with no digging first, then allow digging
  - open doors when stuck
  - abort a path that would dig a block the bot can't harvest
  - `collectBlock`: aliases (iron → iron ore + deepslate iron ore), `safeToBreak`/`canHarvest`, liquids taken from source blocks only, tunnelling to buried ore
  - reflex activity shown to the LLM as context
  - discard stale LLM replies
- **mindcraft-ce patches:**
  - pathfinder: empty search rejects, `stop()` doesn't cancel the next goal, pathing out of lava
  - crafting confirmed by window snapshot
  - prismarine-item reads modern enchantment data

  Each one is ported only after a live test shows the bug in **our** versions. Example: mindcraft's `use_item` rotation patch is **already fixed in Mineflayer 4.39** (`inventory.js:134-141`), so it's not needed.
- **Voyager:**
  - placement confirmed by an inventory or world check, because Mineflayer can report a false timeout
  - drops tracked after digging
  - structured "missing X / need tool Y" failures from crafting
  - failure budget per primitive
  - compact observation text with coordinates and deltas
- **DEPS:**
  - replan when a precondition fails or a step budget runs out, with a capped number of replans
  - select the nearest feasible subgoal. DEPS left this as a stub; we implement it.
- **mindcraft's dependency planner** (`npc/item_goal.js`): failure-weighted choice of method (craft / mine / smelt / hunt) with inventory-delta verification. Same idea as our L2, built on the vanilla data instead of buggy names.

**Avoid**
- LLM-written code, or a skill library made of it (Voyager, mindcraft `newAction`).
- An LLM call per command (mindcraft); an LLM critic as the judge (Voyager); "explanations" with no evidence behind them (DEPS).
- Cheats in benchmarks: `/give`, `/tp`, keepInventory, peaceful, a frozen day/night cycle (Voyager).
- Reflexes that kill an action without resuming it; restarting the process to resync inventory (mindcraft).
- Fixed sleeps; treating `entityGone` as a kill; a blanket "hostile" check that provokes endermen and piglins.

---

## 9. Phases

Every phase closes with **live, server-judged** acceptance tests. A phase isn't done because its code exists.

### Phase 0: Server kit and oracle (1 week) · **done 2026-11-09**

What was built:
- `server-kit/`: the `bot_oracle` datapack and the server properties template
- `src/oracle/`: RCON client, log parser, file readers, probes, expectations, session
- `src/harness/`: an isolated server instance in `runtime/server/` and the task runner
- `npm run task`

Verified live:
- wooden pickaxe: PASS
- stone pickaxe: FAIL (a crafting desync, now the first Phase 3 item)
- a `/give` mid-run gives ASSISTED
- a `/kill` mid-run is counted as a death

Moved to later phases: the survival-benchmark properties template, checkpoint-world saving, and a separate observer account (none is needed, since RCON reads replace a logged-in observer).

Original plan:
- Build `server-kit/` and `src/oracle/` from the prototype tested today (section 4).
- Write `npm run task -- "<text>" --seed N`, which produces a server-judged verdict and a run folder.
- **Clean up:**
  - Delete `generate_coverage_report.ts` and the false campaign summary.
  - Delete `src/automation.ts`, which duplicates the bot.
  - Delete the "always succeed" late-game helpers, or mark them excluded.
- **Done when:** "craft a stone pickaxe" from a fresh seeded world gets PASS or FAIL from the advancement files and RCON, with commands detected.

### Phase 1: Observability (1 week, overlaps Phase 0)
- Trace IDs, agent NDJSON trace, merged timeline, discrepancy detector, repro bundles, dashboard (section 5).
- **Done when:** a deliberately broken run (e.g. disable the harvest-tier check) is explained by its timeline without reading code.

### Phase 2: Live test framework (1-2 weeks)
- Arena builder, the skill-test runner, and the tiers in section 6.
- Remove the mocked behaviour tests; type-check everything.
- **Done when:** every currently registered skill has a live arena test, and the suite runs end to end unattended.

### Phase 3: Executor foundation and owner interaction (3 weeks)
- **Every primitive returns a `SkillResult`:** `status`, `failureKind`, `inventoryDelta`, `worldDelta`, `durationMs` and evidence. Success only when verified.
- **Remove every limit** in section 7.
- **Fix the known bugs:**
  - harvest-tier checks on all digs
  - verified pickups
  - timeouts on every raw `goto`
  - `chop_tree` leaves
  - bridge step length
  - real bucket fill/empty (aim at a source block, then `activateItem`)
  - best weapon chosen
  - `mount` uses 1.21 boat names
  - containers reached by walking to them
  - remove `swap_hands` (fake packet) and the direct `bot.entity.yaw` writes
- **Reflexes:**
  - Fall prediction based on damage, not velocity.
  - Low-HP preemption only when there's a threat or damage source.
  - **Pause and resume** the task instead of failing it, without spending retries.
  - A real water clutch (place water before impact, pick it up after landing).
  - Fix `arbiter.startAction` running outside its `try` (`goals.ts:758`).
  - Don't run reflexes twice per tick.
- **Long-distance travel and an indexed block cache** (chunk scan, persisted known locations).
- **Owner-interaction skills:**
  - `come_to(owner)`
  - `follow(owner)`, which keeps running until cancelled and keeps pace across terrain and water
  - `stay`/`stop`
  - `give_to(owner, item, n)`: walk within range, face the owner, toss, and confirm by the owner's inventory
  - `guard(owner)`: an ongoing loop that engages hostile mobs near the owner and leaves neutral mobs alone
  - resolving what the owner is looking at (block or entity under their crosshair)
- **Owner simulator and the first help tasks** in the benchmark.
- **Done when:**
  - every skill passes its arena test 10/10 times
  - M1-M2 pass live unassisted on 3 seeds, including the first night
  - "come here", "follow me" (5 minutes over mixed terrain), "give me 5 logs" and "mine that block" pass with the owner simulator, judged by the server

### Phase 4: Knowledge base, planner, goal tree, task system (3 weeks)
- **Generate `data/vanilla/1.21.6/`** from the server jar export: recipes (all variants and tags), smelting, block and entity loot tables with tool conditions, and bartering. Regenerate whenever the server version changes.
- **L2 planner** built on that data:
  - acquisition strategies with cost estimates
  - a DEPS-style selector (nearest feasible, cheapest)
  - failure-weighted method choice
- **L3 goal tree:**
  - persisted across restarts and deaths
  - replanning, with no "active plan with nothing ready" state
  - a repeated goal resumes the existing one instead of being rejected
- **Maintenance goals** run by code policy: food, sleep, tool repair or replacement, storage at a base chest.
- **Task types from section 3 in the planner:** obtain, deliver, process, go/meet, storage, find/scout. Each has a typed spec, a planner expansion and a server verifier.
- **Task queue:**
  - priorities as in section 3
  - interrupt and resume
  - **ongoing tasks** (follow, guard) and **standing orders** (recurring checks between other work)
  - persisted with the goal tree
- **Control commands** answered by code: stop, cancel, pause, resume, status, queue.
- Fix or replace the plan cache: one instance, cached only after server-verified success, correct dependency IDs.
- **Done when:**
  - "get an iron pickaxe", "get 3 diamonds" and "get 10 obsidian" pass from a fresh world, judged by the server, with no LLM calls after intake
  - "bring me 10 cooked beef" (delivered, checked by the owner's inventory), "smelt the ores in that chest" and "find a village" pass with the owner simulator
  - stop/resume in the middle of a task works

### Phase 5: LLM strategist (1-2 weeks, overlaps Phase 4)
- Decision-point interface, intake, gates, recovery, exploration direction, budgets, caching (section 2).
- Replace the per-tick prompt loop entirely.
- **Intake for every task type** in section 3:
  - free text → typed task, with IDs validated against the vanilla data
  - grounding for "here", "this" and "my base"
  - clarifying questions when the request is ambiguous
  - a capability check, so it says plainly when a skill doesn't exist yet
- **Conversation:**
  - acknowledgement with its interpretation
  - progress reports
  - completion reports with server evidence
  - failure reports from the failure trail
- **Game questions** answered from the vanilla data (recipes, drops, smelting), with the bot's perception and memory for "what do you have" and "where are we".
- An offline decision test set: recorded decision points with known good answers, used to compare models and prompts. This includes intake cases phrased many different ways.
- **Done when:**
  - "beat the game" turns into the M1-M10 tree, and M1-M4 pass live with fewer than 30 LLM calls
  - help benchmark v1 (about 25 requests covering obtain, deliver, process, go, follow, guard, storage, find and questions) passes at least 90% over 3 runs, judged by the server

### Phase 6: Mid-game M3-M4, plus building and farming help (3 weeks)
- Armor and shields, food (hunting, cooking, wheat farm), bed placement and sleep.
- Base chest storage, caves with torches, strip mining at Y=-58 (rewrite `deepslate_branch`).
- Obsidian mining (wire `obsidian_harvester`) and **obsidian casting** (water on lava sources).
- **Builder:**
  - the LLM produces a blueprint (block list plus palette)
  - a material plan
  - build order: supports before overhangs, with scaffolding that's removed afterwards
  - verification block by block
  - repairs any block that didn't place
- **Region tasks:** clear, dig a tunnel, flatten, wall around. Player-placed blocks are tracked and protected, and the bot asks before breaking them.
- **Farming tasks:** crop farm layout with water, harvest-and-replant loops, animal breeding.
- **Storage tasks:** an index of chest contents, sorting chests, fetching a named item.
- **Standing orders:** keep the furnace fuelled, light up an area (torches until the light-level check passes), harvest when crops are ready.
- **Done when:**
  - M3-M4 pass unassisted on 3 seeds
  - "build a small house here", "make a wheat farm by the river", "light up my base", "sort my chests" and "clear this area" (with the confirmation flow) pass, judged by the server, with the owner simulator

### Phase 7: Nether M5-M7 (3 weeks)
- **Portal:** placement rewritten with reference faces, scaffolding and per-block checks; ignition with flint and steel; a server `changed_dimension` event as proof.
- **Dimension change:** handled on `respawn`; portal pairs saved to memory.
- **Nether movement:** lava treated as lethal in path costs, bridging over lava, ghast handling, gold armor around piglins.
- **Fortress:** a chunk sweep whose direction the LLM picks; arena-tested against `place structure minecraft:fortress`.
- **Blazes:** a safe fighting spot near the spawner; rods counted by RCON.
- **Pearls:** enderman hunting (with a canopy that can actually be placed) and bartering (walk to an adult piglin, one ingot at a time, wait about 6 s, collect). The LLM picks between them.
- **Done when:** M5-M7 pass from an M4 checkpoint world, then from scratch.

### Phase 8: Stronghold and End M8-M10 (3 weeks)
- **Finding the stronghold:**
  - throw an eye and track the `eye_of_ender` entity to get a direction
  - triangulate from two throws (reject intersections behind the bot)
  - score the result against `locate`, which the bot never sees
- **Getting in:** dig down in a staircase, search the corridors, fill the frames (fix the inverted metadata fallback), and verify `end_portal` blocks exist.
- **End:**
  - Find the fountain's real height.
  - Shoot crystals with a gravity-aware bow model, checking each crystal entity is gone.
  - Caged crystals: pillar up, break the bars, shoot from distance. Never melee a crystal.
  - Read the dragon's phase from entity metadata, and melee it while perched.
  - Void-edge safety.
  - Proof: the `end/kill_dragon` advancement.
- **Done when:** M8-M10 pass from checkpoint worlds, then **one full unassisted run** on one seed.

### Phase 9: Wider skills, any task, and hardening (ongoing, starting about 4 weeks)
- **More skills, each a task type with a server verifier:**
  - villager trading (`openVillager`)
  - enchanting table and anvil (enchant, repair, rename)
  - brewing, including fire-resistance potions for the Nether
  - boats and horses
  - fishing
  - basic redstone use: doors, levers, buttons, simple piston doors from a blueprint
  - nether-portal linking for travel
  - elytra, later
- **Macro skills:** sequences the LLM worked out and the server verified are saved as JSON over existing skills, never code. A repeated kind of request then needs no LLM after intake.
- **Help benchmark v2:** about 60 requests covering every task type, phrased many ways, including multi-step ones ("get me iron armor and then help me build a wall").
- **Survival benchmark:** progression tasks × several seeds.
- **Nightly runs:** both benchmarks run every night, recording success rate, time, deaths, LLM calls and cost. They are the regression gate.
- **Playtests with a real human** owner (you), with the timeline used to debug anything that confused the bot.
- **Soak tests:** 8+ hour runs with reconnects, deaths, server restarts and LLM outages, plus a mix of help requests and standing orders.

---

## 10. Production checklist (applies to every phase)
- Config validated at startup; secrets only in `.env`; no unused config keys.
- **Process supervisor** with crash recovery that resumes the goal tree and memory.
- Graceful reconnect, and death recovery (go back for items if it's safe).
- Structured logs with rotation; run folders kept under `logs/runs/<runId>/`.
- **LLM:** provider failover, timeouts, backoff, budgets, and a safe fallback when the LLM is unavailable.
- **Security:**
  - Only owners can give tasks.
  - Non-owner chat is untrusted data.
  - `[oracle]` chat is ignored.
  - No commands from the bot.
- CI: lint, full type-check, unit tests on every commit; skill tests on every change to skills; a nightly benchmark.
- **Docs:**
  - `STATUS.md` updated only from oracle results.
  - A short operator guide covering how to start the server kit, give a task and read a timeline.

---

## 11. Order and size
1. Phases 0 → 1 → 2 first (about 3-4 weeks). Without them, nothing after can be trusted or debugged.
2. Phase 3 (executor and owner interaction), then Phases 4 and 5 together (task system, planner and strategist).
3. Phase 6 (mid-game, building, farming), then 7 → 8 (Nether, End), each validated from checkpoint worlds first, then from scratch.
4. Phase 9 runs from then on.

Rough timeline for one focused developer:

| After | About | What a player can ask for |
| --- | --- | --- |
| Phase 3 | 6-7 weeks | come here, follow me, give me X, mine that, basic gathering |
| Phases 4-5 | 10-11 weeks | any obtain, deliver, process, find, guard or storage request in plain language, plus game questions, with progress reports and proof |
| Phase 6 | 13-14 weeks | build, clear and farm requests, standing orders, iron and diamond gear |
| Phases 7-8 | 5 months | "beat the game", unassisted, confirmed by the server |
| Phase 9 | ongoing | trading, enchanting, brewing, travel, redstone basics, and anything the benchmarks show is missing |

Help tasks and progression share every layer: each new skill makes both kinds of task stronger.
