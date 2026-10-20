# Minecraft LLM Agent: Complete Build Plan — Minecraft Java 1.21.6

*Version-targeted build plan · October 20, 2026 · Planning document only; nothing is implemented here.*

## 1. Goal and scope

Build one program that you start from a script. It should:

1. Join your local Minecraft Java server as a normal player (the AI bot).
2. Build a structured observation from data Mineflayer can actually access. Separate directly observed values from derived estimates; represent unsupported or unavailable values as `unknown` rather than guessing.
3. Send that observation and the currently available action catalogue to an LLM (LM Studio locally first, with API providers optional).
4. Parse and validate the model's JSON response, re-check the action against the current world state, execute it, record the result, and repeat.

You watch from your own Minecraft client in spectator mode.

**Design principles**

- The LLM decides *what* to do. Code decides *how* (pathfinding, aiming, tool choice, timing).
- Offer actions whose availability can be checked from current state; revalidate them at execution time because the world can change.
- Prefer target IDs and enumerated inventory items. Any free-form coordinates, item names, or counts must be bounded and validated in code; prompting alone does not prevent hallucinations.
- Provider-agnostic: LM Studio, OpenAI-compatible APIs, Anthropic API, others behind one interface.
- Everything needed to replay a decision is logged, with secrets redacted and log retention configurable.

**Fixed compatibility target:** Minecraft Java Edition **1.21.6** (protocol **771**, data version **4435**), which requires **Java 21**. Keep the Minecraft client and server on 1.21.6 during initial testing. Mineflayer added 1.21.6 support in version 4.32.0; use a current compatible release and verify the actual dependency tree with a smoke test before building higher-level features.

**Version 1 constraints:** Java Edition, no server-side mods/plugins, no screenshot/vision input, and one bot. Build the project incrementally; the full observation and action catalog below is a target design, not an instruction to implement every field and action at once. Start with a small end-to-end slice and expand only after each phase passes tests.

**Minimum viable slice:** first prove (1) stable connection and graceful shutdown, (2) reliable health/position/inventory observation, (3) one valid LLM JSON response, (4) a tiny action set with runtime validation, and (5) one measurable task such as collecting three logs. Do not implement the entire catalog before this loop works.

## 2. Recommended technology stack

| Layer | Choice | Why |
| --- | --- | --- |
| Bot runtime | Node.js 24 LTS with TypeScript, current Mineflayer release supporting Java 1.21.6 | Use a supported LTS release; commit `package-lock.json` so transitive protocol dependencies stay reproducible |
| Movement | mineflayer-pathfinder | A\* pathfinding, digging and placing while moving |
| Optional plugins | mineflayer-collectblock, mineflayer-pvp, mineflayer-armor-manager, prismarine-viewer | Faster macros, combat, auto-armor, browser 3D view |
| Game data | minecraft-data | Recipes, items, blocks, hardness, tool requirements, food values |
| LLM client | OpenAI-compatible client plus a separate adapter where required | LM Studio exposes an OpenAI-compatible API at `http://localhost:1234/v1`; provider-specific features still need capability checks |
| Validation | Zod or Ajv (JSON Schema) | Strict checking of model output |
| Config | YAML file plus .env for keys | Switch provider without code changes |
| Logging | pino writing JSONL | One record per decision step, easy to replay |
| Server | Minecraft Java Edition 1.21.6 vanilla server (Paper 1.21.6 only if separately tested) | Keep server and client exactly on 1.21.6 for the initial compatibility test |

**Alternatives considered:** Python with a JS bridge (Voyager style), a Fabric client mod (Baritone style, more powerful but harder), or forking Mindcraft. Recommendation: build your own on Mineflayer for control and learning, while borrowing ideas from Mindcraft and Voyager. Mineflayer 4.32.0 introduced Java 1.21.6 support; later releases may be used, but pin the tested package tree in `package-lock.json` and do not blindly upgrade packages mid-build. Node.js 24 LTS is the default runtime and remains supported through April 30, 2028; its schedule moves it to Maintenance LTS on October 20, 2026. Node.js 26 is still Current on the date of this plan, so use it only after its LTS transition and dependency checks. If a dependency reports an engine requirement, satisfy it rather than ignoring `EBADENGINE` warnings.

