# Minecraft Java 1.21.6 LLM Agent: Architecture & Code Logic Reference

*A complete technical reference and code-level walkthrough of the autonomous Minecraft Java 1.21.6 LLM agent.*

---

## Table of Contents
1. [System Overview & Compatibility](#1-system-overview--compatibility)
2. [End-to-End Control Flow Architecture](#2-end-to-end-control-flow-architecture)
3. [Perception Engine Code Logic](#3-perception-engine-code-logic)
4. [Action Engine & Availability Validation](#4-action-engine--availability-validation)
5. [Autonomous Physical Techniques & Skills (`src/actions/techniques.ts`)](#5-autonomous-physical-techniques--skills)
6. [Emergency Reflex Layer, Retaliation & Action Arbiter](#6-emergency-reflex-layer-retaliation--action-arbiter)
7. [Robust LLM Parsing, Balanced Extraction & Schema Contract](#7-robust-llm-parsing-balanced-extraction--schema-contract)
8. [Safety Invariants, Entity Snapshot Guards & Command Boundaries](#8-safety-invariants-entity-snapshot-guards--command-boundaries)
9. [Persistent Memory & Goal Tracking (`src/memory/index.ts`)](#9-persistent-memory--goal-tracking)
10. [Dashboard, In-Game Control & Replay Tool](#10-dashboard-in-game-control--replay-tool)
11. [Testing Suite & Verification Results](#11-testing-suite--verification-results)

---

## 1. System Overview & Compatibility

- **Target Game Version**: Minecraft Java Edition **1.21.6**
- **Protocol Version**: **771** | **Data Version**: **4435**
- **Runtime**: **Node.js 24 LTS** (or Node 20+) with **TypeScript 5.5+** (ES2022 target, NodeNext modules).
- **Core Dependencies (Pinned Versions)**:
  - `mineflayer`: `4.39.0` (protocol 771 compatible)
  - `mineflayer-pathfinder`: `2.4.5` (A* pathfinding, dynamic block breaking, 1x1 pillaring, and bridging)
  - `minecraft-data`: `3.117.0` (1.21.6 block hardness, recipes, tool requirements, item attributes)
  - `vec3`: `0.1.10`
  - `zod`: `^3.23.8` (strict schema validation of responses and runtime configurations)
  - `pino`: `^9.4.0` + `pino-pretty`: `^11.2.2` (structured logging with deduplication, secret redaction, and per-step JSONL output)

### Design Philosophy
1. **The LLM decides *WHAT* to do; Code decides *HOW* to do it**:
   Micro-actions (e.g. step forward 1 block, mine block at eye level, jump, place block underneath, turn 15 degrees) are **never** delegated to the LLM. Doing so wastes money, blows token budgets, and adds multiple seconds of latency per block. Instead, the LLM emits high-level semantic macro intents (`chop_tree`, `bridge`, `pillar_up`, `mine_staircase`, `craft_pipeline`), and hard-coded TypeScript routines handle the physical mechanics.
2. **Reflexes Bypass LLM Latency**:
   Lava escape, breathing when drowning, auto-eating when starving, and retaliation against hostile attackers run in sub-second code reflexes without waiting for a 3–8 second LLM inference cycle.
3. **Double Availability Checking**:
   Actions are checked for legality before being presented in the prompt catalog, and **re-checked immediately before execution** against the current world state.
4. **Resilient Lifecycle & Single Controller Binding**:
   A single `AgentController` instance persists across network reconnections with stateful locking (`isReconnecting`), cleaning up stale timers and binding cleanly to the new `bot` instance via `updateBotInstance()`.

---

## 2. End-to-End Control Flow Architecture

```
                  +----------------------------------------------+
                  |         Minecraft Java 1.21.6 Server         |
                  +----------------------------------------------+
                                       ^
                                       | Packet stream (TCP 25565)
                                       v
                  +----------------------------------------------+
                  |          Mineflayer Connection Manager       |
                  |     - Auto-reconnect with exponential backoff|
                  |     - Reconnect storm locking & timer cleanup|
                  |     - Pathfinder setup & Movement injection  |
                  +----------------------------------------------+
                                       |
                    +-------------------+-------------------+
                    |                                       |
                    v                                       v
         [Physical World Events]                [Autonomous Reflex Layer]
      (health, blockBreak, chat,                 (Sub-second response:
        entityHurt, time, death)                  Auto-Attack, Auto-Eat,
                    |                             Lava/Drowning Escape)
                    v                                       |
 +------------------------------------+                     |
 |         Perception Engine          |                     |
 | - Vitals (health, food, armor)     |                     |
 | - Inventory & live recipe querying |                     |
 | - 9x9 Local ASCII map & hazards    |                     |
 | - Short-ID Entity tracking (e1...) |                     |
 +------------------------------------+                     |
                    |                                       |
                    v                                       |
 +------------------------------------+                     |
 |        Availability Engine         |                     |
 | - Filters illegal actions          |                     |
 | - Injects legal parameter choices  |                     |
 +------------------------------------+                     |
                    |                                       |
                    v                                       |
 +------------------------------------+                     |
 |           Prompt Builder           |                     |
 | - Token budget compaction          |                     |
 | - Injects history & memory goals   |                     |
 +------------------------------------+                     |
                    |                                       |
                    v                                       |
 +------------------------------------+                     |
 |            LLM Provider            |                     |
 | (LM Studio / OpenAI / Anthropic)   |                     |
 +------------------------------------+                     |
                    | (Raw String / Markdown Response)      |
                    v                                       |
 +------------------------------------+                     |
 |      Parser & Balanced Extractor   |                     |
 | - Balanced brace scanner in strings|                     |
 | - Strict Zod + KNOWN_ACTION_NAMES  |                     |
 | - Bounded retries (up to 2x)       |                     |
 +------------------------------------+                     |
                    |                                       |
                    v                                       |
 +------------------------------------+                     |
 |   Safety Guard & Snapshot Check    |                     |
 | - resolveAndValidateTarget check   |                     |
 | - Owner/friend combat immunity     |                     |
 | - Command injection sanitation     |                     |
 +------------------------------------+                     |
                    |                                       |
                    v                                       |
 +------------------------------------+                     |
 |   Action Arbiter & Execution Loop  |<--------------------+
 | - Priority preemption (10->50->80->100)                  |
 | - Per-action unique ID tracking    | (Preempts if reflex fires)
 | - Fresh observation before actions |
 | - Physical Skills & Techniques     |
 +------------------------------------+
                    |
                    v
 +------------------------------------+
 |    Memory & Structured Logging     |
 | - Rolling step history             |
 | - Persistent per-world JSON data   |
 | - JSONL step record written        |
 | - Deduplicated error logging       |
 +------------------------------------+
```

---

## 3. Perception Engine Code Logic

The perception system converts raw Mineflayer internals and loaded chunk packets into clean, deterministic data structures without guessing or hallucinating unsupported fields.

### 3.1 Vitals & Movement State (`src/perception/vitals.ts`)
- **Health & Armor**: Measures raw health, food saturation, and computes effective armor protection points and armor toughness by inspecting worn armor slots (`leather`, `chainmail`, `iron`, `diamond`, `netherite`).
- **Movement State**: Reads on-ground status, in-water flags, climbing states (ladder/vine detection), swimming, jumping, and fall distance.
- **Burning/Freezing**: Reads entity metadata bitmasks to observe burning state and powder-snow freezing.

### 3.2 Inventory & Recipe Queries (`src/perception/inventory.ts`)
- **Hands**: Accurately tracks main hand and off hand based on configured handedness (`right` or `left`).
- **Tool Summary**: Scans inventory to identify the highest tier (`wooden` -> `stone` -> `iron` -> `diamond` -> `netherite`) of pickaxe, axe, shovel, sword, and hoe. Monitors durability and alerts when an item has `< 15` uses remaining.
- **Craftable Now**: Interrogates `bot.recipesFor(candidateItem.id, null, 1, craftingTable)` across 35+ core items (tools, weapons, armor, containers, torches, bread) using nearby crafting tables within reach (4.5m) to present the model with a concrete list of recipes that can be crafted with currently held ingredients.

### 3.3 Spatial Mapping & Hazard Detection (`src/perception/blocks.ts`)
- **Walkability Engine**: Evaluates cardinal directions from the bot's feet. Categorizes each direction as `free`, `step_up`, `blocked`, `drop`, `water`, or `lava`.
- **Local Map Grid (9x9 ASCII)**:
  Samples a horizontal slice around the bot from 2 blocks below feet to 3 blocks above.
  ```
  . . . . . . . . .
  . . # # # . . . .
  . . # T # . ~ . .
  . . . P . . ~ . .
  . . . . . . . . .
  ```
  *Legend & Safety Semantics*:
  - `P` = Bot's current position.
  - `.` = **Passable solid ground with clear headroom** (strictly confirmed solid support beneath feet and non-hazardous passable blocks at feet/head).
  - `#` = Solid wall or obstruction at feet or head level.
  - `v` = **Cliff, Drop, or Void gap** (air beneath feet with missing ground support). Air is **never** presented as passable `.` ground.
  - `?` = **Unknown or unloaded chunk data**.
  - `T` = Tree log / Wood.
  - `~` = Foliage / Leaves.
  - `W` = Water.
  - `L` = Lava.
  - `O` = Ore.
  - `C` = Container / Crafting table.
- **Hazards Scan**: Radius-6 volumetric search identifying lava, fire, cactus, sweet berry bushes, magma blocks, cobwebs, powder snow, and void drops.

### 3.4 Entity Tracking (`src/perception/entities.ts`)
- **Short-Lived Identifiers**: Allocates temporary IDs (`e1`, `e2`, `e3`...) sorted by distance from the bot.
- **Line-of-Sight Raycasting (`hasLineOfSight`)**: Performs 0.5-block step vector ray checks between the bot's eyes and target entity. If solid non-glass blocks intersect, `lineOfSight` is flagged as `false`.
- **Classification**: Separates hostiles (zombies, creepers, skeletons, spiders, etc.) from passives (cows, pigs, sheep) and dropped items (`item` entities). Flags configured owner usernames with `isOwner: true`.

---

## 4. Action Engine & Availability Validation

### 4.1 The Two-Phase Legality Guard
1. **Catalog Generation Phase (`AvailabilityEngine.computeAvailableCatalog`)**:
   Before prompting the LLM, every registered action evaluates its `isAvailable()` predicate. For legal actions, `getAvailableChoices()` enumerates valid arguments (e.g. valid edible items in inventory for `eat`, visible hostile IDs for `attack`, notable block names for `dig_block`).
2. **Pre-Execution Revalidation (`AvailabilityEngine.revalidateAction`)**:
   Because the LLM takes multiple seconds to respond, the Minecraft world can change mid-inference. Immediately before invoking the action executor, the engine re-checks if the action and its arguments are still valid (e.g. target mob didn't despawn, block didn't get destroyed).

### 4.2 Action Registry Overview
The system registers **52 distinct verified actions** across 6 categories (verified in `src/prompt/schema.ts` via `KNOWN_ACTION_NAMES`):
- **Movement (13)**: `goto`, `follow`, `flee`, `move`, `jump`, `swim_up`, `sprint`, `sneak`, `look_at`, `explore`, `stop`, `pillar_up`, `bridge`.
- **Mining & Building (12)**: `dig_block`, `mine_resource`, `chop_tree`, `place_block`, `collect_items`, `use_bucket`, `till`, `plant`, `harvest`, `mine_staircase`, `build_shelter`, `vacuum_drops`.
- **Inventory & Crafting (11)**: `equip`, `select_hotbar`, `swap_hands`, `drop`, `eat`, `craft`, `craft_pipeline`, `open_container`, `deposit`, `withdraw`, `close_container`.
- **Combat (4)**: `attack`, `attack_nearest`, `shoot`, `block_with_shield`.
- **World Interaction (6)**: `interact_block`, `interact_entity`, `sleep`, `wake`, `mount`, `dismount`.
- **Meta (6)**: `chat`, `wait`, `remember`, `set_goal`, `respawn`, `run_command` (strictly restricted by allowlist).

---

## 5. Autonomous Physical Techniques & Skills

Located in [`src/actions/techniques.ts`](file:///b:/minecraft_ai_scratch/src/actions/techniques.ts), these routines handle complex physical mechanics autonomously with full cancellation propagation (`AbortSignal`).

### 5.1 Dynamic Pathfinder Scaffolding (`updatePathfinderMovements`)
- Inspects inventory for valid scaffolding items (`dirt`, `cobblestone`, `stone`, `planks`, `netherrack`). Translates item names into numeric block IDs and populates `movements.scafoldingBlocks`.
- Enables dynamic block digging (`move.canDig = true`), 1x1 pillaring (`move.allow1by1towers = true`), gap jumping (`move.allowParkour = true`), and prevents suffocating under falling blocks (`move.dontMineUnderFallingBlock = true`).

### 5.2 Pillar Jump Technique (`techniquePillarUp`)
- **Inventory Pre-Check**: Verifies that scaffolding blocks exist before initiating any jumps.
- **Orientation Calculation**: Aims the bot's camera straight down (`pitch = Math.PI / 2`, adhering to Minecraft Java pitch conventions where positive pitch is downward).
- **Execution & Apex Timing**: Activates `jump = true`, tracking elevation until `y - startY > 1.12` (the apex of the jump). Places the block against the `(0, 1, 0)` top face of the ground block.
- **Post-Placement Verification**: Verifies that `bot.blockAt(startPos.floored())` is solid before assuming elevation gain.
- **Guaranteed Cleanup**: In a `finally` block, releases `jump = false`, restores camera pitch to `0` (horizontal), and clears controls.

### 5.3 Safe Sneak-Bridging (`techniqueBridge`)
- **Scaffold Check**: Rejects execution upfront if zero valid bridge/scaffold blocks exist in inventory.
- **Edge Crouch Invariant**: Activates `sneak = true`. In Minecraft, crouching strictly prevents the player from walking off the edge of a block into open air.
- **Placement & World Verification**: Places the block against the ledge face. **Never** steps onto a block merely because the place call succeeded; queries `bot.blockAt(targetGroundPos)` to confirm `boundingBox === 'block'`. If placement failed, aborts immediately without stepping forward.
- **Guaranteed Cleanup**: In a `finally` block, safely resets `sneak = false`, restores camera orientation, and clears controls.

### 5.4 Full Tree Harvester Macro (`techniqueChopTreeFull`)
- Paths to the nearest tree trunk, automatically digging obstructive leaves along the way.
- Equips the best axe and chops trunk logs from bottom to eye level.
- If higher logs are out of reach (`distance > 4.2m`), automatically invokes `techniquePillarUp(bot, 1)` to gain height, cuts the canopy logs, and then mines the pillar blocks back down.
- Automatically executes `techniqueVacuumDrops(bot, 6)` to scoop up all fallen wood, saplings, and apples.

### 5.5 Safe Staircase Mining (`techniqueMineStaircase`)
- **Precondition & Hazard Checks Before Every Step**:
  1. Inspects destination floor at `targetFloorPos = stepAhead.offset(0, -2, 0)`.
  2. If floor block data is `null` (unloaded chunk), aborts safely: *"destination floor block is unknown or unloaded"*.
  3. If liquid hazard (`lava`, `water`, `flowing_lava`) exists at the floor or step destination, aborts immediately.
  4. If `boundingBox !== 'block'` (open air, drop, ravine, void), aborts immediately: *"unsupported drop or gap detected"*.
  5. Inspects overhead blocks: detects unsupported falling gravel or sand that could cause suffocation.
  6. Inspects adjacent blocks to avoid opening hidden lava or water pockets.
- **Post-Mining Verification**: Re-checks mined positions to confirm blocks are passable before stepping down.
- **Guaranteed Cleanup**: In a `finally` block, safely clears all movement, mining, and sneaking states.

### 5.6 Recursive Multi-Step Crafting Pipeline (`techniqueCraftPipeline`)
- Eliminates LLM round-trips for crafting chains:
  - If crafting a `wooden_pickaxe`:
    1. Crafts planks from logs.
    2. Crafts sticks from planks.
    3. If crafting table is needed: checks inventory or crafts a table, places it adjacent to the bot.
    4. Queries recipe for the final tool using the table and crafts it in one unified sequence.

---

## 6. Emergency Reflex Layer, Retaliation & Action Arbiter

### 6.1 Action Arbiter (`src/agent/arbiter.ts`)
- **Central Concurrency Coordinator**: Prevents conflicting actions by managing an `AbortController` cancellation token for active tasks.
- **Action Priorities**:
  - `ActionPriority.LOW = 10`: Background maintenance and idle tasks.
  - `ActionPriority.NORMAL = 50`: Standard LLM planned actions.
  - `ActionPriority.COMBAT_REFLEX = 80`: Combat retaliation and auto-attack.
  - `ActionPriority.SURVIVAL_EMERGENCY = 100`: Immediate survival reflexes (lava, drowning, falling).
- **Preemption Rule**: An action can only preempt the currently running action if `priority > currentAction.priority`. Survival emergencies can never be preempted by lower-priority actions.
- **Lifecycle Action ID Guard**: Generates a unique `actionId` upon `startAction()`. `finishAction(actionId)` strictly verifies that the finishing action owns the arbiter lock, preventing stale preempted actions from stopping or resetting newer actions.

### 6.2 Attacker Attribution & Retaliation (`src/agent/loop.ts`)
- **Attribution via Packet Data**: Mineflayer 4.x parses Minecraft `damage_event` packets, providing `packet.sourceCauseId - 1` as `source` in `bot.emit('entityHurt', entity, source)`.
- **Strict Distinction**:
  - If `source` is undefined or null, damage is recorded as `'environmental'` (fall, drowning, lava, cactus, void). **No arbitrary retaliation is triggered.**
  - If `entity.id !== bot.entity.id`, the damage was taken by another entity and ignored.
  - Self-damage (`source.id === bot.entity.id`) is recorded and ignored.
- **Live Target Validation**:
  - The attacker must be present in `bot.entities[source.id]`.
  - Must have `isValid !== false` and `health > 0`.
  - Must be within `autoAttackRadius` (default 4.5m).
- **Survival Precedence**: Retaliation is suppressed if the bot is in lava or drowning (`oxygen < 8`).
- **Owner & Friend Immunity**: Retaliation is strictly forbidden against owners, friends, or protected entities.
- **Opt-In Safety**: Auto-attack and combat retaliation remain disabled by default (`autoAttackHostiles = false`).

### 6.3 Environmental Reflexes (`src/agent/reflex.ts`)
- **Drowning Reflex**: If `inWater` and `oxygen < 8`, cancels eating (`deactivateItem()`), preempts the arbiter, and swims upward (`jump = true`) until oxygen recovers.
- **Lava Escape Reflex**: Cancels eating, actively scans 8 horizontal directions for confirmed solid, non-lava ground. If safe ground is found, paths and jumps toward it; if surrounded by lava column, jumps straight up rather than blindly walking forward.
- **Auto-Eat Guard**: Uses an `isEating` state lock to prevent overlapping eat invocations. Emergency reflexes interrupt eating immediately.

---

## 7. Robust LLM Parsing, Balanced Extraction & Schema Contract

Located in [`src/llm/parser.ts`](file:///b:/minecraft_ai_scratch/src/llm/parser.ts):

### 7.1 Balanced JSON Extraction Pipeline
Instead of fragile `indexOf('{')` and `lastIndexOf('}')`, the parser uses `extractAllBalancedJsonObjects`:
1. Strips markdown code fences (```` ```json ... ``` ````) anywhere in the text using regex.
2. Iterates characters while maintaining a string-literal state machine:
   - Tracks double quotes, correctly handling escaped quotes (`\"`).
   - Ignores braces `{` and `}` inside string literals.
   - Accurately tracks brace nesting depth outside string literals.
3. Extracts all top-level balanced `{ ... }` candidate substrings.
4. Validates candidates against `LLMResponseSchema`, selecting the first schema-conformant candidate.

### 7.2 Strict Schema Validation (`src/prompt/schema.ts`)
- `ActionItemSchema` is `.strict()`, rejecting unexpected properties.
- `action` is strictly validated against `z.enum(KNOWN_ACTION_NAMES)` (all 52 registered actions).
- `radius` must be positive; `target` must be non-empty strings.
- Rejects missing required fields, truncated JSON, empty responses, and malformed structures without crashing.
- Bounded retries (maximum 2 retries) with structured feedback for recoverable schema errors.

---

## 8. Safety Invariants, Entity Snapshot Guards & Command Boundaries

Located in [`src/safety/index.ts`](file:///b:/minecraft_ai_scratch/src/safety/index.ts):

### 8.1 Entity Snapshot & ID Binding (`resolveAndValidateTarget`)
To prevent the bot from attacking or interacting with stale entities when the server reuses entity IDs:
1. Validates that the entity exists in the observation snapshot.
2. Re-queries live `bot.entities[rawEntity.id]`.
3. Verifies `liveEntity.isValid !== false` and `liveEntity.health > 0`.
4. Verifies entity type matches the observation snapshot to catch server ID reuse.
5. Verifies distance is within reach (`<= 6.0m`).
6. Enforces owner and friend immunity.

### 8.2 Command Injection Hardening
Commands executed via `run_command` are strictly sanitized:
- Rejects shell injection metacharacters: `[\n\r;&|`$><\\()]`.
- Must match the configured `commandAllowlist` (e.g. `help`, `list`, `time`, `weather`).
- Non-owner chat messages are treated strictly as untrusted data.
- Never evaluates or executes arbitrary model-generated code (`no eval()`).

---

## 9. Persistent Memory & Goal Tracking

Located in [`src/memory/index.ts`](file:///b:/minecraft_ai_scratch/src/memory/index.ts):

- **Short-Term Rolling History**: Retains the last `N` steps (default 8) including step number, summary, action, and result status (`success`, `failed`, `interrupted`).
- **Persistent Per-World Storage**: Saved to `data/memory-<worldId>.json`:
  - `namedLocations`: Map of named coordinates (`home`, `base`, `mine`, `last_death`).
  - `facts`: Learned world facts.
  - `dangerZones`: Circular hazard areas to avoid.
  - `completedGoals`: History of accomplished milestones.

---

## 10. Dashboard, In-Game Control & Replay Tool

### 10.1 Interactive Console CLI (`src/ui/dashboard.ts`)
- `status`: Displays current goal, step count, health, food, position, auto-attack state, and last action.
- `attack-mode [on|off]`: Toggles real-time Auto-Attack defense mod.
- `pause` / `resume`: Pauses or resumes the agent loop.
- `step`: Approves a single step when `stepMode: true`.
- `goal <text>`: Dynamically sets a new goal.
- `quit` / `exit`: Flushes memory to disk, disconnects cleanly.

### 10.2 In-Game Owner Chat Commands
Any player listed in `agent.owners` can say in chat:
`!goal <goal>`, `!attack [on|off]`, `!pause`, `!resume`, `!step`.

### 10.3 Model Replay & Benchmarking Tool (`src/tools/replay.ts`)
Re-evaluates recorded JSONL step records against another model or provider to calculate **Valid Decision Rate (%)**, **Average Latency (ms)**, and **Token Usage**.

---

## 11. Testing Suite & Verification Results

The test suite runs with **Vitest**:

| Test File | Focus Area | Tests | Status |
| :--- | :--- | :--- | :--- |
| [`tests/json_parser.test.ts`](file:///b:/minecraft_ai_scratch/tests/json_parser.test.ts) | Balanced brace parser, escaped quotes, KNOWN_ACTION_NAMES validation | 12 | Passed |
| [`tests/techniques.test.ts`](file:///b:/minecraft_ai_scratch/tests/techniques.test.ts) | Preconditions, hazard checks, sneak-bridging, pillaring pitch & staircase | 13 | Passed |
| [`tests/safety.test.ts`](file:///b:/minecraft_ai_scratch/tests/safety.test.ts) | Target validation, ID reuse, owner immunity, command sanitization | 11 | Passed |
| [`tests/reflex.test.ts`](file:///b:/minecraft_ai_scratch/tests/reflex.test.ts) | Auto-attack opt-in, drowning/lava eating interruption, safe ground scan | 9 | Passed |
| [`tests/arbiter.test.ts`](file:///b:/minecraft_ai_scratch/tests/arbiter.test.ts) | Action priority preemption, unique action IDs, stale cleanup prevention | 5 | Passed |
| [`tests/scenario_loop.test.ts`](file:///b:/minecraft_ai_scratch/tests/scenario_loop.test.ts) | Multi-action plans, fresh observation revalidation, failure halting | 4 | Passed |
| [`tests/observation.test.ts`](file:///b:/minecraft_ai_scratch/tests/observation.test.ts) | 9x9 map with cliff `'v'` & unknown `'?'`, vitals & entities | 3 | Passed |
| [`tests/availability.test.ts`](file:///b:/minecraft_ai_scratch/tests/availability.test.ts) | Catalog filtering, pre-execution revalidation, timeout handling | 3 | Passed |
| [`tests/math.test.ts`](file:///b:/minecraft_ai_scratch/tests/math.test.ts) | Yaw-to-facing calculation, 3D Euclidean distance & coordinate bounds | 3 | Passed |
| [`tests/memory.test.ts`](file:///b:/minecraft_ai_scratch/tests/memory.test.ts) | Rolling step history limits & persistent per-world JSON storage | 2 | Passed |
| [`tests/config.test.ts`](file:///b:/minecraft_ai_scratch/tests/config.test.ts) | Default YAML config loading & Zod schema validation | 2 | Passed |

### Test Suite Execution:
```bash
npm test
```
**Output**: `11 passed (11 test files), 67 passed (67 tests)`.

### TypeScript Compilation:
```bash
npm run build
```
**Output**: `tsc` exited with code `0`. Compiles cleanly to `/dist` with zero TypeScript errors.
