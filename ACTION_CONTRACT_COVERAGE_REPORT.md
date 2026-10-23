# Machine-Readable Action Contract & Ground-Truth Coverage Manifest

> **Target Minecraft Version**: Java 1.21.6 (Protocol: 771, Data Version: 4435)  
> **Manifest Version**: 1.0.0  
> **Generated Timestamp**: 2026-10-22T15:19:46.020Z  
> **Source Registry**: `src/actions/registry.ts` (56 live actions registered)

---

## 1. Ground-Truth Coverage Rule

> [!IMPORTANT]
> **Strict Independent Oracle Rule**:
> **No action or composite technique may be designated as `LIVE_PASS` unless it has run against the real target server AND its expected postconditions were independently confirmed against server-observer evidence (e.g. structured NDJSON ground-truth event stream).**  
> A bot-reported internal `{ status: "success" }` return is **NOT** an independent oracle and cannot confer `LIVE_PASS` status.

---

## 2. Summary Statistics

| Metric | Count | Description |
| :--- | :---: | :--- |
| **Live Registered Actions** | **56** | Total distinct actions currently registered in `allActions` in `src/actions/registry.ts`. |
| **Composite Techniques / Macros** | **14** | Multi-step autonomous techniques (felling trees, vein extraction, shelter building, navigation, etc.). |
| **System & Survival Reflexes** | **8** | Critical survival reflexes (drowning, lava, flee, auto-eat), parser normalizer, lifecycle reconnect, arbiter. |
| **Unimplemented Features** | **6** | Explicitly marked as `NOT_IMPLEMENTED` (furnace smelting, water-bucket clutch, brewing, enchanting, nether portal, end dragon). |
| **Total Contracts Documented** | **84** | Comprehensive contract coverage across all actions and subsystems. |

### Current Coverage Status Breakdown

| Status | Count | Meaning |
| :--- | :---: | :--- |
| `UNIT_ONLY` | **77** | Verified by unit tests; mocked or isolated execution. |
| `MOCK_ONLY` | **0** | Verified via mocked integration scenarios. |
| `LIVE_PASS` | **1** | Verified against real server with independent ground-truth observer confirmation (`lifecycle_reconnect` via `scripts/verify_observer_live.ts`). |
| `LIVE_FAIL` | **0** | Failed during live server oracle verification. |
| `NOT_RUN` | **0** | Code exists but live test has not yet run with observer. |
| `BLOCKED` | **0** | Blocked by missing dependency or prerequisite. |
| `NOT_IMPLEMENTED` | **6** | Feature is absent from codebase; marked explicitly to avoid false claims. |

---

## 3. "Expected" vs "Actual" Verification Contract Definitions

For each action contract:
1. **"Expected" (Test-Case Contract)**:
   - Explicit definition of what success entails (e.g. Euclidean distance within range, inventory count increase, block converted to air, window opened).
   - For nondeterministic outcomes (e.g. tree log counts varying with tree species, drop rates varying with tool enchantments), **explicit invariants and bounded ranges** (e.g. `delta >= 1`, `Y_final === Y_initial + height`) are used rather than hardcoded coordinates or exact counts.
2. **"Actual" (Ground-Truth Observation)**:
   - Derived exclusively from independent server observations:
     - Structured NDJSON events: `BLOCK_BREAK`, `BLOCK_PLACE`, `ITEM_PICKUP`, `PLAYER_JOIN`, `CHAT_MESSAGE`.
     - Periodic vital snapshots: `position`, `health`, `food`, `oxygen`, `heldItem`, `inventory`, `movementState`.
     - Before/after differential state analysis.

---

## 4. Master Action & Technique Contract Registry

### A. Registered Movement Actions (13 Actions)