## 3. Local setup: server, spectator, bot

1. Install **Java 21**. Download the **Minecraft Java 1.21.6** server jar, run it once, and accept the EULA.
2. Prefer `online-mode=true` when you have a supported authenticated bot account. For a disposable local test server only, `online-mode=false` allows username-based connections without normal account authentication and lets another client impersonate the bot name. If using offline mode, bind the server to loopback when all clients run on the same PC, or strictly firewall it; never expose it to the internet. Set `gamemode=survival`, `spawn-protection=0`, and `view-distance=8` initially; increase view distance only if needed.
3. Make yourself operator. Useful gamerules while testing: keepInventory true, doImmediateRespawn true, announceAdvancements false.
4. Launch your normal client using **Minecraft Java 1.21.6**, join `localhost`, and run `/gamemode spectator` on yourself.
5. To see through the bot, left-click it while in spectator mode, or use the server's `/spectate` command. Use the spectator controls to exit the view.
6. LM Studio: download and load a model, start the Local Server, note the port and model id, and use a model that follows JSON instructions well. For APIs: put the key in an environment variable.
7. Start the app script. Initially, make it connect and print status only. Add the decision loop after connection, observation, and shutdown behavior are tested. Reconnect with bounded exponential backoff; do not reconnect forever at a tight interval.

## 4. System architecture

```
Minecraft server <--> Bot connection (Mineflayer)
                         |            ^
                         v            |
   Perception (observation builder)   Action executor (macros + low-level)
                         |            ^
                         v            |
   Prompt builder --> LLM client --> Parser + validator
        ^           (LM Studio / API)        |
        |                                    v
   Memory + history <------ Agent controller (loop, interrupts, safety)
```

| Module | Responsibility |
| --- | --- |
| Connection | Join server, auth mode, reconnect, respawn handling |
| Perception | Build the observation (section 6) from available bot state and loaded world data; mark unavailable fields explicitly |
| Action registry | Defines every action, its parameters, its availability rule, and its executor |
| Availability engine | Each turn, evaluates all rules and returns only currently legal actions with valid parameter choices |
| Executor | Runs an action, reports success, failure or interrupted, with a reason |
| Prompt builder | System prompt, action catalogue, observation, recent history, memory |
| LLM provider layer | Common interface over LM Studio and API providers |
| Parser and validator | Parse JSON, check schema, re-check availability immediately before each action, and sanity-check parameters |
| Agent controller | The loop, interrupts, reflexes, stuck detection, kill switch |
| Memory | Short-term history, long-term notes and named locations |
| Logger and dashboard | JSONL logs, console status, optional web view |

## 5. The agent loop

1. Wait until the bot has spawned and chunks around it are loaded.
2. Build the observation and the list of available actions.
3. Build the prompt and send one request to the LLM (never more than one in flight).
4. Parse and validate. Allow at most two bounded retries for malformed output, then take a fail-safe path: stop movement/item use where possible, log the failure, and wait for a new decision or operator input. A blind `wait` is not always safe in a hazard.
5. Re-check availability immediately before every action because the world may change while the model is thinking or while earlier actions run.
6. Execute the action(s) in order. Stop the batch at the first failure or safety trigger; default to one action per model response until single-action execution is reliable.
7. Record the result, update memory, go to step 2.

**Interrupts** (cancel a cancellable running action and trigger a new decision): damage taken, hostile mob entering a configurable radius, health below a threshold, drowning, on fire, death, authenticated owner command, action finished/failed, or stuck detected. Some library operations may not cancel cleanly; wrap them with timeouts and explicit stop/cleanup handlers. Keep the emergency reflex loop independent of the slower LLM request.

