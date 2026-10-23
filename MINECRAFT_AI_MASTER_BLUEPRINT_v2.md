# Master Blueprint v2.0: Autonomous Minecraft AI Agent

**Version:** 2.0 — revised after a full cross-plan technical review.
**Status:** Consolidated planning document; no implementation changes are authorized by this document.\
**Target:** Minecraft Java 1.21.6, Mineflayer 4.39, TypeScript,
Node.js.\
**Primary objective:** The LLM chooses and revises high-level goals;
reliable software performs the many low-level actions needed to achieve
them.\
**Source plans consolidated:** Claude Sonnet 5.5 final blueprint, Terra
5.6, Gemini 3.8 Flash, and Nemotron 3 Ultra, with useful diagnostic
points from the earlier Sonnet report.

------------------------------------------------------------------------

## 0. Executive decision

Build a **hierarchical, event-driven, goal-oriented agent**. The LLM
must not be the movement controller or the repeated decision-maker for
routine actions. It should issue goals such as `gather 32 logs`,
`produce 3 iron ingots`, `explore for iron`, or `build a shelter`. A
deterministic task executor decomposes these goals into reusable skills,
monitors progress, reacts to events, verifies results, and performs
bounded local recovery. The LLM is called again only when strategic
judgment is actually required.

The intended control loop is:

``` text
Owner instruction / strategic event
              |
              v
       Strategic LLM planner
       emits typed goals/tasks
              |
              v
       Task graph / scheduler
       prerequisites, budgets,
       reservations, checkpoints
              |
              v
       Autonomous skill runtime
       gather / navigate / craft /
       smelt / mine / build / fight
              |
              v
       Verified world and inventory state
              |
       +------+----------------------+
       |                             |
       v                             v
 Local recovery                Strategic escalation
 retries with changed          only when local choices
 evidence/strategy fail        are exhausted or priorities change

Independent safety supervisor can preempt normal work at any time.
World-state/event system feeds all layers.
```

This is not a proposal to replace every existing component. Preserve
sound infrastructure, especially the `ActionArbiter`, safety checks,
strict parameter validation, atomic memory writes, existing hazard-aware
mining, and workstation lifecycle concepts. Migrate current macros
behind a consistent skill contract first; improve their behavior after
tests establish a baseline.

**The first milestone is not "implement everything."** It is: the owner
issues `gather 32 logs` once, and the bot autonomously selects trees,
navigates, mines, collects drops, handles common failures, and verifies
the requested inventory increase---or returns a specific,
evidence-backed reason it could not finish.


## 0.1 Full cross-plan review: what was kept, changed, deferred or rejected

The four primary plans were reconsidered against the first master blueprint:

- `plan_sonnet5.5(1).md` — Claude's final, evidence-labelled investigation.
- `plan_terra_5.6.md` — state/event store, skill runtime, task executor and migration plan.
- `plan_gemini_3.8_flash.md` — detailed gameplay technique proposals and quantitative claims.
- `plan_nemotron_3_ultra.md` — concise phases for task queue, verification, recovery and tests.

The earlier incomplete `plan_sonnet5.5.md` was used only as a diagnostic supplement, not as a fifth complete plan. The matrix below is the decision record for this revision. “Accepted” means accepted as a design direction, not that the capability is implemented or that every source-plan detail is correct.

| Topic | Claude final | Terra 5.6 | Gemini 3.8 Flash | Nemotron 3 Ultra | Decision for this master |
|---|---|---|---|---|---|
| LLM as high-level planner | Strong | Strong | Strong | Strong | **Accept.** LLM emits validated goals / strategic task plans, not routine movement instructions. |
| Typed goals versus task graph | Typed `Goal` plus verification | Typed task graph and predicates | HTN `SubGoal` queue | `TaskNode` graph | **Combine carefully.** `GoalSpec` is the owner-level objective; a deterministic resolver expands known goals; a bounded DAG represents dependencies; each skill owns its bounded loops. Do not make the LLM build a graph for every simple gathering task. |
| LLM/event cadence | Detailed triggers and throttling | Clear call/do-not-call gates | 85–95% reduction estimate | <5 calls/min target | **Accept event-driven gating; reject unmeasured percentage/call-rate claims.** Nemotron’s “~60 calls/min” baseline is inconsistent with the reported ~35-second sequential LLM calls if one request blocks the next; define and measure calls per goal / wall-clock time instead. |
| Continuous safety | Supervisor and preemption | Highest-priority supervisor | Proposed 10–50 ms “thread” | More reflexes | **Accept independent async supervisor; correct “thread” language.** Node.js callbacks run on the event loop by default; synchronous CPU work can delay safety handlers. Keep event callbacks cheap and bound synchronous work. |
| Cancellation and stale actions | Epoch guard, abort, hard cancel, path watchdog | Locks, `AbortSignal`, stale-fact handling | Token / abort hierarchy | `Promise.race` recovery needed | **Accept and move early.** Racing a promise against a timeout is not cancellation. Use cooperative abort plus subsystem-specific stop operations and an epoch guard. Test late-settling promises. |
| World-state/event layer | Freshness, provenance, spatial cache | Reducer, TTL and state snapshots | Chunk palettes/acoustics | Event/physics consolidation | **Accept.** Add public Mineflayer events where supported, event coalescing, targeted rescans, TTL and a bounded persistent spatial cache. Do not treat inferred data as ground truth. |
| Exploration | Frontier search and negative results | Frontier + risk scoring | Detailed frontier engine | Horizontal goals and hazard cost | **Accept with budgets.** One owned path at a time; score candidate frontiers; use `GoalNearXZ` only for horizontal intents; log path status; cap distance/time and stop when the goal’s search budget is exhausted. |
| Path preflight | Reachability/cost oracle | `getPathTo`, watchdog | Fixed frontier movement | Improve horizontal goals | **Modify.** Pathfinder cost/search can itself consume event-loop time and is only a snapshot estimate. Run bounded preflight outside hot safety callbacks; revalidate after path planning. Prefer candidate ranking and diagnostics, not repeated expensive searches. |
| Resource gathering | `gather(item,count)`, tool-tier checks, blacklists | Gather adapter and inventory delta | 26-neighbor flood fill and vacuuming | Macro completion and verification | **Accept goal-level gather; modify flood fill.** Default ore vein connectivity to face-adjacent blocks (6-neighbor); diagonal connectivity can join distinct veins. Use distinct tree and ore policies, bounds, target freshness and inventory-delta verification. |
| Crafting / recipe planning | Recipe graph and quantity checks | `ensure_item`, reservations, verified `craft` | Hard-coded furnace recipe/fuel plan | Dependency graph | **Accept recipe resolver and material reservations.** Use version-pinned `minecraft-data`/Mineflayer recipes, compute counts, verify actual output, and do not hard-code one fixed pipeline. |
| Smelting | End-to-end skill | Furnace skill and station ownership | Specific event-driven furnace pipeline | Missing feature noted | **Accept closed-loop smelting.** Verify API names/types against the pinned Mineflayer version; listen for furnace updates but also reconcile state on a bounded timer. Only dismantle stations the bot owns. |
| Sound / “acoustics” | Probabilistic hypothesis + experiment | Expiring evidence | Claims triangulation and precise hazard location | Not developed deeply | **Narrow and defer.** Call this sound evidence, not triangulation. A sound packet is a cue, not proof of a mob, cave or fluid block; test what adds information beyond entity tracking before binding safety to it. |
| Combat | Threat model, state machine, retreat criteria | `engage_or_evade` | Kiting, shield, fixed timing/retreat rules | New reflexes | **Accept a bounded combat state machine later.** Do not copy fixed attack delays/health thresholds or assume every mob should be fought. Derive from version-supported item attributes and tune in arena trials. |
| Water-bucket MLG / lava actions | Deferred to validated policy | Defer advanced stunts | Early high-priority reflex | Fall/fires | **Defer advanced clutch techniques.** First make safe route selection, edge handling, drowning/lava response and retreat reliable. Water placement is dimension- and context-dependent; a failed clutch can increase danger. |
| Inventory compaction | Item prioritization and storage | Reservations and storage | Auto-craft logs to planks / ingots to blocks when slots low | Deposit/drop recovery | **Modify.** Never compact or craft merely because slots are low. Preserve optionality and reserved ingredients; deposit to known storage or drop only items allowed by policy. Convert logs/ingots only if a plan requires it. |
| Farming | Mature crop cycle | Farm/storage later | `metadata === 7` | Not core | **Keep later; correct state inspection.** Do not assume legacy block metadata. Inspect the version-pinned block-state properties (for example, an `age` property where present) and verify against actual `bot.registry`/block data. |
| Building / shelter | Explicit blueprint, placement order and enclosure verifier | Blueprint compiler and postconditions | Voxel placement engine | Build verification | **Accept.** Material bill, collision/face/support checks, resumable placement and block-state verification; a function return is not proof the shelter is enclosed. |
| Owner control | Identifies dropped chat and overwritten goals | Goal and policy ownership | General owner communication | Multi-goal and chat commands | **Make an early correctness gate.** Authenticate permitted owners; preserve owner goals; distinguish `stop/pause/replace goal`; no other player should be able to control the bot by default. |
| Persistent memory / experience | World cache, negative results, verified experience | Journal, freshness, skill admission | Chunk palette and logs | Experience buffer | **Accept in two stages.** First durable task journal plus bounded spatial cache. Later add experience retrieval; never promote a skill because it merely ran. |
| Integration testing | Detailed test/fault matrix and 10-trial target | Scenario suite and matched metrics | Bold live benchmarks | Local server and regression | **Accept test ladder; remove arbitrary promises.** Unit tests → fake-world/simulation → local-server integration → repeated live trials. Measure baseline first; avoid “zero deaths” or speed targets without evidence. |
| Implementation sequence | Baseline then substrate, goals, skills | State then executor and skills | Fast five-phase schedule | TaskQueue first | **Revise ordering.** Separate measurement from bug fixes, then establish cancellation/safety foundations before switching the main loop to event-driven goal execution. |
| Heavy planners / learned code | Defer RL and sandbox code generation | Small graph first | HTN/BT emphasis | Skill discovery later | **Keep simple at first.** Start with a small DAG, deterministic prerequisite resolver and skills with local loops. Add behavior trees only where fallback logic becomes genuinely complex. Defer RL and generated-code execution. |

