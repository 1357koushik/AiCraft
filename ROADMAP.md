# AiCraft roadmap: an LLM brain with a Minecraft body

**The goal.** A player gives a task in plain words: "bring me 20 iron", "build a house here", "beat the game". The LLM decides the next step, AiCraft carries it out, and the series of steps finishes the task.

- **The LLM is the brain.** It decides what to do next, and it can change its mind at any point.
- **AiCraft is the body.** It gives the LLM what it needs to decide, carries out each decision in the game, and reports back what really happened.

**Two documents.** [CAPABILITIES.md](CAPABILITIES.md) is the catalogue of every kind of action and skill a player has in Minecraft 1.21.6 survival, derived from the game's own data. It is the centre of the plan. This roadmap explains how the LLM uses those capabilities and the order they are built in.

Revised 2026-11-11. This version replaces the earlier layered plan (reflexes, skills, planner, goal tree, strategist). Section 2 lists the logical flaws found in that plan and what replaces each one. Nothing in this document is implemented unless section 11 or Phase 0 says so.

---

## 1. The problem this design has to solve

An LLM cannot play Minecraft move by move, for three reasons:

| Constraint | The numbers |
| --- | --- |
| **Latency** | One call took 1.9 s in our own run. The game moves 20 times a second, so about 38 game ticks pass during one call. A creeper explodes 1.5 s after it starts to hiss |
| **Cost** | That call used about 4,000 tokens. One call every 2 s is 1,800 calls and about 7 million tokens per hour of play |
| **Number of actions** | The 30-second wooden pickaxe run already needed dozens of moves, block breaks and crafts. Beating the game needs hours of them |

This repo already shows what happens when the LLM is called on a timer. In the failed stone pickaxe run it was called 109 times in 15 minutes, picked one small action each time, repeated the same failing crafts, and got nowhere.

The opposite design also fails. When code does all the deciding and the LLM is only asked now and then, the bot is a script: it can do what was programmed and nothing else, and it has no answer when something unexpected happens.

**So the design question is where to cut.** The LLM must decide everything that needs judgement, and nothing that needs speed. Every decision it makes must buy a long stretch of useful game time.

---

## 2. Logical flaws in the previous plan

| # | Flaw | Why it matters | What replaces it |
| --- | --- | --- | --- |
| 1 | **It said "the LLM is the brain" but took the decisions away from it.** Code picked the next subgoal, and two phases were "done" only when the task ran with no LLM calls after intake | The plan was building a scripted bot with an LLM front door. That is the opposite of the goal | The LLM decides every step (section 4). Code is judged by how much game time each decision buys, not by how few calls there are |
| 2 | **Two deciders with no clear owner.** A code planner and an LLM strategist could both choose what to do next | This is the bug seen live: the code plan failed, the LLM took over a half-broken state, and neither could fix it | One decider. The planner becomes a tool the LLM reads and a skill the LLM can call (`obtain`), never a second brain |
| 3 | **"Done" was defined as "the server confirms it"** | That only works on our test server with RCON. On a real player's server the bot has no judge, so it could never finish a task | Done-conditions that AiCraft checks from its own view of the game. On the test server the oracle checks the same condition independently, and any disagreement is a bug (section 7) |
| 4 | **"Any task" needed a new task type in code for each kind of request** | Then it is not any task, only the fourteen kinds listed | No task types in code. A task is words, a done-condition and whatever skills exist. A new kind of request needs new skills only when the body can't yet do the motions |
| 5 | **The brain came last.** The LLM loop was Phase 5, after a full planner and goal tree | Five phases of body would be built before learning what the brain actually needs from it | The full loop is built early and proven on a spread of small tasks from different families, then widened (section 10) |
| 6 | **Nothing said what the LLM is shown.** The plan listed decision points but not the information given at each | A decision can only be as good as its inputs. Today's prompt gives nearby blocks and a list of 24 actions, and the LLM can't tell what is possible or what is missing | The decision brief (section 5), designed as the main interface of the whole system |
| 7 | **Nothing covered the time the LLM spends thinking, or a reply that arrives after the world changed** | The bot would stand still in the open for two seconds, or act on a stale answer | Holding behaviour while waiting, and every step re-checked against the world at the moment it starts (section 4) |
| 8 | **No arithmetic on reliability.** Skills were to pass "10 of 10" and tasks were expected to follow | A 20-step task with skills that each work 95% of the time finishes only 36% of the time. Without recovery, long tasks cannot work, however good each skill is | Recovery is part of the loop, not an add-on. Every failure returns to the LLM with a cause it can act on (sections 3 and 4) |
| 9 | **No way to tell a bad decision from a bad execution** | When a run fails, nobody knows whether to fix the prompt or the code | Every failed run gets one label: body, brief or brain (section 8). The body and the brain are also tested apart |
| 10 | **Tooling before a working bot.** Dashboards, replay and arenas for every skill were scheduled before the first reliable pickaxe | Arenas would be built for skills that are about to be rewritten | Tooling is built when a failure needs it. The existing run folder was enough to explain the stone pickaxe failure |
| 11 | **A timeline with nothing behind it** | "Five months to beat the game" came from no measurement. Three weeks have produced one judged wooden pickaxe | No dates until Phases 1 and 2 close. Then estimate from how long those really took |
| 12 | **It was organised along the survival progression:** stone, iron, Nether, End, with other tasks added on | That makes it a plan to beat the game. A bot built that way can only do what lies on that path | Organised by what the body can do. Section 3 defines what "every possible task" means and how it is covered, and the phases follow capability families. Beating the game is one benchmark task among many |
| 13 | **Coverage was argued from example tasks.** The matrix listed thirteen families that someone thought of | Any request outside the examples had no place in the plan | The catalogue is derived from the game itself: the inputs a client can send, the 25 windows, the 7 recipe types, the block, item and entity lists. A task nobody thought of is still a combination of catalogued capabilities |
| 14 | **"Game knowledge is complete" was false.** The data export was treated as everything there is to know | Brewing, villager trades, enchanting rules and mob-building patterns (snow golem, iron golem) are not in it. The bot could not build a golem from data alone | Four knowledge sources with clear roles, including a hand-checked mechanics book (CAPABILITIES.md section 5) |
| 15 | **Every task was assumed to end by reaching a state** | "Help me fight until I say stop" has no finish condition, and "keep the furnace fuelled" never ends | Thirteen task shapes, each with its own way of ending (CAPABILITIES.md section 33) |
| 16 | **Large designs were one block list from the LLM** | An Eiffel tower is tens of thousands of blocks. It cannot fit in a reply or be finished in one session | Designs written as shapes in layers, a bill of materials worked out by code, and progress saved per section (CAPABILITIES.md section 32) |
| 17 | **Nothing covered preparation or the risk of losing things.** The plan went straight from a goal to steps | Guides for human players spend more time on what to bring, what to leave behind and where to set the spawn point than on any fight. A bot that walks into the Nether carrying everything loses everything | Kit checklists, stashing, scouting light and spawn-point placement, with code supplying counts and the LLM deciding (CAPABILITIES.md section 30) |
| 18 | **Plans assumed things happen for certain** | Drops and breakage are chances. Twelve eyes of ender are not enough when about one throw in five breaks one | Odds come from loot tables and the mechanics book, and the brief shows expected counts and a margin |
| 19 | **Knowledge had rules but no techniques, and no edition filter** | Knowing that endermen are three blocks tall is not the same as knowing to stand under a two-block ceiling. And guides mix Java with Bedrock and old versions with new | A tricks book of techniques, each tagged Java 1.21.6 and added only after it passes on our server (CAPABILITIES.md section 31) |
| 20 | **The LLM was expected to design farms and redstone machines** | These depend on exact positions, facings and timings. Players publish them as step-by-step recipes and schematic files because they cannot be improvised. An LLM design would look right and yield nothing | A design library of known-good builds, schematic import, a site survey, and a yield measurement after building. The LLM chooses and adapts; it invents only where exactness doesn't matter |
| 21 | **"Built" was treated as "works"** | A farm with every block in place can still produce nothing: wrong biome, a village too close, the player standing in the wrong spot | Machines are judged by measured output, and the standing spot and site conditions are part of the design |
| 22 | **No policy on glitches or on fighting players** | Both are things players do. Duplication machines may be fixed, blocked or against a server's rules. Fighting players had only a flat "never" | Glitches are catalogued, off by default, and switched on by the owner in config. Fighting players is decided by the task: the bot fights the players the owner's task names, and never attacks a player without such a task |
| 23 | **No sense of cost over time** | For 10 iron, mining is right. For 2,000, an iron farm is. The plan had no way to tell the two apart | Code estimates gathering by hand against building a farm, and the LLM chooses (CAPABILITIES.md sections 16 and 30) |