| Action Name | Source | Preconditions | Expected Contract & Invariants | Actual Oracle Verification | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| `goto` | `movementActions[0] (name: "goto")` | Target must not be a water hazard unless swimming permitted; Target must not be a blacklisted cliff/drop; Bot must be alive and not sleeping or riding | Euclidean distance from final bot position to target <= range + 0.5 blocks. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `follow` | `movementActions[1] (name: "follow")` | Target entity must not enter water hazard if bot is on dry land | Distance to target entity <= params.distance + 2.0 blocks across follow loop. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `flee` | `movementActions[2] (name: "flee")` | Candidate flee vectors must avoid water hazards and cliffs | Distance from bot to threat increases to at least initial distance + 5m or target distance. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `move` | `movementActions[3] (name: "move")` | Bot must halt immediately if movement causes entry into water hazard | Bot coordinates displace along movement vector proportional to duration. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `jump` | `movementActions[4] (name: "jump")` | Bot must be on ground or in water | Bot vertical position Y reaches peak > initial Y + 0.8m during jump arc. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `swim_up` | `movementActions[5] (name: "swim_up")` | Bot must be in water | Bot Y coordinate increases towards water surface. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `sprint` | `movementActions[6] (name: "sprint")` | Bot food level > 6 (sprint threshold) | bot.getControlState("sprint") === params.enabled. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `sneak` | `movementActions[7] (name: "sneak")` | Bot is not sleeping | bot.getControlState("sneak") === params.enabled. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `look_at` | `movementActions[8] (name: "look_at")` | Bot is not sleeping | Vector from bot eyes in yaw/pitch direction aligns with target vector within 0.1 rad. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `explore` | `movementActions[9] (name: "explore")` | Candidate exploration path must avoid water hazards and known cliffs; Automatic rerouting across alternate cardinal directions if primary blocked | Bot coordinates displace in explored direction and newly discovered blocks/mobs are returned. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `stop` | `movementActions[10] (name: "stop")` | Bot alive | pathfinder.stop() called, pathfinder.isMoving() === false, all controls false. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `pillar_up` | `movementActions[11] (name: "pillar_up")` | Gravity blocks (sand, gravel) and hazardous blocks forbidden | Final bot Y position === initial Y + height. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `bridge` | `movementActions[12] (name: "bridge")` | Bot crouches (sneaks) throughout bridging to prevent falling over ledge | Horizontal line of [distance] blocks placed and bot safely positioned at end. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `dig_block` | `miningBuildingActions[0] (name: "dig_block")` | Submerged blocks rejected to prevent drowning hazard | Target block at coordinates becomes air or broken block. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `mine_resource` | `miningBuildingActions[1] (name: "mine_resource")` | Rejects water-logged or submerged resource blocks | Mined count is between 1 and min(params.count, 8). | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `chop_tree` | `miningBuildingActions[2] (name: "chop_tree")` | Candidate tree must not be submerged under water; Bot pillars up with safe scaffolding (dirt) only if tall tree requires it; Automatic leaf clearance prevents suffocation | bot inventory net log count increases by >= 1 (or requested count). | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `place_block` | `miningBuildingActions[3] (name: "place_block")` | Target placement position must not intersect bot feet or suffocate bot | Block at (referencePos + faceVec) changes from air to placed block type. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `collect_items` | `miningBuildingActions[4] (name: "collect_items")` | Dropped item must not be floating over lava or deep drop | Bot coordinates match item location; total inventory item count increases. | ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `use_bucket` | `miningBuildingActions[5] (name: "use_bucket")` | Water bucket placement deferred/disabled in dangerous conditions; Lava handling requires fire resistance or clear clearance | Bucket in inventory switches state (bucket <-> water_bucket/lava_bucket). | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `till` | `miningBuildingActions[6] (name: "till")` | Hoe durability checked before use | Target block changes from dirt/grass_block to farmland. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `plant` | `miningBuildingActions[7] (name: "plant")` | Bot alive | Crop block appears atop farmland and seed inventory count decreases by 1. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `harvest` | `miningBuildingActions[8] (name: "harvest")` | Avoid breaking immature crops | Mature crop block broken; food items dropped or collected. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `mine_staircase` | `miningBuildingActions[9] (name: "mine_staircase")` | Never dig straight down: validates floor block before descending; Checks for water/lava pockets above and ahead of each step | Bot Y coordinate descends by [steps] blocks and X/Z advances forward. | BLOCK_BREAK, ITEM_PICKUP, BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `build_shelter` | `miningBuildingActions[10] (name: "build_shelter")` | Closed-loop physical enclosure verification confirms zero light leakage or hostile entry points; Safe resumption logic skips already placed blocks after interruption | Closed-loop enclosure report confirms enclosed === true with roof intact. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `vacuum_drops` | `miningBuildingActions[11] (name: "vacuum_drops")` | Items situated above lava or cliffs excluded from vacuum traversal | All reachable dropped items within radius are absorbed into inventory. | ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `mine_ore_vein` | `miningBuildingActions[12] (name: "mine_ore_vein")` | Strict 6 orthogonal neighbor traversal only (no corner digging); Tool breakage detection halts extraction safely or auto-switches to backup pickaxe; Adjacent lava/water checks before mining each vein block | Closed-loop net gain of expected drop items (e.g. raw_iron, coal, diamond) >= mined vein count. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `collect_resource` | `miningBuildingActions[13] (name: "collect_resource")` | Strict surface vs cave gathering separation: surface resources gathered above Y=50; Rejects mining submerged blocks | bot inventory net count for requested resource increases by >= [count]. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `equip` | `inventoryCraftingActions[0] (name: "equip")` | Bot must be alive and not sleeping | Item is present in target equipment slot (e.g. bot.heldItem.name === params.item). | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `select_hotbar` | `inventoryCraftingActions[1] (name: "select_hotbar")` | Container window must be closed | bot.quickBarSlot === params.slot (clamped between 0 and 8). | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `swap_hands` | `inventoryCraftingActions[2] (name: "swap_hands")` | Bot alive | Item previously in main hand moves to off-hand and vice-versa. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `drop` | `inventoryCraftingActions[3] (name: "drop")` | Protected items (tools, armor, workstations, rare ores) strictly guarded by survival policy | Target item inventory count decreases by [count] and item entity spawns on ground. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `eat` | `inventoryCraftingActions[4] (name: "eat")` | Toxic/harmful food (pufferfish, spider_eye, poisonous_potato, chorus_fruit) strictly rejected; Hunger < 20 or golden apple consumption permitted | Food item decremented by 1; bot.food increases by foodPoints. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `craft` | `inventoryCraftingActions[5] (name: "craft")` | Closed-loop crafting executor validates ingredient counts before craft | Target crafted item appears in inventory and ingredient items decremented accordingly. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `open_container` | `inventoryCraftingActions[6] (name: "open_container")` | Bot must not already have open container window | bot.currentWindow !== null and window slots are accessible. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `close_container` | `inventoryCraftingActions[7] (name: "close_container")` | Bot alive | bot.currentWindow === null. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `deposit` | `inventoryCraftingActions[8] (name: "deposit")` | Container window must be actively open | Item count decreases in player inventory and increases in container slots. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `withdraw` | `inventoryCraftingActions[9] (name: "withdraw")` | Container window must be actively open | Item count increases in player inventory and decreases in container slots. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `craft_pipeline` | `inventoryCraftingActions[10] (name: "craft_pipeline")` | Prevents recursive dependency loops and verifies intermediate ingredient deltas | Target item crafted in inventory; crafting table recovered if temporarily placed. | BLOCK_PLACE, BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `craft_item` | `inventoryCraftingActions[11] (name: "craft_item")` | Prevents crafting items when inventory has 0 free slots | Target item added to inventory in requested count. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `manage_full_inventory` | `inventoryCraftingActions[12] (name: "manage_full_inventory")` | Strictly preserves all tools, weapons, armor, food, ores, ingots, workstations, and reserved ingredients; Only allows disposal of non-essential allowlisted items (excess seeds, saplings, cobblestone > 128, dirt > 128) | Free inventory slots increase by >= 1; zero protected items discarded. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `attack` | `combatActions[0] (name: "attack")` | Friendly fire prevention strictly blocks attacking owner or whitelisted players; Halts melee approach if target enters water to avoid water hazards | bot.attack(rawEntity) executed; target entity takes damage or knocks back. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `attack_nearest` | `combatActions[1] (name: "attack_nearest")` | Attacks only verified hostile entities; ignores passive mobs and players | Closest hostile mob is targeted and attacked. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `block_with_shield` | `combatActions[2] (name: "block_with_shield")` | Equips shield to off-hand before activating | bot.activateItem(true) active for durationMs; damage from front blocked. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `shoot` | `combatActions[3] (name: "shoot")` | Friendly fire prevention strictly blocks shooting owner or whitelisted players | Arrow fired toward target; arrow count decremented by 1. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `interact_block` | `worldInteractionActions[0] (name: "interact_block")` | Container window must be closed | bot.activateBlock(targetBlock) executed; block state updates (e.g. door open). | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `interact_entity` | `worldInteractionActions[1] (name: "interact_entity")` | Entity must still be valid and alive | bot.activateEntity(rawEntity) executed. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `sleep` | `worldInteractionActions[2] (name: "sleep")` | Time must be night or thunderstorm; Dimension must be Overworld (sleeping in Nether/End causes lethal explosion); No hostile mobs within 8 blocks of bed | bot.isSleeping === true; world time advances to daybreak. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `wake` | `worldInteractionActions[3] (name: "wake")` | Bot alive | bot.isSleeping === false and bot stands up next to bed. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `mount` | `worldInteractionActions[4] (name: "mount")` | Bot must not already be riding an entity | bot.vehicle !== null and movementState.isRiding === true. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `dismount` | `worldInteractionActions[5] (name: "dismount")` | Check safe ground next to vehicle to dismount onto | bot.vehicle === null and movementState.isRiding === false. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `chat` | `metaActions[0] (name: "chat")` | Strictly rejects slash commands or command injection prefixes; Rate limited to 1 message per 1.5 seconds | bot.chat(sanitizedMessage) executed; message broadcast in public chat. | CHAT_MESSAGE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `wait` | `metaActions[1] (name: "wait")` | Interruptible immediately if emergency reflex triggers | Execution pauses for specified time unless interrupted. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `remember` | `metaActions[2] (name: "remember")` | Bot alive | observation.memory.namedLocations or facts updated. | ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `set_goal` | `metaActions[3] (name: "set_goal")` | Cannot overwrite pending owner instruction goals without completion | observation.agentState.currentGoal === params.goal. | ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `respawn` | `metaActions[4] (name: "respawn")` | Available ONLY when bot is dead | bot.isAlive becomes true and bot respawns at spawn point with full 20 health. | PLAYER_JOIN, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `run_command` | `metaActions[5] (name: "run_command")` | Strictly disabled by default (config.safety.allowCommandExecution === false); Injection filter rejects pipes, shell operators, semicolons, and control characters; Strictly executed as in-game chat command, never OS shell | bot.chat("/" + cmd) executed for allowlisted command. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |

---

### B. Composite Techniques & Internal Macros (14 Techniques)

| Technique Name | Source Implementation | Preconditions & Workstations | Expected Effects & Invariants | Actual Oracle Events | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| `techniquePillarUp` | `techniquePillarUp` | isSafeScaffoldingItem verifies blocks do not fall (rejects sand, gravel); Sneak held to prevent slipping off block during jump placement | bot.entity.position.y === initialY + height. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueBridge` | `techniqueBridge` | Sneak control state held continuously to prevent walking over edge | [distance] blocks placed horizontally at constant Y altitude. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueVacuumDrops` | `techniqueVacuumDrops` | Item entities floating over lava or deep chasms skipped | All safe items within radius collected into inventory. | ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueChopTreeFull` | `techniqueChopTreeFull` | Candidate tree must not be submerged under water; Leaf clearance prevents suffocation; Pillaring uses dirt scaffolding and descends cleanly | Net wood count in inventory increases by >= 1. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueCollectResource` | `techniqueCollectResource` | Rejects water-logged and submerged blocks | Net count of target resource items increases by >= [count]. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueMineStaircase` | `techniqueMineStaircase` | Never dig straight down: checks floor block before each descending step; Inspects ceiling and adjacent blocks for water or lava pockets | Bot Y altitude descends by [steps] blocks; staircase remains walkable. | BLOCK_BREAK, ITEM_PICKUP, BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueBuildVerifiedShelter` | `techniqueBuildVerifiedShelter` | Closed-loop physical enclosure verification confirms zero open gaps; Safe resumption logic skips already placed blocks after interruption | verifyShelterEnclosure returns enclosed === true with roof intact. | BLOCK_PLACE, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `withWorkstation` | `withWorkstation` | Auto-equips best tool (axe for crafting table, pickaxe for furnace) to recover station; Auto-vacuums dropped station item if broken | Callback fn succeeds and workstation is safely returned to inventory. | BLOCK_PLACE, BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueCraftPipeline` | `techniqueCraftPipeline` | Closed-loop verification of intermediate ingredient counts | Target tool item added to inventory. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueMineOreVein` | `techniqueMineOreVein` | Strict 6 orthogonal neighbor traversal only; Tool breakage detection halts or switches to backup; Adjacent lava/water checks before each block | Closed-loop inventory delta for raw ore items >= mined vein count. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `techniqueGatherSurfaceResource` | `techniqueGatherSurfaceResource` | Strict surface vs cave separation: rejects cave/underground blocks below Y=50; Rejects submerged underwater blocks | Target surface resource gathered and added to inventory. | BLOCK_BREAK, ITEM_PICKUP, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `navigateWithBounds` | `navigateWithBounds` | Enforces 3D vs horizontal elevation constraint integrity (GoalNear vs GoalNearXZ); Active physical stall detection aborts if position unchanged for stuckThresholdMs; Automatic blacklist recording on unreachable failure | Bot coordinates arrive within range of target destination. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `handleFullInventoryReliability` | `handleFullInventoryReliability` | Strictly protects all tools, weapons, armor, food, workstations, ores, ingots, and reserved ingredients; Purges only allowlisted disposable surplus (seeds, saplings, cobblestone > 128, dirt > 128) | freeSlots increased by >= 1; zero protected items discarded. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `selectBestFood` | `selectBestFood` | Strictly classifies foods into SAFE, RAW, POOR_EMERGENCY, and HARMFUL tiers; Excludes toxic items (pufferfish, spider_eye, poisonous_potato, chorus_fruit); Allows POOR_EMERGENCY only when starving to death (food <= 2 or health <= 6) | Selects optimal food item definition from inventory matching health/hunger priority. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |

---

### C. Survival Reflexes & System Contracts (8 Subsystems)

| Subsystem Contract | Source File | Preconditions / Trigger | Expected Behavior | Actual Verification | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| `drowning_reflex` | `ReflexLayer.evaluate (case 1: Drowning)` | Highest priority preemption (ActionPriority.CRITICAL_SAFETY); 3D BFS searches for reachable 2-block air pocket if ceiling blocks direct upward swim | Preempts active action, jumps/swims upward, and restores oxygen bar. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `lava_emergency_reflex` | `ReflexLayer.evaluate (case 2: Lava Emergency)` | Preempts active task with ActionPriority.CRITICAL_SAFETY; Scans for safe non-lava solid ground candidate within 6-10 blocks; Rejects escape candidates if route crosses lava or solid wall | Bot evacuates lava pocket within 1500ms; stops taking continuous lava damage. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `critical_health_flee_reflex` | `ReflexLayer.evaluate (case 3: Critical Health Flee)` | Preempts current work to preserve bot life | Distance from threatening mob increases; bot avoids lethal attack. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `auto_eat_reflex` | `ReflexLayer.evaluate (case 4: Auto-Eat Hunger/Health)` | selectBestFood verifies only SAFE food consumed; excludes toxic items; Interruptible immediately if higher-priority emergency (drowning/lava) triggers | Best safe food item consumed; bot.food replenished. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `auto_attack_hostile_reflex` | `ReflexLayer.evaluate (case 5: Auto-Attack Hostile)` | Only triggers if config.safety.reflexes.autoAttackHostiles is enabled; Strictly excludes owner and friendly players; Respects weapon cooldown | bot.attack executed on encroaching hostile mob. | PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |
| `llm_parser_normalization` | `parseLLMResponse` | Strips <think>...</think> reasoning tags safely; Strips markdown code fences (```json ... ```); Repairs unquoted keys, trailing commas, single quotes, and balanced JSON objects; Normalizes and filters action parameters against ACTION_ALLOWED_PARAMS schema | Parses valid JSON decision, strips unwanted tokens, normalizes action params. | Snapshot | **`UNIT_ONLY`** |
| `lifecycle_reconnect` | `ConnectionManager` | Verifies Minecraft Java 1.21.6 protocol: 771 (Data Version: 4435); Exponential backoff prevents reconnection floods upon server kick or end | Bot connects and spawns in world as dragonai with version 1.21.6. | PLAYER_JOIN, PERIODIC_SNAPSHOT, ACTION_BOUND, ACTION_UNBOUND | **`LIVE_PASS`** |
| `action_arbiter_preemption` | `ActionArbiter` | Action priority hierarchy: NORMAL < DEFENSIVE < CRITICAL_SAFETY; New actions safely preempt lower-priority running actions via AbortSignal | Higher-priority preemption fires abortSignal on active action and takes control. | ACTION_BOUND, ACTION_UNBOUND | **`UNIT_ONLY`** |