### Important corrections made in v2

1. **Baseline and bug fixing are separated.** The previous Phase 0 attempted to measure the system while also repairing defects. That contaminates the baseline. The revised plan first captures a reproducible baseline without behavior changes, then fixes verified defects in isolated commits.
2. **The architecture distinguishes goal intent from task decomposition.** A known request such as “gather 32 logs” should be resolved by a registered deterministic skill. The LLM should not be required to regenerate a long task graph for each tree or crafting prerequisite.
3. **A “20 Hz safety thread” is not promised.** Node.js uses an event loop with a single JavaScript thread by default; long synchronous computation blocks event handlers. Safety latency must be measured. The bot should use inexpensive event-driven checks and bounded asynchronous supervisor work, not a fake hard-real-time guarantee. See the Node.js event-loop guide in Section 13.
4. **Path cancellation semantics are made explicit.** The current `mineflayer-pathfinder` docs distinguish stopping at a safe next node (`stop()`) from forcing path cancellation by clearing the goal (`setGoal(null)`). The actual installed version must be checked before implementing the cancellation adapter. See Section 13.
5. **Sound is evidence, not triangulation.** One location-tagged event does not constitute triangulation and does not prove a hidden hazard. Only use the public Mineflayer events that exist in the pinned dependency version, and test the information gain.
6. **Gameplay algorithms become more conservative.** Avoid hard-coded combat timings, unbounded exploration, diagonal ore flood-fill by default, automatic inventory compaction, unconditional water-bucket tricks and legacy crop metadata.
7. **The test/build claims remain unresolved until rerun.** The reports inspected divergent snapshots. No merged plan can tell which source state is current; only the authoritative working tree and executed commands can settle that.

## 1. Evidence and snapshot rules

The source plans did not all inspect an identical repository state.
Claude's final investigation explicitly reports that its snapshot was
dirty, had deleted tests and `package-lock.json`, and could not be
executed. Terra and Gemini report a 136-test/build baseline for their
inspected state. These claims must not be silently merged into one fact.

Use these labels in future implementation reports:

-   **Verified in source:** confirmed by inspecting the exact commit and
    working tree.
-   **Observed in logs:** present in dated runtime logs; note whether
    logs predate current code.
-   **Tested:** the exact command, environment and commit were run and
    passed.
-   **Live-verified:** the behavior was demonstrated in Minecraft Java
    1.21.6 under a documented scenario.
-   **Inferred:** plausible from code inspection but not yet reproduced.
-   **Opportunity:** new capability, not an existing defect.

Before changing code, record the current Git commit, branch,
`git status`, package manager/lockfile state, test directory, build
command and runtime configuration. Save a backup or commit the existing
working tree before restoring deleted files. Do not assume an old test
suite matches current uncommitted source. Never claim live competence
from unit tests alone.

## 2. The central design principles

1.  **Goals, not primitive commands.** The normal LLM interface should
    expose objectives and a small set of high-level skill types, not a
    catalog of low-level movement inputs.
2.  **Closed-loop skills.** Every skill observes, acts, checks progress,
    handles expected failures and verifies its postcondition. A resolved
    promise or success message is not sufficient evidence.
3.  **One owner per actuator.** At any moment, there is one owner of
    movement and one owner of a GUI/window. Competing skills and daemons
    must not independently write movement controls.
4.  **Safety can interrupt.** Emergency behavior must run while the LLM
    is waiting or a long skill is running. Normal tasks cannot override
    safety preemption.
5.  **Retry with changed evidence.** Never retry the same unreachable
    target or failed method indefinitely. A retry must change target,
    route, tool, state, or strategy.
6.  **Treat stale knowledge as unknown.** World facts need timestamps,
    confidence and provenance. Old observations must be revalidated
    before consequential actions.
7.  **LLM calls are event-driven.** Call for ambiguity, a new goal,
    meaningful strategic changes or exhausted local recovery---not
    routine movement, pickups or every completed substep.
8.  **No unsupported performance promises.** Measure calls per completed
    goal, inference wait time, task success, recovery rate and deaths
    before/after each phase.
9.  **Vanilla survival integrity.** Do not use `/give`, `/tp`,
    `/setblock`, `/time set`, peaceful-mode changes or other privileged
    commands in skills under test. Server commands may be used to set
    up/reset test fixtures only.
10. **Incremental migration.** Preserve working behavior behind
    adapters; change one capability at a time and keep regression tests.
11. **Event loop realism.** “Continuous” safety means asynchronously supervised on the running bot process, not a guaranteed hard-real-time thread. Keep synchronous callbacks short; no full-map scan or unbounded path search may execute inside a hot event listener.
12. **Deterministic first, LLM only when needed.** If a goal maps unambiguously to an existing skill or recipe resolver, execute it without an LLM planning call. Reserve model reasoning for ambiguity, strategic trade-offs and genuinely novel situations.
13. **Owner control is authenticated.** Only configured owners may set, replace, pause or cancel strategic goals. An owner `stop/pause` command preempts normal work, but never disables an active life-preserving reflex.

## 3. Baseline audit: findings to verify against the authoritative checkout

Claude's final snapshot identifies the following high-priority issues.
Treat them as a defect register to verify against the exact current
checkout before modifying anything.

### Critical execution and control issues

-   The main controller appears to build observations, evaluate
    reflexes, assemble an action catalog, call the LLM, and execute a
    small number of actions per step. Reported logs show a median LLM
    latency around 35 seconds across 18 calls, with repeated exploration
    failures and long idle periods. The logs are older than the final
    snapshot's working-tree code.
-   Reflex evaluation appears to happen before the LLM call rather than
    continuously. A water/physics daemon writes controls directly and
    may conflict with a running action.
-   `executeWithTimeout` uses promise racing; a timeout does not
    inherently cancel the underlying asynchronous operation. Pathfinder
    and other operations must be stopped cooperatively and prevented
    from mutating state after preemption.