---

## 3. The three clocks

Everything in AiCraft runs on one of three clocks. This is the cut from section 1.

| Clock | Runs | Who | What it does |
| --- | --- | --- | --- |
| **Reflex** | every game tick (50 ms) | code | Keeps the bot alive: get out of lava, swim up, eat, block or flee, stop before a fall. Pauses the current skill, then lets it resume |
| **Skill** | seconds to minutes | code | Carries out one step the LLM chose, such as "mine 3 stone" or "go to the owner". Runs its own closed loop: act, look, correct. Stops as soon as it succeeds, fails or cannot make progress |
| **Decision** | when something needs deciding, roughly every 30 to 120 s of play | LLM | Reads the brief and chooses the next steps |

The LLM is never on the reflex clock and never inside a skill. Code never decides which step comes next.

### What a skill must guarantee
The LLM can only plan with steps it can trust. Every skill keeps this contract:

1. **Checkable preconditions.** Code can say before starting whether the skill can run ("needs a pickaxe of stone tier or better", "needs 2 sticks").
2. **It verifies its own result** by reading the inventory or the world after acting. Returning without an error is never treated as success.
3. **It stops on no progress**, not on a fixed timer. A progress watchdog replaces arbitrary time and distance caps.
4. **It can be paused and resumed** by a reflex without counting as a failure.
5. **It returns a result the LLM can act on:**
   - `status`: done, partly done, failed or interrupted
   - what changed: items gained and lost, blocks placed or broken, distance moved
   - on failure, a `cause` from a fixed list: `missing_item`, `missing_tool`, `not_found_nearby`, `unreachable`, `blocked`, `too_dangerous`, `interrupted`, `no_progress`, `inventory_full`
   - what would fix it, when code knows: "needs 2 more sticks", "nearest known stone is 40 blocks east"

### Three layers, so that no task is out of reach
| Layer | What it is | Speed |
| --- | --- | --- |
| **Actions** | Every input a survival player has: look, step, break, place, use a block, an item or an entity, click in a window, write, chat. The game client can send only about 25 kinds of message that matter in survival, and the action layer covers all of them | One small thing per step. Slow, but always possible |
| **Skills** | One purpose each, written once against game data so it works for every block, item, recipe, window or mob of its kind. They range from `mine` and `craft` to long ones like `obtain`, `travel_to` and `build` | Seconds to minutes |
| **Reflexes** | Skills that fire on their own to keep the bot alive | Within a tick |