**Reflex layer (no LLM, configurable):** LLM latency can be several seconds, so a tiny rule layer handles emergencies: leave lava or water when air is low, stop mining straight down, eat when food is very low and food is available, flee at critically low health. The LLM is told when a reflex fired.

**Stale responses:** attach an observation/world-state version and request ID to each call. If critical state changed during inference (for example, health fell, the bot died, the target disappeared, or the dimension changed), discard the response and rebuild the observation. Enforce one in-flight request and a hard request timeout.

## 6. Inputs: the complete observation

The observation is compact structured JSON, plus a short summary and optional ASCII map. Positions can be expressed absolutely and relative to the bot. Include only facts supported by the current Mineflayer API, loaded chunks, or explicitly documented calculations. Distinguish `observed`, `derived`, and `unknown` values; do not claim the bot has human-like sight or access to hidden blocks. For the MVP, implement only the fields needed for the actions currently enabled.

### 6.1 Vitals and body state

| Input | Details |
| --- | --- |
| Health | Current and maximum (hearts or points), absorption hearts |
| Hunger | Food level 0 to 20, saturation, whether sprinting is allowed |
| Air | Oxygen level exposed by the library/protocol (commonly 0–20 internally), plus an underwater flag; convert to display bubbles only for presentation |
| Armor | Armor points and toughness (derived from worn armor) |
| Experience | Level and progress |
| Game mode, alive or dead | Survival expected; dead state triggers respawn flow |
| Burning, freezing | On fire, powder-snow freezing |
| Movement state | On ground, in water, in lava, climbing, swimming, falling (fall distance), sleeping, riding a vehicle, sprinting, sneaking |
| Item use state | Eating, drawing a bow, blocking with a shield, and progress |
| Attack cooldown | Whether a full-strength hit is ready |

### 6.2 Position and orientation

- Exact x, y, z and block coordinates, velocity.
- Yaw, pitch, and cardinal facing (north, east, south, west, up, down).
- Dimension (overworld, nether, end) and biome.
- Depth context: sky-exposed, underground, or in a cave; height above sea level.
- Spawn or bed location, last death location, distance to named home.

### 6.3 Time, weather, light

World time and phase (day, dusk, night, dawn), day count, moon phase, weather (clear, rain, thunder), light level at feet (block and sky), open-sky flag, difficulty, server ping.

### 6.4 Active status effects

Report only effects accessible through the installed Mineflayer/protocol version, with name, amplifier/level, and duration when available. If an effect or its duration is not exposed, mark it unknown rather than inferring it. Translate effects into plain-language consequences only when the mapping is well defined.

### 6.5 Inventory and hands

| Input | Details |
| --- | --- |
| Main hand (right by default) | Item, count, durability left and maximum, enchantments, custom name |
| Off hand (left by default) | Same fields; handedness is read from config so left and right are never confused |
| Selected hotbar slot | 0 to 8, plus all nine hotbar contents |
| Main inventory | All 27 slots |
| Armor slots | Head, chest, legs, feet with durability and enchantments |
| Aggregates | Total count per item name, free slot count |
| Tool summary | Best tier of pickaxe, axe, shovel, hoe, sword, plus low-durability warnings |
| Food list | Edible items with hunger and saturation they restore |
| Placeable blocks | Total and per type |
| Craftable now | Recipes the bot can craft with current items (and whether a crafting table is needed) |
| Held-item hint | What the current main-hand item can do (mine, place, eat, shoot, and so on) |

### 6.6 Crosshair target

Block under the crosshair (name, position, distance, face, state such as crop age or door open, hardness, whether the current tool can harvest it, estimated break time) and entity under the crosshair.

### 6.7 Visible blocks