-   Owner chat messages may be recorded as events but not included in
    the actual LLM prompt. The `pendingOwnerInstruction` field may never
    be assigned, and a goal supplied by the owner may be overwritten by
    a later model decision.
-   A fixed-direction exploration policy may repeat failed destinations
    without recording pathfinder status or blacklisting failed targets.

### Skill correctness issues reported by Claude

-   `chop_tree` may only cut one trunk column plus nearby base logs, and
    may report success after collecting fewer logs than requested.
-   `collect_resource` may repeatedly choose the same unreachable block
    and may not enforce the required tool tier before mining.
-   `craft_item` may ignore the requested count.
-   `craft_pipeline` may use a hard-coded sequence that lacks enough
    planks for a wooden pickaxe on its first attempt.
-   `build_shelter` may report success after placing zero blocks; the
    reference-block selection and roof verification may be incorrect.
-   The staircase mining torch placement may use an invalid reference
    face.
-   The bucket action schema, validator and executor may disagree on
    `fill`/`empty` versus `scoop`/`place`.
-   Auto-eating may select low-quality or harmful food, including rotten
    flesh or spider eye.
-   The reconnect logic may stop retrying if the server remains down
    during a reconnect attempt.
-   Listener cleanup using `removeAllListeners` may remove listeners
    owned by Mineflayer plugins or other subsystems.
-   A stale LLM decision may be executed after the world has materially
    changed during inference.

### Capability gaps reported by the plans

-   No complete closed-loop smelting workflow.
-   No persistent spatial map of explored regions, resources, bases,
    containers and failed targets.
-   Perception appears to rescan/samples local blocks rather than
    maintain an incremental world model; sampling can miss isolated
    ores.
-   Goal interpretation appears to rely partly on English-string/regex
    matching rather than typed goal structures.
-   The separate hard-coded survival automation pipeline may duplicate
    controller responsibilities and conflict with arbitrary owner goals.
-   Current tests, where present, rely heavily on mocks and do not
    establish live navigation, survival, GUI timing or task completion.

**Action:** Verify each finding in source and add a reproduction test
before treating it as confirmed. The plan should not blindly rewrite
components based on report wording.

## 4. Target architecture

### Layer 0 --- Mineflayer adapter and actuator ownership

Provide one controlled interface for movement, digging, placing,
equipping, inventory, windows, chat and pathfinding. All side effects
must pass through the skill context and ownership/cancellation checks.
Keep the existing `ActionArbiter` core if it proves sound. All low-level actions, macros and reflexes must use the same actuator ownership contract; no raw side channel may write movement controls while a different owner holds `movement`.

Cancellation is a protocol, not just an `AbortSignal`: mark the action epoch stale; signal cooperative cancellation; invoke the subsystem-specific stop operation; release controls/windows only if the cancelling action still owns them; then verify that no stale operation can issue another side effect. For `mineflayer-pathfinder`, the current upstream documentation says `stop()` stops after reaching the next node, while `setGoal(null)` forces immediate cancellation. Confirm the semantics in the project's pinned version and choose normal versus emergency cancellation deliberately rather than calling them interchangeably.

Actuator/resource locks should initially include:

-   `movement`
-   `hands/equip`
-   `window/gui`
-   `workstation`
-   `target-block` or a narrowly scoped world-mutation reservation
-   item/material reservations where tasks could otherwise consume each
    other's prerequisites

Start with serial skill execution. Do not introduce broad parallel
execution until cancellation and resource ownership are tested. Later,
safe background work (such as waiting for a furnace while observing
state) may be allowed only if it does not conflict with movement, GUI,
or reserved materials.

### Layer 1 --- World state and event reducer

Create a small state subsystem that consumes Mineflayer events and
targeted scans. Candidate events include block changes, chunk
load/unload, entity spawn/loss/hurt/death, inventory changes,
collection, health/oxygen/time changes, pathfinder updates, GUI/window
changes, chat, death, reconnect and sound events when available.

Represent facts with at least:

``` ts
interface ObservedFact<T> {
  value: T;
  observedAt: number;
  expiresAt?: number;
  confidence: number;
  source: 'event' | 'scan' | 'inference' | 'memory';
}
```

A fact outside a loaded/observed region or beyond its validity period is
**unknown**, not false. Coalesce noisy events and publish meaningful
deltas. Use broad scans when entering an unknown area or when a task
requires them; use targeted refreshes near a target before digging,
placing, attacking or using a workstation. Do not rebuild a huge
observation and prompt on every normal skill step.

Prefer the public Mineflayer event surface where available (for example, `bot.world` block-update events, chunk load/unload, entity and collection events, `soundEffectHeard`, `hardcodedSoundEffectHeard`, and pathfinder events). Do not depend on private packet names/fields just because a plan found a packet online. If a needed event is not available in the pinned release, isolate any packet-level adapter behind a version-specific test.

The store must be bounded: retain exact block cells mainly for useful/nearby regions, compress older knowledge into landmarks/resource sightings/negative search evidence, expire volatile facts and key the journal by server/world identity and dimension. Chunk unload must invalidate current loaded-state assumptions; it must not automatically erase all learned history. Coalesce high-frequency events (`physicsTick`, entity movement) into state deltas and threshold crossings, not one persistent record per tick.

### Layer 2 --- Safety supervisor

Run safety checks independently of LLM latency and normal skill execution, but do not describe a Node.js callback as a hard-real-time thread. JavaScript callbacks run on the event loop by default; CPU-heavy synchronous work can delay incoming events and timers. The supervisor should perform constant-time event classification, set/update hazard facts, and schedule bounded actions. Do not run a full map scan, graph search or long synchronous path computation inside `physicsTick` or a packet callback. Measure event-to-preemption latency instead of guaranteeing an untested number.

Use a hybrid trigger model: immediate handling for sharp events/threshold crossings (oxygen, damage, entity threat, fall/lava state), plus a modest scheduled safety audit to catch missed or stale events. Ensure only the supervisor owns emergency actuation. It must not independently race another control writer.

Priority policy:

1. **`SURVIVAL_EMERGENCY`** — immediate life-preserving escape from drowning, lava/fire, void/fall, suffocation, critical health/oxygen, or a demonstrably imminent hostile attack.
2. **`COMBAT_REFLEX`** — bounded defense/retreat when a current threat model says it is necessary.
3. **`OWNER_URGENT`** — authenticated `stop`, `pause`, or explicit goal replacement; preempts ordinary skills but cannot disable an active life-preserving reflex.
4. **`NORMAL`** — active owner goal and its skill sequence.
5. **`BACKGROUND`** — opportunistic collection, maintenance or autonomous progression.

New owner instructions are not all equivalent: `!stop`/`!pause` should cancel ordinary work promptly, while a new objective may be queued or replace the active goal according to explicit command semantics. A normal user goal never overrides the emergency supervisor. All non-owner chat must be ignored for control unless an explicit shared-control policy is configured.

A reflex returns a structured outcome such as `resolved`, `needs_recovery`, `interrupted`, or `fatal`. After an interruption, the task executor revalidates preconditions, path, target and inventory/window state before resuming. Resume is never assumed safe merely because the emergency ended.

### Layer 3 --- Reusable skill runtime

Migrate existing macros behind a standard contract before adding many
new ones. Each skill should define:

-   Preconditions and required tools/materials.
-   Resources/actuators it owns.
-   Input schema and bounded work budget.
-   Progress evidence and timeout/watchdog.
-   Postcondition verifier.
-   Failure taxonomy and bounded local recovery.
-   Cancellation behavior and checkpoint.
-   Telemetry/result record.

Illustrative interface:

``` ts
type SkillStatus = 'succeeded' | 'failed' | 'interrupted' | 'blocked' | 'satisfied';

interface SkillResult {
  status: SkillStatus;
  failureKind?: FailureKind;
  evidence: string[];
  inventoryDelta?: Record<string, number>;
  durationMs: number;
  suggestedNext?: string;
  progress?: { completed: number; total?: number; unit?: string; note?: string };
  actionEpoch?: number;
}

interface Skill<I> {
  canRun(state: WorldState, input: I): CheckResult;
  run(ctx: SkillContext, input: I): Promise<SkillResult>;
  verify(ctx: SkillContext, input: I, baseline: WorldState): Promise<Verification>;
}
```