The LLM may use actions or skills in a step plan. It normally uses the highest one that fits. A long skill returns to the LLM at the first real choice: `obtain(stone_pickaxe)` works out the chain from game data and runs it, but if there is no stone nearby it stops and says so. This is where the old code planner now lives, as the inside of `obtain`.

### Every type of task
**[CAPABILITIES.md](CAPABILITIES.md) is the full list.** It covers:
- the complete action layer and what the body can sense
- 25 skill groups, one per game mechanic or kind of work: moving, breaking, placing, using blocks, the 25 windows, making things, using items, living with mobs, fighting, staying alive, farming, enchanting, brewing, redstone, exploring, storage, working with players, design work, liquids and explosives, shaping the land, staying unnoticed, watching and reporting, waiting and timing, preparing for a trip, and techniques
- the world rules every plan depends on, such as only loaded chunks running
- where game knowledge comes from, including what the data export does not hold
- how large tasks and open-ended tasks work

Why this covers tasks nobody listed:
1. **The action layer is complete,** so any task a player could do can be attempted, even with no skill for it.
2. **Skills are generic, not per item.** `craft` handles a piston as well as a pickaxe.
3. **Knowledge has a source for every kind of fact,** and facts the data lacks (how to build a golem, how to brew) go in a checked mechanics book.
4. **Skills grow where actions are too slow.** A sequence the LLM keeps using is saved as a procedure (data, never code), and the common ones become skills.

**The one hard rule on what must be a skill:** anything where a late or wrong move costs health or items. Each action is a step, and a failed step is a round trip to the LLM. Fighting, falling, lava and fast travel cannot wait for that.

### The body must be reliable before the brain is blamed
A skill is offered to the LLM only after it passes its arena test (section 8). Until then it is not in the catalog.

---

## 4. The decision loop

```
 task arrives ──► brief built ──► LLM replies with a step plan ──► steps run one by one
                      ▲                                                   │
                      └──────────── a return trigger fires ◄──────────────┘
```

### The LLM's reply: a step plan
The LLM answers with a short list of steps, not one action. Each step is one skill call with its arguments. Example for "craft a stone pickaxe" from an empty inventory:

```json
{
  "notes": "No tools yet. Wood first, then a wooden pickaxe, then stone.",
  "steps": [
    { "skill": "chop_tree", "args": { "count": 3 } },
    { "skill": "craft", "args": { "item": "oak_planks", "count": 12 } },
    { "skill": "craft", "args": { "item": "crafting_table" } },
    { "skill": "craft", "args": { "item": "stick", "count": 4 } },
    { "skill": "craft", "args": { "item": "wooden_pickaxe" } },
    { "skill": "mine", "args": { "block": "stone", "count": 3 } },
    { "skill": "craft", "args": { "item": "stone_pickaxe" } }
  ],
  "done_when": { "inventory": { "stone_pickaxe": ">=1" } }
}
```

That is **one call for the whole task** when nothing goes wrong, where the current loop used 109 and failed. Once `obtain` exists, the same plan is a single step.

Rules for step plans:
- **A plain list.** No loops or branches. Repetition lives inside skills as counts. A branch is a return to the LLM.
- **Data, never code.** Skill names and arguments are validated against the catalog and against real item and block IDs before anything runs.
- **Each step is checked at the moment it starts.** If its preconditions no longer hold, the plan stops and returns to the LLM. This is what makes it safe to plan several steps ahead, and it is how a stale reply is caught.
- **An invalid reply gets one repair round** with the exact validation error. If it is still invalid, the bot holds and reports.

### Return triggers: when the LLM is asked again
The LLM is called because something happened, never because time passed.

| Trigger | Example |
| --- | --- |
| The plan finished | All steps done; check `done_when` |
| A step failed or was only partly done | `mine` returned `not_found_nearby` |
| A step's preconditions don't hold | The crafting table is gone |
| Something serious happened | Death, heavy damage, lost items, pushed far off course |
| The owner spoke | A new request, or an answer to a question |
| A watched-for discovery | The LLM asked to be told when a village or a cave is seen |
| No progress for a long stretch | A review, so a long task doesn't drift |

Reflexes that end well (ate food, dodged a creeper, climbed out of water) do **not** call the LLM. They appear as one line in the next brief.

### While the LLM is thinking
- If steps remain, the body keeps running them.
- If there is nothing left to run, the body uses a **holding behaviour**: stay put, defend itself, eat, step out of danger. It never stands frozen.
- Reflexes run the whole time.

With one decision per 60 s of play and 2 s per call, the bot spends about 3% of its time waiting.

### Things code answers without the LLM
`stop`, `cancel`, `pause`, `resume`, `what are you doing?` and anything on the reflex clock. These must work even when the LLM is slow or down.

---

## 5. The decision brief: what the LLM is shown

The brief is the main interface of the whole system. Showing the LLM "what the player sees" is not enough. It has to be shown **what matters for the decision**, already worked out by code.

| Part | Content | Why |
| --- | --- | --- |
| **Task** | The owner's words, the `done_when` condition, and how far along it is | Keeps the goal in view |
| **Task notes** | The LLM's own running notes and sub-goals, stored by code and handed back each time | Its working memory across calls |
| **Why it is being asked** | Which trigger fired | So it answers the right question |
| **Last steps** | Each step since the last call: result, what changed, failure cause, suggested fix | Lets it react to what really happened |
| **State** | Health, food, position, dimension, time of day, held item, armor | Risk judgement |
| **Inventory** | Counts, grouped (tools, blocks, food, materials) | What it has to work with |
| **What is missing** | For the current goal, worked out from game data: "stone_pickaxe needs 3 cobblestone (have 0, needs any pickaxe to mine: have none) and 2 sticks (have 0, craftable from 2 planks: have 4)" | The LLM never has to do recipe arithmetic or guess what a failure meant |
| **What is possible now** | Skills whose preconditions hold, items craftable right now, and nearby resources with distance and direction | Stops it choosing steps that cannot run |
| **Known places** | From memory: base, chests and their contents, ore seen earlier, portals, the last death point | Lets it choose where to go |
| **Dangers** | Hostile mobs nearby, lava, night coming, low food | Risk judgement |
| **Kit and odds** | Before a trip: what it needs against what is held, what would be lost on death, and expected yields where chance is involved ("8 blaze rods needs about 16 kills") | Preparation and risk are the LLM's call, but only if it can see the numbers |
| **Techniques** | The few tricks-book entries that fit the situation | The LLM may not know them, or may know a version that no longer works |
| **Journal** | Short lines for what was already tried for this goal and how it ended | Prevents repeating a failed approach |
| **Budget** | Calls and tokens used and left for this task | Lets it be economical |