Two configurable visibility modes: **surround** (scan loaded nearby blocks in multiple directions) and **forward-cone** (report only targets within a configured cone from the current look direction). Mineflayer receives chunk/block data beyond a human field of view, so this is a perception policy, not literal human vision. Use line-of-sight ray checks for visibility-sensitive targets; never report blocks hidden behind an occluding solid block as visible. A debug mode may inspect loaded data, but must be clearly labelled as omniscient and disabled for normal evaluation.

| Input | Details |
| --- | --- |
| Local map | Compact grid around the bot (for example 9 by 9, from 2 below to 3 above), legend included |
| Notable blocks | Nearest few of each: ores, logs, leaves count, stone, dirt, sand, gravel, water, lava, crops, chests, barrels, furnaces, crafting tables, beds, doors, buttons, levers, rails, portals, spawners, torches, and so on, with distance, direction, and count |
| Immediate blocks | Below feet, at feet, at eye level, directly ahead, above head |
| Walkability | For each of the four directions: free, blocked, step up, drop, water, or lava |
| Hazards | Lava, fire, cactus, sweet berry bush, magma, cobweb, powder snow, drops of 3 or more blocks, void, unstable gravel or sand overhead, flooding risk |
| Terrain summary | Surface type, tree count, open space, cave entrance, water body |
| Per-block data | Name, state properties, hardness, required tool, whether the bot can currently dig it |

### 6.8 Nearby entities

Each currently tracked entity gets a short-lived ID (for example `e12`) mapped to its runtime entity ID. Include type/name, distance, relative position, and line-of-sight only when actually computed. Health, equipment, age, tame state, and movement intent may not be available for every entity/version; include them only when observed or reliably derived, otherwise use `unknown`. Rebuild IDs when entities despawn or tracking resets.

- Hostile mobs (zombie, skeleton, creeper, spider, enderman, and others)
- Neutral mobs (wolf, piglin, iron golem, bee)
- Passive animals (cow, sheep, pig, chicken, horse)
- Villagers and traders
- Players, with the owner (you, the spectator) flagged as friendly and not attackable
- Dropped items (name, count), experience orbs, projectiles (arrows), vehicles (boats, minecarts), item frames, armor stands

### 6.9 Events and chat since last step

Damage taken (amount and source), health regained, item picked up, item or tool broken, block broken or placed, mob killed, death and respawn, bed slept in, advancement, chat messages from players (owner instructions), whispers, server messages, action results and error reasons, pathfinding blocked, reflex fired.

### 6.10 Open window or container

Window type (chest, furnace, crafting table, villager trade, enchanting table, anvil, and so on), all its slots, furnace progress and fuel left, available villager trades, enchantment options.

### 6.11 Agent state and memory

Current goal and plan with step status, the last N actions with outcomes, memory notes, named locations (home, base, mine, chest, bed), danger zones, counters (step number, stuck counter, time since last progress), pending owner instructions, the action currently running.

### 6.12 Derived helpers

The available-actions list with valid parameter choices, craftable recipes, edible items, reachable interactable blocks, and reachable entities, all computed by code so the model never has to guess.

## 7. Actions and when each is available

Every action returns a result: success, failed, or interrupted, with a reason and details that are fed into the next prompt. Typical reach limits: about 4.5 blocks for blocks and about 3 blocks for attacks. Macro actions walk into range automatically when the target is known and reachable.

### 7.1 Movement

| Action | Parameters | Available when |
| --- | --- | --- |
| goto | preferred target id; optional validated position and stopping range | Target is loaded and path exists; not in a GUI, asleep, or riding. Free-form positions are allowed only within configured bounds or for trusted owner goals |
| follow | player or entity id, distance | Target is known |
| flee | threat ids or position, distance | At least one threat is known |
| move | direction (forward, back, left, right), short duration | Not in a GUI or asleep |
| jump | none | On ground or in water |
| climb | up or down | Ladder, vine, or scaffolding at the bot |
| swim\_up | none | In water |
| sprint | on or off | Food above 6, not blind, not sneaking |
| sneak | on or off | Not asleep |
| look\_at | position, block id, or entity id | Not asleep |
| set\_look | yaw, pitch | Not asleep |
| explore | direction, distance | Unexplored loaded terrain in that direction |
| stop | none | Some action is running |