`SkillContext` must expose an `AbortSignal`, action epoch/generation,
`isCurrent()`, controlled actuators, progress reporting and a pathfinder
wrapper with watchdogs. After every awaited operation that can lead to a
side effect, a skill must check that it still owns the action. A late
promise must not clear the state of a newer action or continue changing
the world.

### Layer 4 --- Task graph and execution monitor

Separate three concepts:

1. **`GoalSpec`** — the owner's intended outcome (for example, have 32 logs, collect 32 additional logs, find iron, build a named blueprint).
2. **`GoalResolver` / deterministic decomposer** — expands common goal types into known skills and resolves finite prerequisite graphs (such as recipes and tool tiers) without asking the LLM to re-plan each known step.
3. **`TaskPlan`** — a bounded DAG of ready/blocked/running/satisfied/succeeded/failed/cancelled nodes when multiple skills or prerequisites must be coordinated.

The LLM is only required to interpret ambiguous natural language, select among strategic alternatives, or propose a validated task plan for a novel objective. A known `gather(resource, amount)` goal should enter the registered gathering skill directly. The skill, not the LLM, owns its bounded loop over targets, block breaks and pickup attempts.

Start with a small DAG/task graph; do not implement a general-purpose HTN/PDDL framework unless actual task complexity demands it. Acyclic task plans simplify dependency reasoning; repeating/conditional behavior belongs in a bounded skill or explicit bounded loop node, not an accidental graph cycle. A behavior-tree-like sequence/fallback/retry structure may be added for skills with complex reactive branches.

Suggested initial goal types:

``` ts
type Goal =
  | { kind: 'have'; item: string; count: number; mode: 'absolute' | 'additional' }
  | { kind: 'have_tool'; tool: string; tier?: string }
  | { kind: 'reach'; target: string | { x: number; y: number; z: number }; tolerance?: number }
  | { kind: 'explore'; query?: string; region?: string }
  | { kind: 'build'; blueprintId: string; anchor?: unknown }
  | { kind: 'survive_until'; condition: string }
  | { kind: 'kill'; entityType: string; count: number };
```

Each task node should include IDs, prerequisites, typed inputs,
preconditions, success predicates, resource/material reservations, risk
budget, timeout, recovery budget and status (`pending`, `ready`, `running`,
`satisfied`, `succeeded`, `blocked`, `failed`, `interrupted`, or `cancelled`). Quantity goals must
distinguish "have 32 total" from "collect 32 more"; record the baseline
when the goal starts. The validator must check known item/block IDs,
allowed task kinds, graph acyclicity, quantities, bounds and
authorization.

The execution monitor verifies state deltas, not claims. Examples:
gather checks inventory increase or a verified transfer;
crafting/smelting checks output count; building checks each required
block state; reaching a target checks actual position tolerance; combat
checks valid entity/kill attribution. A task that resolves without
meeting its postcondition is not complete.

### Layer 5 --- Strategic LLM planner

The LLM handles:

- Interpreting genuinely ambiguous or novel owner instructions.
- Choosing long-term objectives and strategic trade-offs.
- Producing a bounded typed task plan when registered deterministic decomposition is insufficient.
- Revising strategy after local recovery is exhausted or the active plan is invalidated by a material change.
- Evaluating discoveries that meaningfully change the owner's objective.

The planner runs asynchronously and must not block the safety supervisor or an already-safe running skill. Maintain **one in-flight strategic request** by default; coalesce events while it is running. Every request records the active goal ID, plan version, world-state version/digest and request timestamp. When a response arrives, validate its schema and compare against current state. Reject or replan stale responses rather than executing a plan based on old coordinates or a now-dead target.

For well-known tasks, bypass strategic planning where possible: a recognized `gather 32 oak logs` can produce a validated `GoalSpec` and be resolved by deterministic code. A broad instruction such as “prepare us for iron mining” may need one LLM request to choose an approach and produce a bounded plan. Do not call the LLM just to report task completion when a simple owner-facing result message will do; only plan the next objective if autonomous continuation is explicitly enabled.

The model must not directly emit arbitrary JavaScript or raw Mineflayer calls for execution. Its output passes a strict schema and deterministic validator. Generate LLM-facing schemas, runtime validation and catalog descriptions from one canonical schema source (for example, Zod) rather than maintaining parallel lists that can drift. Use constrained JSON output where supported and evaluate goal/plan reliability on a recorded set of examples before relying on it.

### Layer 6 --- Persistent journal and experience

Extend current memory into a versioned journal storing:

-   Active goal/task graph, statuses and checkpoints.
-   Verified task outcomes, inventory deltas, failures and durations.
-   Spatial landmarks, resource sightings, known
    bases/chests/workstations, explored chunks and failed/blacklisted
    targets.
-   Observation freshness, confidence and provenance.
-   Skill version and the evidence that justified retaining it.
-   Short context-specific experience summaries (for example,
    exploration strategies that worked in a biome).

Do not treat old coordinates as guaranteed truth. Expire or revalidate spatial records. Key data by server/world identity and dimension; never mix a single-player world, another server, or the Nether/Overworld. Bound per-chunk detail and keep older information as compressed landmarks, resource hints, and negative search results. Store only successful strategies whose postconditions were verified. Begin with parameterized, reviewed skills; generated code skills are a later, sandboxed research direction, not a phase-one requirement.

Goal/task statuses must distinguish **already satisfied at plan start** from **completed by this run**. On restart, rebuild volatile state from new events/scans, then resume from a checkpoint only after validating the next action's preconditions. Persist intent and evidence, not “the world is still here as I last saw it.”

## 5. Shared failure taxonomy and recovery

Use a typed failure classification rather than free-form error strings
alone. Start with:

-   `TARGET_NOT_OBSERVED`
-   `TARGET_STALE`
-   `PATH_UNREACHABLE`
-   `PATH_STOPPED`
-   `PATH_TIMEOUT`
-   `NO_PROGRESS`
-   `BLOCKED_BY_ENTITY`
-   `HAZARD_BLOCKED`
-   `WATER_TRAP`
-   `MISSING_ITEM`
-   `MISSING_TOOL_TIER`
-   `MISSING_FUEL`
-   `INVENTORY_FULL`
-   `DROP_UNCOLLECTED`
-   `WINDOW_DESYNC`
-   `NO_SAFE_WORKSTATION_SITE`
-   `PREEMPTED`
-   `SERVER_DISCONNECTED`
-   `POSTCONDITION_FALSE`

Recovery must change something material: refresh state, select another
target, test reachability, choose a different route, equip the correct
tool, clear inventory according to policy, find/place a safe
workstation, re-open a desynchronized window once, or retreat from a
hazard. Blacklist a failed target temporarily with the reason and TTL.
After a small number of distinct strategies, escalate a concise failure
packet to the LLM.

For pathfinding, record `path_update`, `path_reset`, `goal_reached`, `path_stop`, position deltas and stop reasons. Use `getPathTo`/path-cost checks where supported, but treat them as estimates that can become stale and may consume event-loop time. Bound the search, invoke it outside hot safety callbacks, and revalidate the route/target immediately before execution. For a route failure, try a meaningfully different target/route/configuration; do not repeatedly replace the active path goal on a timer or label every stopped path “unreachable.”

## 6. Autonomous technique catalogue

The catalogue below is intentionally broader than the examples initially
supplied by the owner. Each capability should be implemented as a
reusable closed-loop skill, not as a new LLM prompt per micro-action.

### 6.1 Resource gathering: `gather(resource, amount)`

`gather(resource, amount)` means complete a quantity-based objective, not one `mine_resource` action. At start, resolve whether the owner asked for an **absolute inventory target** (“have 32 logs”) or an **additional amount** (“gather 32 more logs”) and record the baseline. Resolve target item to source block/drop, relevant variants, required tool tier and safe collection policy. Rank candidates by estimated path cost, hazard exposure, tool feasibility, expected yield and observation freshness—not just straight-line distance.