Rules for the brief:
- **Small and fixed in shape.** The target is about 1,500 tokens for the changing part. Details stay out unless they are relevant to the current goal.
- **Stable part first.** The rules and the skill catalog come first and never change within a task, so the provider can cache them. The changing state comes last.
- **Facts come from code, not from the LLM's memory.** Recipes, drops and tool tiers come from the game data export. Rules the export lacks come from the mechanics book. When the LLM states a fact that code can check, code checks it and corrects it.
- **The LLM can ask for more** with look-up tools that cost no game time: `recipe(item)`, `requirements(item, n)`, `find_known(thing)`, `scan(block or entity, radius)`. At most two look-up rounds per decision, so a decision stays fast.
- **Never include the oracle's output or `[oracle]` chat lines.** The bot must not learn about the world from the judge.

---

## 6. Staying on track through a long task

### Task notes
The LLM keeps a short structured note per task: the sub-goals, which are done, and what it plans next. Code stores it, hands it back in each brief, and attaches measured progress to each sub-goal. For "beat the game" the note holds the milestones; only the current one is shown in detail and the rest are one line each. This keeps the brief small after hours of play.

### A progress measure the LLM does not control
For any goal with an item target, code counts **how many requirements are still missing** using the game data. The number must go down over time. For other goals the measure is the done-condition itself (blocks still to place, distance still to cover).

### The loop-breaker
- If the LLM sends a step that already failed with the same cause and nothing relevant has changed, code refuses it and says why.
- If progress has not improved after a set number of decisions, the next call goes to the stronger model with the full journal. If that also fails, the bot stops and tells the owner what it tried.

This is the guard against the behaviour seen live: craft, fail, chop, craft, fail, for 15 minutes.

### Memory
| Kind | What it holds | Used for |
| --- | --- | --- |
| **Places** | Named places, resources seen, structures, portals, death points | "Known places" in the brief; long travel |
| **Containers** | What is in each chest it has opened | Storage and fetch tasks |
| **What worked** | Step plans that finished a goal, keyed by goal | Offered in the brief as "this worked before". The LLM may reuse or change them. Stored as data, never code |
| **What failed** | Places and approaches that ended badly | Journal lines in later tasks |

### Budgets and model choice
- Each task has a call budget and a token budget, sized from the task. When a budget runs out, the bot stops safely and reports. It does not carry on blind.
- **Two model settings in config:** a fast model for routine "next steps" decisions, and a stronger one for taking in a complex task, for recovery after repeated failure, and for reviews. Both are provider-agnostic.
- **If the LLM is unreachable:** the body finishes the steps it has, then holds safely and tells the owner.

Starting targets, to be replaced by measurements after Phase 2:

| Measure | Target |
| --- | --- |
| Game time bought per decision | 30 s or more on average |
| Calls for "craft a stone pickaxe" | 3 or fewer (median) |
| Time spent waiting for the LLM | under 5% of the run |
| Calls made on a timer | zero |

---

## 7. Knowing when a task is done

A task carries a **done-condition** written in a small fixed vocabulary that code can check:

| Check | Example |
| --- | --- |
| `inventory` | bot has `stone_pickaxe >= 1` |
| `player_inventory` | owner gained `bread >= 10` |
| `block_at` / `region` | every block of the blueprint is in place; the area is all air |
| `container` | the chest at x y z holds `iron_ingot >= 20` |
| `near` | bot within 3 blocks of the owner; held for 5 minutes for "follow me" |
| `entity_count` | at least 2 cows within 10 blocks |
| `advancement` | `end/kill_dragon` |
| `answered` | the question got a reply (for pure questions) |

- The LLM writes the done-condition when it takes the task in, and tells the owner its interpretation: "Getting 16 iron ingots and bringing them to you."
- **In play, AiCraft checks it** from what the bot can observe. Only code can mark a task done. The LLM cannot declare success.
- **On the test server, the oracle checks the same condition** from server-side evidence, independently of the bot.
- **A disagreement is a bug.** If AiCraft says done and the server says no, that is a false success, counted in every benchmark. The target is zero.

**Not every task ends by reaching a state.** "Help me fight until I say stop" ends when the owner says so, "keep the furnace fuelled" never ends, and "collect 20 eyes of ender" is a counter. CAPABILITIES.md section 33 lists the task shapes and how each one ends. The LLM picks the shape when it takes the task in.

Some conditions can't be fully seen by the bot (the owner's inventory, for instance). There AiCraft uses the best evidence it has (it tossed 10 bread, and the items were picked up) and says so in its report.

---

## 8. Testing: body, brain, and both together