### 7.2 Mining, building, farming

| Action | Parameters | Available when |
| --- | --- | --- |
| dig\_block | block id | Diggable (not bedrock, not liquid), reachable, and the right tool is held or auto-equippable if the block needs one |
| mine\_resource | block type, count, max distance | At least one visible or remembered block of that type |
| chop\_tree | log block id | A tree is visible |
| place\_block | item, reference block id, face | A block item is in inventory, that face is empty, in reach, not inside the bot |
| collect\_items | optional item filter | Dropped items nearby and free inventory space |
| use\_bucket | fill or empty, target | Bucket in inventory and a liquid source (fill) or free target space (empty) |
| till | block id | Hoe available and the block is dirt or grass |
| plant | seed item, farmland id | Seeds in inventory and farmland in reach |
| harvest | crop id | Crop fully grown |
| bonemeal | target id | Bone meal in inventory and a valid target |
| fish | start or stop | Fishing rod in inventory and water ahead |

### 7.3 Inventory, items, crafting

| Action | Parameters | Available when |
| --- | --- | --- |
| equip | item, slot (hand, off\_hand, head, chest, legs, feet) | Item in inventory and valid for that slot |
| select\_hotbar | slot 0 to 8 | Always (not in a GUI) |
| swap\_hands | none | Main or off-hand item exists |
| drop | item, count | Item in inventory |
| eat | item | Edible item in inventory and food below 20 (golden apples and similar allowed when full) |
| use\_item | item, optional duration | Usable item held (ender pearl, bow, potion, snowball, firework, shield) |
| stop\_using\_item | none | Currently using an item |
| move\_item | from slot, to slot, count | Inventory or container window open |
| craft | item, count | Recipe exists, ingredients present, and a crafting table in reach if the recipe needs 3 by 3 |
| smelt | input, fuel, count | Furnace, smoker, or blast furnace in reach, valid input, fuel available |
| open\_container | block id | Chest, barrel, furnace, shulker box, or similar in reach and not obstructed |
| deposit | item, count | Container open and has free space |
| withdraw | item, count | Container open and holds the item and the bot has room |
| close\_container | none | A window is open |
| trade | villager id, trade index | Trade window open and ingredients present |

### 7.4 Combat

| Action | Parameters | Available when |
| --- | --- | --- |
| attack | entity id | Alive, within reach or approachable, not the owner or on the friend list |
| attack\_nearest | filter (hostile, specific type) | A matching entity is visible |
| shoot | target id | Bow or crossbow with arrows |
| block\_with\_shield | duration | Shield in off-hand |
| throw | item, target | Throwable item in inventory |

### 7.5 World interaction

| Action | Parameters | Available when |
| --- | --- | --- |
| interact\_block | block id | Interactable block in reach (door, button, lever, bed, table, gate, trapdoor) |
| interact\_entity | entity id | Villager, feedable animal, boat, horse, and so on, in reach |
| sleep | bed id | Bed in reach, night or thunderstorm, overworld, no hostile mob nearby |
| wake | none | Currently sleeping |
| mount | entity id | Rideable entity in reach and bot not riding |
| dismount | none | Riding |
| breed | two animal ids | Holding that animal's breeding food, both adults |

### 7.6 Meta and communication

| Action | Parameters | Available when |
| --- | --- | --- |
| chat | message | Always (rate limited) |
| wait | seconds, up to 10 | Always (interruptible) |
| remember | key and value, or location name and position | Always |
| set\_goal | goal text, optional plan steps | Always |
| run\_command | command string | Only if enabled in config and the bot is operator (off by default) |
| respawn | none | Dead (also handled automatically) |
| disconnect | none | Always |