For each candidate: verify it is still loaded/current, verify the bot can harvest it with the selected tool, navigate under one path owner, recheck hazards before the side effect, perform bounded mining/chopping, collect relevant drops, and reconcile the inventory delta. Stop at the requested quantity or a typed terminal reason. A call that successfully breaks a block but yields no item is not proof of resource acquisition.

Keep different algorithms for different resources:

- **Ore veins:** after finding a seed block, discover the vein incrementally. Use face-adjacent (6-neighbor) connectivity by default; diagonal neighbours can accidentally merge distinct deposits. Bound maximum blocks/scan volume and revalidate each block before mining. Optional wider connectivity is only a configurable heuristic after evaluation.
- **Trees:** identify likely natural tree components using log/leaf connectivity, species/shape rules and a bounded search; do not blindly treat every nearby log as a tree or use tree logic on player-built structures. Vanilla trees do not automatically fall when the base trunk is cut, so choose a reachable, safe harvest order rather than assuming a top-down cut makes the whole tree drop. Use a separate policy for 2x2 trunks, roots and inaccessible canopy, and stop if safe access would require untested scaffolding.
- **Drops:** use entity tracking and collection events where available, then verify inventory change. Do not rely solely on the item entity being within a fixed radius or on a tiny path goal tolerance. Bound waiting, recheck the drop is still present, and return `DROP_UNCOLLECTED` if pickup cannot be verified.

Recovery: no resource visible -> query-directed exploration within a distance/time budget; missing tool -> add a `have_tool` prerequisite if safe/feasible; inventory full -> deposit or discard only policy-approved items; hostile threat -> safety/combat handoff; unreachable/failed target -> blacklist with reason and TTL, then rank a different candidate. Every recovery must alter evidence or strategy.

**Acceptance:** `gather 32 logs` on a suitable spawn reaches the defined inventory target with verified inventory delta, no repeated blacklisted target, and no LLM calls for routine tree selection/mining. The skill can return a clear `NOT_FOUND_WITHIN_BUDGET`, `MISSING_TOOL_TIER`, `INVENTORY_FULL`, or other typed reason rather than claiming success.

### 6.2 Exploration and navigation

Replace repeated compass guesses with **bounded, query-directed frontier exploration**. Maintain per-region/chunk metadata such as unknown/partial/adequately-scanned, last seen, scan completeness, biome/elevation hints when available, hazards, found resources, failures and paths. Select the next candidate according to query relevance, estimated route cost, risk and prior negative search evidence.

A chunk is not “explored” merely because the bot arrived at its edge; define minimum observation/coverage criteria. Reuse one movement goal until reached, invalidated or blocked. A skill may set segmented intermediate goals for long travel, but every segment belongs to the same skill and consumes the goal's time/distance budget. Stop after the target is found, the budget expires, or the configured search region is exhausted; do not promise to roam hundreds of blocks indefinitely for a single high-level call.

For “find wood,” use biome/tree priors and available block observations. For “find iron,” use currently relevant Minecraft-version/dimension heuristics, exposed ore/cave signals and configured search budgets rather than hard-coding a single Y coordinate as universally optimal. Store negative results with region and observation confidence so the agent does not immediately search the same ground again.

Path candidate preflight may use `getPathTo`/path cost and movement constraints from the pinned `mineflayer-pathfinder` version. A path estimate is not a guarantee: it can become stale as chunks/entities change, and path computations must be bounded because event-loop work can delay safety handlers. Dynamic hazard weighting should only be implemented through supported movement costs or candidate scoring that has been tested; do not assume a global `blocksToAvoid` edit alone supplies full dynamic risk-aware planning.

**Acceptance:** over a fixed suite of terrains/seeds, exploration coverage grows, unreachable destinations are blacklisted and not repeated without new evidence, `GoalNearXZ` is used only for horizontal intents, and a search cleanly returns “not found within budget” instead of endlessly circling.

### 6.3 Crafting and production: `produce(item, count)`

Build a recipe dependency resolver using the pinned version's `minecraft-data`, Mineflayer recipe API and item/block registry. Compute exact ingredient quantities, recipe output multiplicity, crafting grid/workstation requirements and stack constraints. Reuse already-owned/nearby stations where safe, reserve ingredients for dependent goals, and do not count a recipe as complete until the actual output delta is verified. Query recipes on demand rather than recalculating every possible recipe on every heartbeat.

Add `smelt(input, output, count)` as a closed-loop skill. It should:

1. Validate input quantity, recipe compatibility, output target, free inventory space and a feasible fuel plan.
2. Reuse a known safe station if available; otherwise find and place one without blocking an exit. Track whether the bot owns/placed it.
3. Open the furnace through the API supported by the pinned Mineflayer version. Current upstream docs describe `bot.openFurnace`, furnace `update`, `putInput`, `putFuel`, `outputItem`, `progress` and `takeOutput`; verify these against the project's installed version before coding.
4. Insert input/fuel, monitor furnace updates, and periodically reconcile slot/inventory state so a missed event does not deadlock the skill. Fuel rates should come from a versioned/centralized table with tests, not scattered literals.
5. On timeout or interruption, distinguish fuel exhaustion, missing input, output blockage, GUI desynchronization and preemption. Close the window when safe, checkpoint progress, and resume only after state revalidation.
6. Verify requested output count. Recover/dismantle only a station that the bot placed and still owns, and only when doing so is safe and useful.

Never burn tools or reserved/valuable items just because they are technically burnable. Do not use a single fixed fuel choice for every goal: respect resource conservation policy and planned downstream needs.

**Acceptance:** a quantity-based craft goal is correct on the first run from stated inputs; `smelt 3 raw iron into 3 iron ingots` verifies output in a vanilla survival scenario; cancellations and fuel depletion leave the station/inventory in a recoverable state.

### 6.4 Survival and reflexes

Implement survival in risk order, not by adding every dramatic maneuver at once:

1. Detect and respond to drowning/oxygen loss, lava/fire, critical health, falling/void risk, suffocation and unsafe gravity-block excavation.
2. Rank food based on actual food/saturation properties; protect reserved food and avoid harmful items unless an explicit emergency threshold permits them.
3. Use safe navigation: avoid edges, unsupported floors, known liquid hazards and dangerous drops; maintain a retreat route during cave work.
4. Add fire-resistant equipment use, night shelter/bed policy, and advanced fall mitigation only after their conditions and failure behavior are tested.

The safety supervisor should use fast signals and cheap state updates. If it relies on vertical velocity/fall distance or a raycast to time a water-bucket rescue, validate the relevant Mineflayer properties and tick timing first. Do not implement MLG-water or bucket placement as a guaranteed rescue: the maneuver is timing-sensitive, can fail due to network/server timing, may require the bucket slot/placement face, and water cannot be used normally in the Nether. Never let the reflex repeatedly place/collect water in a way that worsens an emergency.

Lava response is dimension- and context-dependent. An unconditional “place water to turn lava solid” policy is not valid everywhere and can fail in the Nether. Prefer retreat/escape-route logic, hazard containment only under verified safe conditions, and conservative escalation when no safe deterministic response exists.

On interrupt, return structured outcome (`resolved`, `needs_recovery`, `fatal`, or `not_safe_to_resume`). Normal work resumes only after target, route, inventory and environment conditions are revalidated.

### 6.5 Combat and threat management

Implement a bounded combat state machine after cancellation, tracking and survival response are reliable. Track known entities, recent positions, mob type, distance, line of sight, observed attacks/damage, player health/armor, weapon attributes, cooldown estimates and escape-route risks. Choose between `engage`, `block`, `evade`, `retreat` or `ignore` using a risk policy rather than treating every hostile entity as a mandatory fight.

Support sustained combat as one skill: target validation, equipment choice, safe distance/positioning, cooldown-aware attack, hit/outcome monitoring and an explicit exit condition. Derive attack timing from version-supported item attributes/mechanics where available and verify actual hit/attack evidence; do not copy fixed `625 ms`/`1000 ms` delays from an illustrative plan as universal constants. Server lag, weapon attributes and plugin rules can alter practical timing.