| Test | What runs | What it proves |
| --- | --- | --- |
| **Body alone** | A hand-written step plan, in the same format the LLM produces, run on the real server with no LLM | The skills work. Failures here are body bugs, with no LLM noise |
| **Skill arenas** | One skill in a small prepared world, including cases where it must fail with the right cause | The skill contract holds, including honest failure |
| **Brain alone** | Saved briefs replayed to the LLM offline, with no game | Decisions are sensible, valid and stable across prompt or model changes. Fast and cheap to run |
| **Together** | A task in plain words on a fresh seeded world, judged by the server | The whole loop works |
| **Unit** | Pure logic only: parsers, validation, requirement maths over real game data | No mocked game behaviour |

### The task matrix
The matrix is a sample of the catalogue, not the definition of what the bot can do. STATUS.md also carries one row per catalogue group and per window kind, marked not built, built, or passing. The benchmark is a matrix, not a ladder. Every family has tasks at three sizes. Each phase turns cells green in several families, never one showcase task.

| Family | Small | Medium | Large |
| --- | --- | --- | --- |
| **Obtain** | 4 planks | iron pickaxe | diamond armor, 12 ender pearls |
| **Process** | smelt 8 ore from a chest | cook all the meat, refuelling as needed | brew fire-resistance potions |
| **Deliver / storage** | put everything in that chest | bring me 10 bread | sort my chests |
| **Go / find** | go to x y z | come to me across a river | find a village |
| **Build / place** | a 3-block pillar | a 5×5 hut with a door | a house from a described design |
| **Dig / clear** | break that block | a 2×1 tunnel 20 long | flatten this hill |
| **Farm / animals** | plant these seeds | a watered wheat plot | breed cows to 10 |
| **Fight / protect** | kill that zombie | guard me for a night | clear a spawner room |
| **Interact** | flip that lever, open the door | trade for a book | enchant and repair my sword |
| **Standing orders** | follow me | keep the furnace fuelled | light up the base at night |
| **Questions** | how many logs do you have? | how do I make a piston? | what should we do before the Nether? |
| **Progression** | get a stone pickaxe | reach the Nether | beat the game |
| **Cannot do** | a request needing a missing skill: the bot must say so | | |

Each cell names its done-condition and is run across seeds. STATUS.md shows the matrix with a pass rate per cell, so it is always clear which families work and which don't.

### One label for every failed run
| Label | Meaning | Fix goes in |
| --- | --- | --- |
| **Body** | A skill broke its contract: wrong result, false success, hang | The skill |
| **Brief** | The LLM decided badly because information was missing or wrong | The brief builder |
| **Brain** | The brief was correct and sufficient, and the decision was still bad | The prompt, the model, or the step vocabulary |

The label is assigned from the run folder by a person or a review script, and STATUS.md tracks the counts. Without it there is no way to know what to work on next.

### What every judged run records
Verdict, game time, deaths, LLM calls, tokens, cost, game time per decision, time spent waiting, false successes, loop-breaker activations, and commands detected.

### Rules
- **Nothing is called working below 5 judged runs**, and the pass rate is always shown.
- **Three gates for every new ability:**
  1. the skills pass their arenas, 10 of 10
  2. a hand-written step plan passes on 3 seeds
  3. the tasks in plain words that use it pass at least 9 of 10 across 3 seeds, within their call budgets
- **No phase closes on one task.** Each phase names the matrix cells it must turn green, drawn from several families.
- **Setup may use commands; the measured part may not.** The oracle already enforces this.
- **Tooling is built when a failure needs it.** The trace, the discrepancy detector (bot belief against the server read) and the brief log come with Phase 2. The HTML timeline, replay bundles and dashboard wait until a failure can't be explained without them.

---

## 9. Working with the owner

- **Who can give tasks:** only configured owners. Everyone else's chat is information, never instructions.
- **Understanding the request:**
  - "here", "me": the owner's position
  - "this", "that chest": the block or entity under the owner's crosshair, worked out by code and given to the LLM in the brief
  - "my base", "home": named places from memory
  - if still unclear, the LLM asks one question
- **What the owner hears:**
  - an acknowledgement with the interpretation
  - progress at sub-goal boundaries
  - a completion report with evidence
  - a failure report built from the journal: what was tried and why it failed
- **Honest limits:** the LLM sees the skill catalog. If a request needs motions the body doesn't have, the bot says so.
- **Several requests:** code runs a queue. Safety comes first, then direct commands (`stop`, `come here`), then the current task, then standing orders. The LLM is asked only when requests truly conflict.
- **Protection rules, enforced by code whatever the LLM says:**
  - never attack an owner, a listed friend, pets or villagers
  - attack another player only when the owner's task calls for it and names who
  - never break blocks a player placed without a yes
  - never take from the owner's chests unless asked
  - never run server commands
  - large or destructive jobs are confirmed first

Appendix D lists example requests with the done-condition and skills each needs.

---

## 10. Phases

Each phase is closed by the three gates in section 8. No dates are given: estimate after Phases 1 and 2, from how long they actually took.

### Phase 0: The judge · built 2026-11-09, re-checked 2026-11-11
`npm run task` runs the real agent on a fresh seeded world and judges it from server evidence only. Its four verdicts were re-derived from the raw logs and world files, and they stand.

Known gaps, each picked up in the phase that needs it:
- it has judged only four runs
- it checks bot inventory, advancements, stat increases, final dimension and deaths, and nothing else
- items in an open crafting grid or on the cursor are not counted
- no repeat runs, and no record of LLM calls