---

### D. Unimplemented Features (Explicitly Documented as NOT_IMPLEMENTED)

| Feature | Intended Function | Status | Reason & Policy |
| :--- | :--- | :---: | :--- |
| `smelt` | Smelts ores or cooks food in a furnace workstation using fuel (NOT YET IMPLEMENTED). | **`NOT_IMPLEMENTED`** | Feature absent or explicitly deferred by survival policy. |
| `water_bucket_clutch` | Water-bucket clutch fall mitigation maneuver (EXPLICITLY DISABLED/DEFERRED). | **`NOT_IMPLEMENTED`** | Feature absent or explicitly deferred by survival policy. |
| `brew_potion` | Brews potions at a brewing stand workstation (NOT YET IMPLEMENTED). | **`NOT_IMPLEMENTED`** | Feature absent or explicitly deferred by survival policy. |
| `enchant_item` | Enchants gear at an enchanting table or anvil (NOT YET IMPLEMENTED). | **`NOT_IMPLEMENTED`** | Feature absent or explicitly deferred by survival policy. |
| `build_nether_portal` | Erects 4x5 obsidian frame and ignites it to open a Nether portal (NOT YET IMPLEMENTED). | **`NOT_IMPLEMENTED`** | Feature absent or explicitly deferred by survival policy. |
| `defeat_ender_dragon` | Destroys End crystals on obsidian pillars, dodges breath attacks, and slays Ender Dragon (NOT YET IMPLEMENTED). | **`NOT_IMPLEMENTED`** | Feature absent or explicitly deferred by survival policy. |

---

## 5. Automated Validation & Coverage Assertion

The manifest is validated against the actual codebase via `tests/action_manifest.test.ts`:
- **100% Registry Alignment**: Every action in `src/actions/registry.ts` must have a contract in the manifest, and every registered action contract in the manifest must exist in the live registry.
- **Strict Coverage Rule**: No contract can have `LIVE_PASS` unless `liveServer === true` and `independentOracle === true`.
- **Schema Completeness**: All parameters, preconditions, invalid cases, expected effects, actual verification procedures, and failure cases are non-empty.

---

## 6. Artifact Files Generated

- **Machine-Readable JSON**: `data/action_contract_manifest.json`
- **Human-Readable Report**: `ACTION_CONTRACT_COVERAGE_REPORT.md`
- **Automated Validation Suite**: `tests/action_manifest.test.ts`