Creeper and skeleton tactics should be guarded by state evidence and fallback behavior. Do not assume a creeper can always be reset by a fixed backward distance; do not assume drawing/aiming state is always observable; do not pillar up automatically at a fixed health threshold. Retreat routes must account for cliffs, water, lava and other mobs. Configure and measure threat thresholds through repeatable arena trials.

Keep kill attribution conservative: entity death nearby is not proof the bot caused it. A combat result should include the observed target transition and evidence supporting attribution.

**Acceptance:** in a controlled arena with fixed equipment and test conditions, report survival, damage, hits/attempts, escapes and failures over repeated runs. Establish the pass threshold after a baseline rather than promising zero deaths in all conditions.

### 6.6 Sound and uncertain environmental evidence

Treat sound as an optional **evidence source**, not “acoustic triangulation.” Mineflayer's documented event interface includes `soundEffectHeard(soundName, position, volume, pitch)` and `hardcodedSoundEffectHeard(soundId, soundCategory, position, volume, pitch)` in current upstream documentation; confirm the exact signatures and behavior in the pinned 4.39 dependency before using them. Prefer these public events over private raw `_client` packet hooks unless a demonstrated requirement cannot be met publicly.

Normalize each cue into `SoundEvidence` containing event time, known/unknown source position, mapped sound identifier, category/volume, confidence and expiry. A cue can update a threat/hazard hypothesis and alter local behavior without triggering the LLM. A zombie ambience event is not proof of a particular zombie location unless its event semantics establish that location; lava/water ambience is not proof that a liquid block exists at the packet coordinate; a creeper-related cue must be validated for the target version and observed timing before it triggers an emergency rule.

Run the experiment first: during controlled cave/night scenarios, log sound events beside entity tracking, block observations and actual threats. Measure new information gained, lead time, false positives and missed events. Implement sound-triggered tactical policy only when the experiment shows useful information beyond normal entity tracking. Keep sound hypotheses short-lived and never tunnel toward a sound without a separate safety policy.

### 6.7 Mining and cave safety

Provide policy-selected mining strategies: staircase descent, branch
mining, strip mining and exposed-ore/cave mining. Check floor support,
overhead gravity blocks, liquids, lava evidence, light, hostile
entities, tool tier, durability and escape route before each dangerous
excavation. Place torches using a valid adjacent support face and verify
placement. Keep breadcrumbs/return routes and stop or return when
inventory, durability, health or food reaches configured limits.

Do not dig straight down under the agent. Plug or retreat from liquid
breaches according to a tested policy. Mine only what the skill contract
requests and verify drops rather than assuming breaking a block produced
an item.

### 6.8 Inventory, tools and logistics

Implement tool selection using actual block/tool compatibility and
durability; reserve essential tools, food and materials. Use a
consistent hotbar policy, stack limits and item-priority table. When
inventory is full, deposit into indexed known containers or discard only
explicitly low-value items. Track chest contents as uncertain until
revalidated. Do not consume ingredients reserved for a higher-priority
goal.

### 6.9 Building and shelter

Represent a blueprint as required block positions and desired block
types. Compute a valid placement order, reachable placement faces and
material bill before starting. Place bottom-up where appropriate, check
references/support, verify each placed block and checkpoint progress.
For shelter, verify the roof/walls/doorway and enclosure; a successful
function return or nonzero placement count alone is not enough. Offer a
cheap dig-in shelter as a separate strategy when materials are limited.

### 6.10 Farming and longer-term progression

After core gathering/crafting/survival are reliable, add bounded farming
cycles (till, plant, wait, harvest, replant), animal husbandry, storage,
transportation and base logistics. A declarative progression graph can
represent wood → stone → iron → diamond → Nether/End, but should propose
objectives when idle and never silently override owner goals. Nether/End
capabilities come only after the core safety, navigation and recovery
acceptance suite passes.

### 6.11 Learning and skill improvement

Record `ExperienceRecord` entries with goal, context, selected skill
sequence, outcome, failure kind, duration, inventory delta and LLM
calls. Use them to rank strategies and give the LLM concise context. Do
not call a skill "learned" just because it was attempted. Admit a
strategy to the reusable skill library only after objective
verification, versioning and regression evaluation. Free-form
LLM-generated code execution remains optional and sandboxed.

### 6.12 Ongoing capability discovery: the catalogue is not a ceiling

The catalogue above is an initial backlog, not a complete list of techniques. A core part of the engineering process is to discover useful behaviors that are not already named here. This addresses the risk that the implementation becomes a larger collection of hand-written examples without continuing to improve its autonomy.

Before starting work on a subsystem, the coding/research agent must:

1. Inspect the current implementation, logs and task failures for decisions still being delegated to the runtime LLM or routines that repeatedly fail.
2. Search relevant open-source implementations, issue discussions, version-specific APIs and research; inspect source code or tests where possible rather than trusting a README claim alone.
3. Generate new technique candidates that are not already in this blueprint. For each, state the use case, mechanism, evidence/source, required observations, safety risks, code cost and measurable success criterion.
4. Classify each candidate as a deterministic algorithm, reactive state machine, reusable skill, task-planning feature, research experiment or capability to defer. Do not force every problem into a script or a behavior tree.
5. Compare each candidate against existing skills and avoid duplicate mechanisms. Add it to a prioritized capability backlog only when it has a distinct benefit.
6. Implement the highest-value, testable candidate behind the skill/runtime contracts. Run unit/fake-world tests first, then a targeted local-server experiment; retain or reject it based on observed results.
7. Update the capability map, architectural decision record and tests to document what was learned, including techniques that were rejected and why.

Keep two roles separate:

- The **runtime Minecraft LLM** chooses and revises objectives using the capabilities currently registered in the bot. It must not silently invent and execute arbitrary code or pretend an unimplemented capability exists.
- The **development/coding agent** can research repositories and propose or implement new skills over time, but it must preserve the current working tree, show evidence, and pass the implementation phase gates.

This process should run at each major phase and after repeated live failures. The end state is not a frozen list of macros; it is a growing, measured library of reusable capabilities, each with known preconditions, limitations, recovery behavior and evidence of when it works.

## 7. LLM invocation and escalation policy

### Call the LLM when

-   A non-trivial owner instruction arrives or is ambiguous.
-   A new goal requires strategic decomposition.
-   The task graph is empty and autonomous continuation is allowed.
-   A major discovery changes priorities.
-   Local recovery has exhausted a bounded set of meaningfully different
    strategies.
-   A goal is infeasible after a bounded, query-directed search.
-   An unmodelled situation requires judgment.
-   A long-running session reaches a configured strategic review point,
    if needed to prevent drift.

### Do not call the LLM for

-   Each movement or direction correction.
-   Routine digging, tree-to-tree selection, drop pickup or inventory
    collection.
-   Normal pathfinder replans.
-   Routine eating/equipping/torch placement.
-   One failed dig or ordinary chunk load.
-   Routine reflexes and common hazard responses.
-   Every task substep or status poll.
-   Sound events that only require a local threat-map update.

### Escalation packet

Send a compact structured packet rather than raw repeated observations:

``` json
{
  "activeGoal": {"kind": "have", "item": "oak_log", "count": 32},
  "goalStatus": "blocked",
  "progress": {"baseline": 0, "current": 12, "target": 32},
  "location": {"region": "forest-edge", "observedAt": 0},
  "recentMaterialEvents": [],
  "failures": [
    {"kind": "PATH_UNREACHABLE", "attempts": 2, "targetsTried": 2}
  ],
  "localStrategiesTried": ["nearest candidate", "alternate candidate"],
  "availableSkills": ["gather", "explore", "craft", "retreat"],
  "decisionNeeded": "Choose another resource region or revise the goal"
}
```

The values above are illustrative, not real measurements. Include only
relevant state, fresh facts, current goals, recent material events,
verified progress and distinct failed strategies. Do not include a large
ASCII map by default.

Use event coalescing and a minimum interval between ordinary strategic
calls; allow emergency safety to bypass the strategic-call throttle
because it should not depend on the LLM. Avoid overlapping LLM requests
that can return contradictory plans. A response generated against
materially stale state should be discarded or revalidated.

### Honest call-reduction target