Later phases: enchanting, anvil use, brewing, nether portal travel, elytra, redstone helpers, building from blueprints.

## 8. LLM request and response contract

**Request** (every step) contains:

1. **System prompt** (stable): role and survival goals, hard rules (output JSON only, choose only from enabled actions, prefer supplied target IDs, keep any coordinate parameters within declared bounds, never harm the owner), and the response schema.
2. **Available actions** (dynamic): the output of the availability engine, each with its parameters and valid options, so the model sees exactly what can be done right now.
3. **Observation** (section 6) as compact JSON, plus a one-paragraph summary.
4. **History**: last 5 to 10 steps with outcomes, current goal and plan, memory notes.

**Response** must be a single JSON object:

| Field | Meaning |
| --- | --- |
| decision_summary | One brief explanation of the selected action and relevant evidence; not a long reasoning trace |
| goal | Current high-level goal |
| actions | Array of action objects, each with action and params. Default and recommended initial maximum is 1; raise to at most 5 only after sequencing, interruption, and per-action revalidation are tested |
| memory | Optional notes or named locations to store |
| say | Optional chat message, or null |

Example:

```json
{
  "decision_summary": "Oak logs are visible nearby; collect a small amount of wood first.",
  "goal": "Collect 8 logs then craft a crafting table and tools",
  "actions": [
    {"action": "mine_resource", "params": {"block": "oak_log", "count": 4}}
  ],
  "memory": {"note": "Forest to the east"},
  "say": null
}
```

**Getting reliable JSON:** prefer provider-supported JSON Schema/structured output, then JSON mode. Otherwise use a strict parser; optionally strip a single surrounding code fence or extract one balanced JSON object, but do not silently rewrite semantically invalid values. Validate every field and action independently. A schema-valid response can still be unsafe or impossible, so schema validation never replaces runtime availability checks.

**Token budget:** start with an observation target of 800–2500 tokens and measure actual token use with the selected model. When trimming, preserve vitals, hazards, current action state, target validity, and owner commands; remove distant blocks, passive entities, repeated empty inventory slots, and older history first. Use a context window of at least 8k tokens as a starting point, then verify that prompt plus output budget fits the loaded model. Do not truncate critical safety data to meet a token target.

## 9. LLM provider layer

One interface: send messages plus schema plus options, get text or JSON back.