### Progress as of 2026-11-27 (later the same day)
- **Phase 1:** done except the arenas for every skill and pillaring in chop_tree. Skills on the contract: craft, mine, chop_tree, collect_drops, go_to, place, equip, eat, store, take, use_station, use_block, inspect_container. Reflexes with pause and resume. The judge checks blocks, regions, containers and position. The coverage check maps all 564 registry entries with no gaps. Two Mineflayer bugs fixed (entity_action ids, enchantments).
- **Phase 2:** the decision loop runs; the three-seed suite of nine families passes 28 of 30, and "craft a stone pickaxe" 6 of 6 at a median of 4 LLM calls (target was 3).
- **Phase 3:** `obtain` passes stone pickaxe and iron ingots from nothing on three seeds. Not started: explore_for, long-distance travel, places memory.
- **Phase 4:** owner simulator, come_to, follow, give, and owner-inventory and stay-near checks; the three owner tasks pass on three seeds. Not started: chat intake, the task queue, guard, standing orders.

### Phase 1: A complete, trustworthy body · mostly done

Progress as of 2026-11-27:
- **Done:** game data export and loader (`data/vanilla/1.21.6/`); skill contract and step-plan runner (`src/skills/contract.ts`); crafting fix, proven by a stress reproduction (0 of 20 loops lost items, against 5 of 6 before) and 9 of 9 live stone pickaxe passes; repeat runs with a pass-rate table; inventory packet trace; one-run-at-a-time harness lock; leftover verification code removed.
- **Not started:** the action layer audit against Mineflayer; the coverage script; the basic skills rewritten against the contract; `use_station`; arenas; reflex pause and resume; block, region and container checks in the oracle; removing the `_isMockFunction` check.
- **Found on the way:** preempting an action does not stop it (Mineflayer calls cannot be cancelled), so two actions can drive the bot at once. Crafting now holds an inventory lock; the other skills need the same protection when they are rewritten against the contract.

**Catalogue:** sections 3 (all actions), 4 (senses), 6 (on foot, making a way), 7, 8 (placing, without designs), 9, 10 (crafting, furnaces, containers), 11 (all recipes).

The action layer in full and the basic skills, all driven by game data and all tested with no LLM involved.
- **Check the game data into the repo.** It was exported once on 2026-11-11 to confirm the counts; make the export a repeatable script. It holds: recipes with all variants and tags, smelting, block and mob drops with tool conditions, loot tables. Every skill reads from it.
- **The action layer,** checked action by action against Mineflayer 4.39. Gaps are written down.
- **The coverage script:** every statistic, advancement trigger, block kind, window kind and entity type in the export must map to a catalogue group or be marked not reachable in survival. The check fails on anything unmapped.
- **The skill contract** from section 3, and the step-plan runner (it runs a hand-written plan file).
- **Basic skills, written once against the data:** `go_to`, `mine`, `craft`, `use_station`, `place`, `collect_drops`, `equip`, `eat`, `store`, `take`, `chop_tree`.
- **Fix crafting first.** Almost every family uses it and it loses items today. Reproduce the live failures before changing anything: sticks that came out as 0, the 16 `updateSlot` timeouts, logs used up with nothing produced, the `oak_button` crafted by mistake. After every craft, confirm that nothing is left in the grid or on the cursor.
- **Honest failure:** each skill returns the right cause when it cannot succeed.
- **Reflexes pause and resume** a skill and don't fail it. Fix the time the bot spent underwater (236 m in the failed run).
- **Harness:** repeat runs across seeds with a pass-rate table; crafting-grid and cursor items in the inventory read; block, region and container checks in the oracle.
- **Remove what this replaces:** the leftover verification code listed in section 11, and the `_isMockFunction` check in `navigator.ts:474`.

**Done when:**
- **each basic skill passes its arena on a sample drawn from the data, not on one item:**
  - `craft`: 40 recipes covering 2×2, 3×3, shaped, shapeless and tag ingredients
  - `mine`: blocks from every tool type and tier
  - `place`: full blocks, slabs, stairs, torches, doors, beds, buckets
  - `use_station`: furnace, smoker, blast furnace, stonecutter
  - each skill's failure cases return the right cause
- hand-written step plans pass 10 of 10 on 3 seeds for the Small column of Obtain, Process, Storage, Go, Build and Dig
- one task is done with actions only (flip a lever, open a door and walk through)
- no run loses items

### Phase 2: The decision loop, proven across families
**Catalogue:** section 33 task shapes: reach a state, reach a quantity, a question, find out and report, unclear, not possible, not allowed. Section 27 (look and tell).

The whole design from sections 4 to 7.
- **Brief builder** with every part in section 5, reading from the game data.
- **LLM client:** step-plan replies, validation, one repair round, budgets, two model settings, look-up tools.
- **Return triggers, holding behaviour, task notes, journal, progress measure, loop-breaker.**
- **Done-conditions:** `inventory`, `block_at`, `region`, `container`, `near`, `answered`.
- **Task handed over before the loop starts.** Today it arrives 2 s late and the run opens with a wasted call.
- **Remove what this replaces:** the once-a-second prompt loop, the hand-written goal plans in `goals.ts`, the failure cascade, and the plan cache.
- **Every judged run records** the measures in section 8, and failed runs get their label.

**Done when:**
- the Small column of the matrix passes in plain words for Obtain, Process, Storage, Go, Build, Dig, Interact, Questions and Cannot-do: at least 9 of 10 each across 3 seeds, within budget
- no call is made on a timer
- **recovery works:** from starts built to make the first plan fail (no tree in range, a full inventory, a missing tool), the LLM gets the cause and still finishes
- **the LLM going down mid-run** leaves the bot holding safely with a clear message
- false successes: zero

### Phase 3: Getting anything, going anywhere
**Catalogue:** sections 5 (mechanics book and tricks book started), 6 (long distance, boats, trails), 11 (chains and every way to get an item), 20 (finding things), 21, 28, 29, 30 (kits, margins for chance), 31.