The existing log evidence described by the reports is small and old. A
plausible design hypothesis is that a quantity-based goal such as
gathering 32 logs can move from many tree-level calls to one
goal-issuance call plus zero or one escalation/completion call. This is
not a universal 85--95% guarantee. Measure:

- LLM calls per completed goal.
- LLM wall-clock seconds per goal and per game minute.
- Prompt/completion tokens per goal.
- Time spent waiting for inference.
- Task success rate and recovery count.

Compare fixed scenarios before and after each phase.

## 8. Phased implementation roadmap

### Phase 0A --- Freeze and measure the current system (no behavior fixes)

1. Record Git branch/commit/status and preserve the complete working tree. Use a branch/backup or commit before restoring any deleted files.
2. Reconcile the divergent source states described by the four plans: confirm whether `tests/` exists, whether `package-lock.json` is present and trustworthy, which source files are uncommitted, and which tests match the current code.
3. Install using the repository's chosen package manager and a verified lockfile; run the existing test/build commands exactly as found in package scripts. Do not report an earlier agent's test claim as current evidence.
4. First archive and inspect existing logs without changing code. Then, if existing telemetry is insufficient, add an explicitly telemetry-only instrumentation commit (no policy change) and run a controlled session. Record LLM request start/end, prompt/output tokens, task duration, path updates/resets, progress, inventory deltas, deaths and reconnects; note any instrumentation overhead.
5. Snapshot logs and test outputs outside production `logs/` and `data/` directories. Preserve a commit hash and config with each result.

**Exit criteria:** an exact snapshot and reproducible command results; a short live baseline or an explicit blocker; enough telemetry to diagnose repeated `explore` failure rather than speculate about its cause. No behavioral fixes are mixed into this baseline commit.

### Phase 0B --- Repair independently verified correctness defects

After recording Phase 0A, add a regression test before each fix and land each defect in a small isolated change. Start with owner-chat delivery/goal overwrite, schema drift, quantity handling, shelter false success, unsafe food selection, target re-selection, craft dependency arithmetic, reconnect retry behavior, and event-listener cleanup—but only where reproduced in the authoritative checkout. Restore old tests selectively if they actually match current source; do not overwrite newer source with HEAD-era assumptions.

**Exit criteria:** each fixed issue has a regression test and a clear source-of-truth commit. Retest baseline scenarios to separate bug-fix benefits from architecture changes.

### Phase 1 --- Cancellation, actuator ownership and continuous safety

1. Add epoch/generation guards and a single cancellation-aware actuator context.
2. Ensure pathfinder, digging, held-item use, movement controls, windows and timers stop on preemption; late promises must not issue side effects or clean up a newer action.
3. Instrument pathfinder status and progress. Distinguish `noPath`, search `timeout`, `path_stop`, no positional progress, goal invalidation, and disconnect; do not collapse all cases into “unreachable.”
4. Implement the lightweight asynchronous safety supervisor. Keep callbacks bounded and measure preemption latency; avoid CPU-heavy synchronous work on the event loop.
5. Fold the water/physics daemon into the same actuator ownership mechanism.
6. Fix reconnect/listener lifecycle problems if reproduced. Remove only listeners owned by this component rather than calling broad `removeAllListeners` on shared Mineflayer events.
7. Add fault-injection tests for late-settling actions and for normal versus emergency path cancellation. In the pinned `mineflayer-pathfinder` version, confirm when to use safe-at-next-node `stop()` versus immediate goal clearing with `setGoal(null)`.

**Exit criteria:** an unreachable-but-plausible navigation goal terminates within a measured watchdog window; an emergency preempts a long skill within the measured latency budget; aborted work leaves no stale controls/timers or arbiter mutation; reconnect succeeds after a test server restart.

### Phase 2 --- Event/world state and measurable task execution

1. Add an event bus/reducer with timestamps, confidence and provenance; coalesce noisy events and retain material deltas.
2. Add world-state freshness, targeted refresh and a bounded spatial cache.
3. Add typed `GoalSpec`, deterministic resolution for known goals, a bounded task graph for multi-step dependencies, delta-aware quantity semantics and postcondition verification.
4. Add failure taxonomy, temporary target blacklist and bounded recovery.
5. Add reservations and actuator/resource locks; keep task execution serial.
6. Add a single-flight asynchronous strategic-decision gate with event coalescing, goal/plan versioning and stale-response rejection.
7. Ensure authenticated owner chat reaches the intent resolver; preserve owner goals and explicit `stop/pause/replace` semantics without overriding emergency safety.

**Exit criteria:** a known `gather 8 logs` goal and a simple crafting goal execute through registered skills with bounded local actions; an already-satisfied prerequisite is marked `satisfied` rather than falsely reported as performed; an interrupted task resumes only after revalidation; repeated identical failures fall to zero in the fixed regression suite.

### Phase 3 --- High-value reusable skills

Implement in the following order:

1. `gather(resource, count)`: candidate ranking, tool-tier validation, natural-tree/ore-specific logic, drop collection, inventory-delta verification and blacklist recovery.
2. `navigate_to` and bounded query-directed frontier `explore`.
3. Recipe dependency resolver and `produce(item, count)`.
4. Closed-loop smelting with version-validated furnace API and owned-workstation lifecycle.
5. Inventory/tool policy, reservations and safe return/deposit.
6. Mining strategy selection, cave hazard checks and return-route tracking.

**Exit criteria:** on a fresh vanilla survival world, the bot gathers requested wood, crafts wooden/stone tools, gathers cobblestone and smelts iron with only goal-resolution/planning calls and justified escalations. Run each scenario on multiple seeds and report failures as well as successes.

### Phase 4 --- Survival, combat and world interaction

1.  Expand survival reflexes and safe food/tool selection.
2.  Add combat threat tracking, engage/avoid/retreat policy and arena
    validation.
3.  Add shelter/build blueprint verification and night policy.
4.  Run sound-evidence experiment; implement sound-driven policies only
    if they add measurable value.
5.  Add farming and routine storage after survival is reliable.

**Exit criteria:** survival and combat rates meet thresholds established
from baseline runs; no normal skill can override emergency safety;
shelter/build tasks verify their intended structure.

### Phase 5 --- Progression, logistics and learning

1.  Add a progression dependency graph and objective-selection policy
    that respects owner goals.
2.  Add named bases, containers, resource logistics and resumable
    travel.
3.  Add experience records and context-specific strategy ranking.
4.  Consider skill retrieval/code generation only after the verified
    skill registry is stable.
5.  Expand Nether/End, transportation and complex farming only after
    core regression suites pass.

**Exit criteria:** repeatable long-horizon scenarios with persisted task
state, measured improvements across repeated runs, and no regressions to
earlier survival/gathering/crafting benchmarks.

## 9. Metrics, tests and acceptance criteria

### Metrics for every run

-   Task success rate based on verified postconditions.
-   Time to complete each goal.
-   LLM calls and inference wall time per goal.
-   Prompt/completion tokens per goal.
-   Repeated identical target/path failure count.
-   Recovery attempts and recovery success rate by failure kind.
-   Deaths per in-game day and damage source.
-   Inventory-delta accuracy.
-   Reflex firing count and preemption latency.
-   Idle time waiting for LLM inference.
-   Number of stale observations rejected and stale plans discarded.

### Test ladder

1.  **Unit tests:** goal validation, delta semantics, recipe quantities,
    task graph dependencies, failure classification, freshness/TTL,
    epoch guard, arbiter priorities, event reducer, postcondition
    verification.
2.  **Simulation/fake-world tests:** shelter enclosure, mining hazard
    checks, resource blacklisting, stuck watchdog, window
    desynchronization and cancellation.
3.  **Local-server integration tests:** fixed-seed flat arena, forest,
    cave with lava, lake, village, hostile-mob arena; test gathering,
    crafting, smelting, drowning/lava escape, shelter, owner chat and
    reconnect.
4.  **Fault injection:** drop connection mid-skill, force pathfinder
    stop, return malformed/late LLM output, unload chunks, withhold item
    drops, fill inventory and preempt during a GUI operation.