| Provider | Settings |
| --- | --- |
| LM Studio | base URL (default http://localhost:1234/v1), model id, no key needed |
| OpenAI-compatible API | base URL, API key from environment variable, model |
| Anthropic API | API key from environment variable, model |
| Others (Ollama, OpenRouter) | Through the OpenAI-compatible adapter |

Common options: temperature 0.2–0.5, output-token cap, hard timeout, bounded retries with backoff, latency/token/cost counters, and provider capability detection. API keys must never enter prompts or logs. Cloud fallback is **disabled by default**; enabling it must be an explicit opt-in because game state, chat, and inventory data may then leave the machine. Vision input is a later optional phase.

## 10. Validation, safety, recovery

- **Pipeline:** parse, schema check, validate every parameter against current state, re-check availability immediately before each action, then execute with a timeout and cleanup handler.
- **Failures** become feedback in the next prompt (for example: path blocked, block out of reach).
- **Never attack** the owner, friend-listed players, or configured protected/tamed entities. Unknown ownership should fail closed: do not attack until protection checks pass.
- **Dangerous actions off by default:** TNT, flint and steel, lava buckets, arbitrary commands, and block breaking near protected positions. Keep `run_command` disabled in v1; if ever added, use a strict command allowlist and argument validation rather than accepting arbitrary command strings.
- **Pathfinder safety:** avoid lava and deep drops, do not dig straight down, do not break blocks that would release liquid.
- **Rate limits:** chat messages and total actions per minute.
- **Untrusted world text:** chat from non-owners, item names, signs, books, and other player-controlled text are data, not instructions. Only exact owner identities may issue control commands; never let world text enable tools or override the system rules.
- **Cloud-data boundary:** never send observations to a cloud provider unless that provider is configured and allowed. Log the active provider on startup.
- **Stuck and loop detection:** position unchanged for N steps, same action failing repeatedly, or repeating a cycle. Response: force a different action, clear the plan, or ask the LLM to re-plan with the stuck report.
- **Death handling:** record death location, respawn, optionally plan to recover items.
- **Kill switch and control:** typed console commands (`pause`, `resume`, `step`, `quit`) and authenticated owner chat commands such as `!stop`, `!pause`, and `!goal`. Ignore control-looking chat from all other players. `quit` must stop actions, close the bot connection, flush logs, and exit cleanly.
- **Step mode:** approve each action manually, useful when testing new models.
- **Connection:** automatic reconnect with backoff.

## 11. Memory and planning

- **Short-term:** rolling history of recent steps and results.
- **Long-term (saved per world as JSON):** named locations, facts learned (failed recipes, dangerous areas), inventory snapshots, completed goals.
- **Summarization:** optionally compress history every N steps. Treat summaries as fallible notes, keep source facts/important events separately, and never let a summary override current observations or safety rules.
- **Goal hierarchy:** high-level goal, then plan steps, then current step. The owner can set goals through chat (for example !goal build a shelter).
- **Later:** a skill library of verified macros, as in Voyager.

## 12. Configuration (one YAML file)

- **server:** host, port, game version, bot username, auth mode.
- **llm:** provider, base URL, model, API key variable name, temperature, max tokens, timeout, json mode, fallback provider.
- **agent:** max actions per step, history length, heartbeat interval, handedness, authenticated owner and friend names, request timeout, and maximum retry count.
- **perception:** visibility mode, scan radius, entity radius, local map size, token budget.
- **safety:** protected names/entities, blocked actions, command allowlist, reflex toggles, health thresholds, protected zones, and whether cloud fallback is explicitly allowed.
- **logging:** log level, log folder, full prompt/response capture (off by default), retention/rotation, and web viewer.

## 13. Project structure

```
project/
  config/            config.yaml, .env.example
  src/
    main.ts          entry point and start script
    connection/      join, reconnect, respawn
    perception/      vitals, inventory, blocks, entities, events, map
    actions/         registry, availability rules, executors by category
    llm/             provider interface, lmstudio, openai-compatible, anthropic
    prompt/          system prompt, catalogue and observation formatting
    agent/           loop, interrupts, reflexes, stuck detection
    memory/          history, long-term store, summarizer
    safety/          validators, protected lists, rate limits
    ui/              console dashboard, optional web viewer
  tests/             fixtures, mock LLM, scenarios
  logs/              JSONL step records
  data/              per-world memory files
```

## 14. Logging, spectator experience, debugging

- Per-step JSONL record: observation, available actions, request/response metadata, parsed actions, results, latency, and token counts. Full prompt/response capture is optional and must redact secrets; document that chat and world data can appear in logs. Add configurable log rotation/retention.
- Console view: current goal, last decision summary, last action and result, health and hunger, latency.
- A replay tool re-runs a logged step against another model for comparison.
- Optional browser view (prismarine-viewer) showing the bot's world and path.
- The bot can optionally post its short decision summary and action result in chat. Do not expose or require a full private reasoning trace.

## 15. Testing and evaluation

- **Unit tests:** observation builder against saved fixtures, availability rules, validators, JSON repair.
- **Mock LLM:** scripted responses to test the loop without a model.
- **Scenarios** on a flat test world and a normal survival world: collect 5 logs, craft a pickaxe, escape a zombie, eat when hungry, sleep at night, store items in a chest, survive the first night.
- **Metrics:** valid-JSON rate, action success rate, average latency, steps to complete a goal, deaths, stuck events, tokens per step.
- **Model comparison:** run the same scenarios on each LM Studio model and API model and compare the metrics.

## 16. Build phases

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0 | Minecraft 1.21.6 compatibility and local server | Java 21 server and 1.21.6 client launch; the locked Mineflayer dependency tree connects, spawns, reads health/position, and disconnects cleanly |
| 1 | Connection skeleton, config, logging | Script joins, survives reconnect, logs events |
| 2 | MVP observation | Health, hunger, position, inventory, dimension, and current action state match the game; unavailable fields are explicitly marked |
| 3 | Limited perception | Nearby blocks, line of sight, hazards, and entities work on test fixtures; no claims are made about unsupported fields or hidden blocks |
| 4 | Small action set, then macros | Start with wait/look/goto and one gather/craft goal; add eat/combat/container actions only after their scripted tests pass |
| 5 | Availability engine | Offered actions match the real situation in tests |
| 6 | LLM provider layer (LM Studio first, then API) | Both providers return valid JSON for a fixed prompt |
| 7 | Agent loop, validation, retries, interrupts | Bot completes one simple goal end-to-end with one action per request, timeout handling, and revalidation before every action |
| 8 | Memory, planning, owner chat commands | Bot resumes goals and remembers its base |
| 9 | Safety, reflexes, stuck detection, kill switch | Deliberate failure tests recover cleanly |
| 10 | Dashboard, replay tool, evaluation harness | Models can be compared with metrics |
| 11 | Optional: vision, blueprints, multi-agent, voice | Chosen per interest |

## 17. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| LLM latency (seconds per decision) | Macro actions, a separate reflex layer, bounded requests, and interrupts; allow multi-action batches only after per-action revalidation works |
| Hallucinated targets or items | Id-based targets from supplied lists, availability re-check |
| Invalid JSON from small models | Structured output, tolerant parser, retry with error feedback |
| Token blowup | Compact format, budget trimming, history summarization |
| Bot gets stuck or loops | Stuck detector, forced re-plan, pathfinder timeouts |
| Bot dies repeatedly | Reflexes, keepInventory for early tests, death memory |
| Weak local models | Larger model, fewer actions per step, simpler catalogue |
| Version/protocol mismatch | Target Java 1.21.6 (protocol 771); use Mineflayer 4.32.0 or newer that supports it, lock dependencies, and pass the Phase 0 connection smoke test before proceeding |
| Offline-mode server exposure / username impersonation | Offline mode only on an isolated test server, bound to loopback or strictly firewalled |

## 18. Open decisions for you

1. Minecraft version is fixed: Java Edition 1.21.6 (protocol 771; Java 21).
2. Which LM Studio model and which API provider to start with.
3. One action per step or several per step.
4. Visibility mode: surround or human field of view.
5. Whether run\_command is ever allowed (default no).
6. keepInventory on or off during testing.
7. Primary goal style: pure survival, resource gathering, or building.
8. Whether vision (screenshots) is a later requirement or text-based perception is sufficient for the first version.

## 19. Compatibility references

The compatibility target for this plan is Minecraft Java 1.21.6. Re-run the connection smoke test whenever upgrading Mineflayer, `minecraft-protocol`, `minecraft-data`, or movement plugins. The 1.21.6 protocol is 771 and its data version is 4435; Mineflayer history records 1.21.6 support in version 4.32.0.

- [Mineflayer repository and compatibility information](https://github.com/PrismarineJS/mineflayer)
- [Mineflayer release history (v4.32.0 added 1.21.6 support)](https://github.com/PrismarineJS/mineflayer/blob/master/docs/history.md)
- [Minecraft Java protocol-version data](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/common/protocolVersions.json)
- [Minecraft data version list](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/common/versions.json)
- [Node.js release schedule](https://github.com/nodejs/Release)
- [LM Studio OpenAI-compatible API](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio structured output / JSON Schema](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