- **The mechanics book,** with the entries `obtain` needs first: villager trades, bartering, fishing, mob drops that need a condition.
- **`obtain(item, n)` for any item,** choosing among every way the data offers: craft, smelt, mine, mob drop, chest loot, trade, barter, fish, farm. It returns to the LLM when the choice is a matter of judgement.
- **`explore_for`, `travel_to` over long distances,** boats and swimming, hunting for food.
- **Places memory,** and an index of blocks the bot has seen.
- **Remove the distance and count caps** in Appendix B as each skill is rebuilt.

**Done when:** the Medium column passes for Obtain, Process, Go/find and Dig, and a typical run spends 30 s or more of game time per decision.

### Phase 4: Working with an owner
**Catalogue:** sections 22 and 27 (scout, watch and warn, recall), and the remaining task shapes: until told to stop, standing order, when something happens, watch for something, a sequence.

- Chat intake, grounding of "here" and "this", acknowledgements and reports (section 9).
- **Skills:** `come_to`, `follow`, `give`, `guard`, `stay`.
- **Done-conditions:** `player_inventory`, and `near` held over time. The oracle gets the same checks.
- Task queue, standing orders, and control commands answered by code.
- **Owner simulator:** a second scripted client that plays the human in tests. It is a test actor, never a judge.

**Done when:** the Small and Medium columns pass for Deliver/storage and Standing orders, plus "come here", "stop" in the middle of a task, and two requests given at once.

### Phase 5: Staying alive through long tasks
**Catalogue:** sections 12 (using items), 14 (every overworld mob, terrain against mobs, supporting a fighter), 15 (including the death log), 24, 26, 30 (stashing, scouting light, spawn point).

- Night, shelter and beds, armor and shield, fighting and fleeing, food upkeep, tool replacement.
- **Melee at tick level** inside the fight skill: sprint reset, spacing, critical hits, sweeps. Checked by damage dealt and taken against each mob in an arena.
- **Line-of-sight sense:** which mobs can see the bot.
- **Death recovery:** go back for items when it is safe.
- **Long-run context:** task notes with sub-goal summaries, and review calls.
- Caves, torches, mining at depth, lava safety.
- **Soak test:** hours of play with reconnects and LLM outages.

**Done when:** the Small and Medium columns pass for Fight/protect, the Large column passes for Obtain, and a 2-hour soak run of mixed requests ends alive with the task notes intact.

### Phase 6: Changing the world
**Catalogue:** sections 8 (designs, mob-building patterns, beacons and conduits, decoration), 16, 19, 23, 25, 32.

- **The design language** of shapes and layers, the bill of materials, and saved progress per section, for builds too large for one reply or one session.
- **Golems and the wither** from the mechanics book, confirmed by the server's `summoned_entity` event.
- **The design library and schematic import:** first entries are an item sorter, an automatic smelter, a villager breeder, a trading hall, a crop farm and a mob drop tower. Each records its site conditions, how to operate it and its measured yield.
- **Site survey** against a design's conditions, and a **yield measurement** after every machine is built.
- **Redstone from the library,** tested by operating it.
- **`build(blueprint)`:** the LLM writes the block list, code places it in a workable order and checks every block.
- **`clear(region)`** and digging, with player-placed blocks protected.
- **`farm`,** breeding, storage sorting and fetching.
- **Done-conditions:** `entity_count`, and blueprint checks. The oracle gets the same checks.

**Done when:** the Medium and Large columns pass for Build, Dig/clear, Farm/animals and Deliver/storage; "build a snow golem" and "build 3 iron golems" pass; a farm from the library is built from a plain request, and its measured yield is within the range the library records; and a build of at least 2,000 blocks from a described real-world shape is finished across a restart.

### Phase 7: Every interaction a player has
**Catalogue:** sections 10 (the nine windows with no dedicated Mineflayer call), 13 (including moving and raising mobs, villages), 17, 18, and "earn an advancement" as a task shape.

- Villager trading, enchanting, anvils, brewing, smithing, taming and riding, fishing, basic redstone (levers, doors, pistons from a blueprint).
- Most of these are `use_station` and `use_on_entity` with new windows, so this phase is mainly data and arenas.

**Done when:** all three columns pass for Interact and Process, and Large passes for Questions.

### Phase 8: Other dimensions and structures
**Catalogue:** sections 6 (portals, mounts, elytra), 14 (Nether and End mobs, bosses, raids), 20 (all 34 structures).

- Portal building and lighting, dimension change, lava-aware travel in the Nether.
- Finding structures: fortress, bastion, stronghold, village, and what each is for.
- Blazes, ender pearls by hunting or bartering, eye-of-ender triangulation, end crystals, the dragon fight, the way home.
- The late-game code in `src/dimensions/` is not connected and mostly reports success without checking, so it is rewritten against the skill contract rather than wired in.

**Done when:** "collect 20 eyes of ender" passes; the Progression row passes in all three columns, from prepared checkpoint worlds first, then "beat the game" once from a fresh world, unassisted, with the `end/kill_dragon` advancement as proof.

### Phase 9: Hardening
- **Review how people play** before each remaining area is closed: read guides and video transcripts for it, as was done for survival on 2026-11-11, and add what is missing to the catalogue.
- **Every catalogue group and every window kind is marked passing** in STATUS.md, or listed as a known limit with the reason.
- The full matrix runs every night across seeds, with pass rate and cost per cell. It is the regression gate.
- Procedures the LLM built from actions are reviewed, and the common ones become skills.
- Playtests with a real owner. Requests collected from those sessions are added to the matrix.

---

## 11. What is true today (verified 2026-11-11)