5.  **Live repeated trials:** at least 10 runs per key scenario across
    seeds before declaring a capability stable. Publish results with
    commit hash, configuration and known limitations.

### Core acceptance scenarios

-   Gather 32 logs without LLM micromanagement; inventory count is
    correct.
-   Craft wooden and stone tools from stated initial resources with no
    unexplained retry.
-   Produce three iron ingots from raw iron and fuel.
-   A failed route is blacklisted and not retried identically.
-   Drowning/lava/critical health interrupts a long-running skill.
-   An aborted pathfinder operation cannot keep moving after preemption.
-   Shelter construction verifies all required blocks and enclosure.
-   Owner natural-language chat changes the active goal and is not
    overwritten by the next model response.
-   A restart resumes a checkpoint without trusting stale world facts.
-   No skill under test uses operator commands or hidden game-state
    manipulation.

A phase ships only if it passes its new tests and does not materially
regress earlier scenarios. Set quantitative success/death thresholds
after collecting a fresh baseline rather than inventing them in advance.

## 10. Major uncertainties to test rather than assume

1.  **Why exploration fails:** log path updates, goal resets, position
    deltas and stop reasons; distinguish timeout from truly unreachable
    terrain.
2.  **Does sound add useful information?** Compare sound events with
    entity tracking in 1.21.6; measure lead time and false positives.
3.  **Are craft pipeline and shelter defects reproducible?** Write
    fake-world tests, then verify in a local server.
4.  **Does reconnect stall?** Stop the server during a retry and observe
    the retry lifecycle.
5.  **Does listener cleanup remove third-party handlers?** Inspect
    listener ownership and inject post-stop errors.
6.  **What drives local-model latency?** Measure prompt-size and
    output-size changes separately from call frequency.
7.  **Can the chosen model reliably emit typed goals?** Run an offline
    evaluation set with and without constrained JSON output.
8.  **Which exploration strategy generalizes?** A/B frontier and
    directional strategies on multiple seeds/biomes.
9.  **Does `canDig` damage player structures?** Test in a fixture with
    chests, beds, doors, furnaces and bot-placed blocks.
10. **Which combat thresholds work?** Tune through repeatable arena
    trials, not copied constants.
11. **Are resource sightings complete on this server?** Validate loaded
    chunks, sampling and anti-xray behavior.
12. **Which source snapshot is authoritative?** Reconcile conflicting
    test/build claims from the supplied plans before relying on them.

## 11. Research transfer decisions

-   **Voyager:** retain verified skill libraries, critique/verification
    and curriculum ideas. Do not adopt privileged resets, operator
    commands or unrestricted runtime code generation as the default.
-   **Mindcraft/Mindcraft-CE:** retain the concept of reactive modes and
    curated skills. Avoid process-kill recovery, a single mutable
    interrupt boolean and unbounded repeated subgoals.
-   **Baritone:** adapt world/chunk cache, candidate plausibility
    filters, blacklisting, closest-uncached-frontier exploration and
    segmented travel. Revalidate because Mineflayer has different
    pathing APIs and physics.
-   **MC-Planner/DEPS:** use structured failure description, causal
    explanation, prerequisite insertion and proximity-aware subgoal
    selection. Do not copy ungrounded open-loop action sequences.
-   **GITM:** use hierarchical decomposition and memory of successful
    plans, while verifying every outcome in the real environment.
-   **Behavior trees / HTN:** use composable sequence/fallback/retry
    patterns where they simplify real recovery logic. Begin with a small
    task graph rather than implementing a heavyweight planner
    prematurely.
-   **Learned policies/RL:** defer; training cost and environment
    mismatch make them a poor early investment for this
    TypeScript/local-LLM setup.

## 12. Non-negotiable engineering rules

-   Never claim a capability is implemented because it appears in a
    plan.
-   Never claim a capability works live because a mocked test passes.
-   Never retry an identical failure without a new observation or
    changed strategy.
-   Never allow an aborted skill to keep issuing world-changing actions.
-   Never let a normal goal outrank an emergency response.
-   Never treat old coordinates or inferred sounds as confirmed current
    world state.
-   Never mark a task complete without a measured postcondition.
-   Never silently overwrite owner goals with a strategic model
    suggestion.
-   Never add concurrency before ownership and cancellation are safe.
-   Never report a target percentage reduction in LLM calls as fact
    before measurement.
-   Every phase must preserve a known-good checkpoint and include
    rollback instructions.

## 13. API/version reference checks required before implementation

The source plans contain code-like examples that must not be assumed to match every installed package version. The project targets Mineflayer 4.39 / Minecraft Java 1.21.6; verify the local lockfile and type declarations before implementing an API.

- **Mineflayer public events/API:** [official upstream API reference](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md). Current upstream documentation describes `bot.world` block updates, chunk load/unload, `soundEffectHeard`, `hardcodedSoundEffectHeard`, `playerCollect`, and the furnace interface. It is a moving `master` page, not proof that the exact installed 4.39 version exposes identical behavior.
- **Mineflayer pathfinder:** [official upstream README](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/readme.md) and [TypeScript declarations](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/index.d.ts). Current docs describe `getPathTo`, path status events, `path_stop`, and the distinction between `stop()` and `setGoal(null)`. Confirm locally before writing wrappers.
- **Node.js event loop:** [official Node.js guide](https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick). Node.js runs JavaScript callbacks on a single event-loop thread by default; asynchronous I/O does not make CPU-heavy synchronous code non-blocking.
- **Minecraft protocol sound packets:** [Minecraft Wiki protocol reference](https://minecraft.wiki/w/Minecraft_Wiki%3AProjects/wiki.vg_merge/Protocol). Packet schemas and IDs are versioned; prefer Mineflayer's public sound events and pinned-version type declarations when available.

Implementation rule: if this documentation conflicts with the pinned package's type/source declarations, the pinned dependency plus a minimal test is authoritative for the project. Record package versions and source links in the change report.

## 14. Required coding-agent reporting format

For each phase, the coding agent must return a concise implementation report with:

1. **Snapshot:** Git commit/branch, dirty files before/after, package versions.
2. **Scope:** exact features changed and what was deliberately not changed.
3. **Evidence:** file/function references and why the defect/capability warranted modification.
4. **Tests:** exact commands, pass/fail counts, and known mock-only limitations.
5. **Live result:** scenario/world/version/seed/configuration, completed goal and actual postcondition evidence; state “not run” if not run.
6. **Metrics:** before/after task duration, LLM calls/wait time, retries, failed targets, deaths and inventory/world deltas as applicable.
7. **Regressions/risks:** failed tests, unverified behavior and unresolved questions.
8. **Rollback:** commit or patch to revert the phase without losing unrelated user changes.
9. **Next phase gate:** one recommendation based on evidence, not a claim that the entire roadmap is finished.

Do not allow the coding agent to silently proceed from a failed phase gate. It should stop after the authorized phase, summarize evidence, and wait for the next instruction unless the user explicitly authorized the entire staged roadmap.

## 15. Revised source-plan synthesis and final decision

The revised master now preserves Claude's detailed defect audit and defect-to-test mapping; Terra's strict state freshness, serial executor, reservations and honest metrics; Gemini's broad skill discovery; and Nemotron's task verification, local recovery and integration test emphasis. It also defines a recurring capability-discovery loop so future coding agents keep finding, evaluating and adding useful techniques beyond this initial list. It deliberately revises Gemini's unverified acoustic claims, diagonal vein flood-fill, hard-coded combat/fall thresholds and performance promises; Nemotron's call-rate assumptions and priority ambiguity; and any interpretation of Terra/Claude test claims as applying to a single shared snapshot.

Use this v2 document as the planning authority. Phase 0A comes first, without behavioral fixes mixed into the baseline. Phase 0B then fixes reproduced defects; Phase 1 secures cancellation and safety; Phase 2 establishes events, typed goals and task execution; Phase 3 builds gathering, exploration, crafting and smelting; the later phases expand survival, combat, building, logistics and learning.

The master plan is not successful because it is comprehensive. It is successful only when each claimed capability is implemented against the authoritative repository, verified by appropriate tests, and demonstrated in a real Minecraft world without privileged shortcuts.