### The bot
| Area | Real state |
| --- | --- |
| Wood → wooden pickaxe | **1 judged PASS, 1 failure, same seed.** `run_20261109_135152_wooden_pickaxe` passed in 30 s. In `run_20261109_135253_stone_pickaxe` the bot needed a wooden pickaxe first and never made one in 15 minutes. Even the passing run crafted an `oak_button` by mistake |
| Wooden → stone pickaxe | **0 of 1 judged runs.** Stone pickaxes were crafted on 2026-10-23 in two old worlds, in runs with no command detection and before the planner was rewritten (commit `15cacb8`) |
| Why the stone run failed | In order: the hand-written plan's first task was a bare `craft_item wooden_pickaxe` with no wood (`goals.ts:500-506`); the failure cascaded and the plan never recovered (`goals.ts:816-819, 923`); the LLM made 109 one-action calls; crafting lost items (24 logs picked up by the server's count, 1 left, no sticks, no pickaxe) |
| Iron | Smelted live only with items handed over by `/give` |
| Shelter | Failed live (3 of 23 blocks) |
| Diamonds and later | Never run live |
| Nether / stronghold / End code | Not imported by the running bot. Most of it reports success without checking |
| LLM role today | Called about once a second when the code plan has nothing ready. It picks one action from 24 and sees nearby blocks and the last 8 results |
| Tests | 518 pass in 43 files; 35 of the files use fake bots. All 518 passed on the commit that failed the stone run. `src/` type-checks clean |
| Leftover verification code | About 12,000 lines that the harness replaces: `src/contracts/`, `src/campaign/`, `src/runner/`, `observer-plugin/`, `tools/vanilla-observer/`, and their npm scripts |

### The server (`server/`, tested 2026-11-09 on a throwaway world `oracle_smoke`, original settings restored afterwards)
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
| **Vanilla data export** (`java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --server --reports`) | **1,407 recipes, 1,246 loot tables** (block drops, mob drops, piglin bartering, chests), **1,520 advancements**, `commands.json`, `blocks.json`, `packets.json`, registries and tags, all exactly 1.21.6 | Tested 2026-11-09. Use as the authoritative knowledge base |
| `minecraft-data` 3.117 | Block and item IDs, collision shapes, protocol, foods, entities | Good. Its **1.21.6 `blockLoot`/`entityLoot` point to 1.20 data**, so don't use it for drops |
| `node_modules/mineflayer/docs/api.md`, `mineflayer-pathfinder/readme.md` | Exact API for our versions | Local |
| Minecraft Wiki (minecraft.wiki) | Mechanics not in the data files: dragon phases, stronghold layout, eye-of-ender behaviour, fortress generation, bartering timing, mob AI | Read as needed and cite in code comments |
| `references/*` | Design ideas and Mineflayer workarounds | Ideas only. Every borrowed trick gets its own live test |

**No extra docs are needed from you.** Between the vanilla data export, the local API docs and the wiki, the data side is covered. What makes the bot work is live testing against the server.

---

## 12. Production checklist
- Config validated at startup; secrets only in `.env`.
- A process supervisor that restarts the bot and resumes the task notes and memory.
- Reconnect handling and death recovery.
- Structured logs with rotation; one folder per run.
- **LLM:** timeouts, backoff, budgets, a second provider, and safe holding when none answers.
- **Security:**
  - only owners give tasks
  - other chat and anything read in the world (signs, books) is information, never instructions
  - `[oracle]` chat is ignored
  - the bot never runs commands
- CI: type-check and unit tests on every commit; body tests when skills change; a nightly benchmark.
- `STATUS.md` is updated only from judged runs, always with pass rates.

---

## Appendix A: Server kit and oracle

Parts of this are built (Phase 0). The rest is added in the phase that needs it.

`server-kit/` holds everything the harness needs to run a judged session:
- `datapacks/bot_oracle/`, the datapack, to be extended as phases need it:
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

## Appendix B: Limits in the current code to remove

Only the `navigator.ts:474` row was re-checked on 2026-11-11. Confirm each of the other line numbers before acting on it.

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
| `loop.ts:400`, config | 1-5 actions per step | Removed with the once-a-second loop: the LLM sends a step plan |
| `smelt` | ≤ 64 items, one stack checked, fixed 12 s per item | Batches across stacks, driven by furnace events, with a timeout from the expected smelting time |
| `navigator.ts:474` | `_isMockFunction` check in production code | Deleted |

---

## Appendix C: Ideas from the reference repos

Each one is verified live before it is relied on.

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
  - nearest-feasible ordering inside `obtain`. DEPS left this as a stub.
- **mindcraft's dependency planner** (`npc/item_goal.js`): failure-weighted choice of method (craft / mine / smelt / hunt) with inventory-delta verification. Same idea as the inside of `obtain`, built on the vanilla data instead of buggy names.

**Avoid**
- LLM-written code, or a skill library made of it (Voyager, mindcraft `newAction`).
- An LLM call per command (mindcraft); an LLM critic as the judge (Voyager); "explanations" with no evidence behind them (DEPS).
- Cheats in benchmarks: `/give`, `/tp`, keepInventory, peaceful, a frozen day/night cycle (Voyager).
- Reflexes that kill an action without resuming it; restarting the process to resync inventory (mindcraft).
- Fixed sleeps; treating `entityGone` as a kill; a blanket "hostile" check that provokes endermen and piglins.

---

## Appendix D: Example requests

Each row is a request, the skills it needs and the done-condition that closes it. None of these is a task type in code.

| Kind | Example requests | What the body does | Done-condition, also checked by the server |
| --- | --- | --- | --- |
| **Obtain** | "get 20 iron", "get diamond armor" | `obtain` → gather/craft/smelt | RCON bot inventory |
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
| **Progression** | "beat the game", "get to the Nether" | the LLM's task notes hold the milestones; skills as needed | advancements |
