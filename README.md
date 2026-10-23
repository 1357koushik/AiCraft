# Autonomous Minecraft AI Agent

## Project mission

Build a genuinely autonomous Minecraft agent that can operate in a real Minecraft Java survival world, understand a goal, make a sensible plan, carry it out over many actions, verify what actually happened, recover from failures, and continue without needing an LLM decision for every small step.

The aim is **reliable in-world autonomy**, not merely a bot that connects to a server, emits plausible plans, or passes mocked unit tests. The agent should behave like a capable player: observe the world, understand its current state, choose useful objectives, gather and manage resources, craft and smelt items, navigate terrain, build, explore, respond to threats, survive, and complete instructions given by the owner.

A task should form a closed loop:

**Observe → understand state → plan → execute → verify the result → recover or continue.**

The system must ground its decisions in the actual Minecraft world and inventory. It must not report success because an action returned without throwing an error; it should verify the intended postcondition wherever practical.

## What this project is

This is an autonomous Minecraft Java Edition AI agent, currently targeting **Minecraft Java 1.21.6**, built with TypeScript/Node.js and Mineflayer. It uses an LLM—currently including local models served through LM Studio—for strategic reasoning, while ordinary game mechanics and repeatable procedures should be handled by reliable program logic.

The project is intended to combine:

- **Strategic reasoning:** Understand the user's goal, choose priorities, decompose goals into prerequisites, and re-plan when circumstances materially change.
- **Deterministic execution:** Carry out known procedures such as gathering resources, crafting, smelting, building, and navigation through tested TypeScript actions and macros.
- **Grounded perception and state:** Use current observations, inventory, nearby blocks/entities, recent events, and persistent task state rather than relying on the model's assumptions.
- **Survival reflexes:** React promptly to immediate hazards and threats without waiting for a slow LLM response.
- **Closed-loop verification:** Check whether actions achieved their intended outcomes and diagnose specific reasons for failure.
- **Learning through engineering:** Analyze relevant external repositories and research, extract useful ideas, adapt them to this codebase, and prove their value through tests and experiments.

The exact implementation will evolve. The mission above should remain stable even as modules, models, and architecture change.

## Core design philosophy

### 1. Use the LLM for decisions that benefit from reasoning

Do not call the model for every primitive movement, block break, inventory operation, or step inside a known workflow. LLM inference can be slow, particularly on small local models. A model call should have a clear purpose, such as selecting an objective, creating or revising a plan, interpreting an unfamiliar situation, or resolving a failure that deterministic recovery cannot handle.

Once a valid plan is underway, deterministic execution should continue without unnecessary repeated planning calls. Invoke the LLM again when a meaningful event warrants it: the goal is complete, the queue is exhausted, a user gives a new instruction, the world changes materially, or local recovery has failed.

Do not suppress the LLM so aggressively that the system becomes a brittle hardcoded script. Keep high-level behavior flexible; make well-understood mechanics deterministic.

### 2. Build a hierarchical, closed-loop controller

The intended direction is a hybrid architecture with clear responsibilities:

- **Safety and reflex layer:** Responds quickly to drowning, lava, hostile attacks, critical hunger, disconnection, and other urgent conditions. It can preempt lower-priority work.
- **Task and macro layer:** Executes explicit subgoals and reusable multi-step skills. It verifies prerequisites and postconditions, tracks progress, handles retries, and returns structured failures.
- **Strategic planning layer:** Uses the LLM to choose objectives, decompose unfamiliar goals, choose alternatives, and re-plan when needed.

This is an architectural direction, not a mandate to build unnecessary abstractions. Inspect the existing implementation before adding new layers, queues, managers, or frameworks. Prefer extending a working component over duplicating it.

### 3. Track goals as data, not vague prose

A multi-step goal should have explicit meaning: task type, target, required quantity or condition, prerequisites, status, retry policy, timeout, and verification criteria where relevant.

For example, “gather eight cobblestone” is not complete because the inventory contains one cobblestone. Completion must compare the observed count with the required count. If another action makes a prerequisite unnecessary, distinguish “prerequisite satisfied” from “the original task was completed.”

Maintain task progress across action boundaries and, where appropriate, across reconnects. Never rely on the LLM to remember a plan that the application itself can track deterministically.

### 4. Ground everything in the live game state

Actions and plans must be based on current observations. Revalidate targets, available resources, equipment, block states, distance, hazards, and relevant inventory conditions before consequential actions. Update state after execution.

Distinguish at least these outcomes:

- The action command was accepted.
- The physical action ran.
- The expected world or inventory change occurred.
- The overall subgoal was satisfied.

They are not interchangeable. Report uncertainty or failure accurately.

### 5. Safety and cancellation are architectural requirements

Preserve and improve the existing action-priority, `AbortSignal`, and `ActionArbiter` mechanisms. A preempted action must not continue issuing world-changing side effects or run cleanup that interferes with a newer, higher-priority action.

Check cancellation at meaningful boundaries in long-running procedures. Ensure that movement, digging, placement, combat, eating, inventory operations, workstation cleanup, and drop collection do not blindly continue after preemption or disconnection.

Do not equate a `finally` block with safe cleanup. Cleanup also needs cancellation-aware ownership and safety rules. A life-saving reflex must not wait for ordinary strategic planning.

### 6. Use real Minecraft mechanics; no hidden cheating

The agent should work in ordinary survival conditions unless the owner explicitly configures a different test environment. Do not depend on operator commands, `/give`, `/tp`, `/setblock`, creative inventory, server-side shortcuts, or hidden server modifications to make a skill appear successful.

Reference implementations that use cheats may still provide useful algorithms, but separate those ideas from their privileged environment assumptions. Every adapted skill must respect available inventory, crafting recipes, tool tiers, block reach, pathfinding, and the actual server rules.

### 7. Optimize measured outcomes, not superficial metrics

Low token count, few model calls, many tests, or elegant architecture are means rather than the ultimate goal. Optimize for end-to-end task success, survival, appropriate recovery, low unnecessary inference latency, resource efficiency, and consistency.

Measure prompt size and model latency directly. Removing spatial information may shrink a prompt while making navigation worse. Reducing LLM calls may lower latency while leaving the bot stuck. Keep changes only when evidence shows that they improve the target behavior without unacceptable regressions.

## Goals and capabilities to pursue

The agent should progressively become capable of the following, subject to the supported Minecraft version and installed dependencies:

1. Connect, observe, and maintain a correct view of the world, inventory, vitals, nearby entities, resources, and immediate threats.
2. Follow owner instructions received through supported control channels, including in-game chat when configured and authorized.
3. Generate useful multi-step survival and task plans, including prerequisite gathering and crafting.
4. Gather resources, choose appropriate tools, collect drops, craft, smelt, manage workstations, and recover resources when appropriate.
5. Navigate uneven terrain, obstacles, caves, and relevant hazards without repeatedly issuing impossible goals.
6. Build structures and perform world interactions with placement, reach, collision, and material checks.
7. Fight or avoid threats using current health, equipment, and surrounding conditions.
8. Detect failure, explain it with actionable information, attempt bounded local recovery, and re-plan only when necessary.
9. Verify actual progress and avoid repeating already-completed or demonstrably unreachable tasks.
10. Resume sensibly after interruption, disconnection, or restart, without trusting stale world assumptions.

Do not claim a capability is complete just because a function or action name exists. Verify its implementation and behavior.

## How AI coding and research agents should work in this repository

This repository may be examined by different AI agents. Treat this README as the durable project charter and use the current codebase as the implementation to investigate—not as proof that the desired behavior already works.

### Step 1 — Establish the current truth

Before proposing changes:

- Inspect the current project structure, package scripts, dependency versions, relevant source modules, tests, configuration, and documentation.
- Check the working tree and preserve user changes.
- Run available baseline tests and build checks where possible.
- Inspect actual logs for the failures being investigated.
- Trace an observed failure through the real call chain from perception and planning to action dispatch and Mineflayer behavior.
- Distinguish implementation facts, test-backed claims, live observations, and hypotheses.

Past reports, plans, test counts, and architecture documents may be stale. Verify the present state before relying on them.

### Step 2 — Research relevant repositories selectively

Search other repositories, documentation, issues, or research when they may help solve a specific problem. Study the actual relevant implementation and its dependencies rather than relying solely on a README or an AI-generated summary.

For each useful finding, record the source and revision where available, relevant file/function, what the code actually does, why it is relevant, and what cannot be transferred directly. Consider the reference project's version, environment, permissions, assumptions, and trade-offs.

Do not copy a feature just because it exists elsewhere. Do not copy privileged server behavior into a survival agent. Do not assume a popular project is correct or compatible.

### Step 3 — Produce evidence-backed findings

For every significant finding, state:

- The concrete target-project problem.
- The evidence that the problem exists.
- Its cause, if established.
- The relevant external implementation or independent technical basis.
- The proposed change and why it fits this project.
- Compatibility, safety, complexity, and regression risks.
- A test or experiment that can falsify the hypothesis.
- The metric that would demonstrate improvement.

Label claims clearly as **verified**, **experimentally confirmed**, **inferred**, or **unverified**. Never invent source locations, APIs, test outcomes, logs, or benchmarks.

### Step 4 — Prioritize the highest-value improvement

Rank candidate changes by user impact, frequency and severity of the problem, confidence in the diagnosis, expected benefit, complexity, regression risk, and testability.

Prefer a small, evidence-backed fix over a large speculative refactor. Investigate the actual failure before adding abstractions. Avoid implementing multiple unrelated architectural changes in one batch.

### Step 5 — Implement incrementally when authorized

For each selected improvement:

1. Define the expected behavior and failure conditions.
2. Add or identify a regression test that reproduces the problem.
3. Make the smallest coherent source change.
4. Run the new test and relevant existing tests.
5. Run the full test suite and build when feasible.
6. Review the diff for unintended changes or weakened tests.
7. Validate integrations or live behavior when the change depends on real Minecraft mechanics.
8. Record the actual result, including failures and remaining limitations.

If implementation was not requested or authorized, provide the analysis and a concrete implementation plan instead. Never overwrite user work, reset the working tree, remove tests to obtain a green run, or claim validation that was not performed.

### Step 6 — Verify real outcomes

Unit tests are necessary but do not establish live-world reliability. Use integration or live tests for pathfinding, physics, event timing, server behavior, cancellation, crafting, and workstation lifecycle when possible.

For important changes, use before-and-after measurements under comparable conditions. Useful metrics include task completion rate, completion time, model requests per task, model inference latency, repeated actions, path failures, recovery success, inventory deltas, and survival outcomes.

Explicitly state when a Minecraft server or other required environment was unavailable. Separate automated test results from live verification.

### Step 7 — Update the project knowledge

Update documentation only to reflect behavior actually implemented and verified. Mark proposed work separately from completed work. Preserve reusable research findings, rejected approaches, test scenarios, and measured outcomes so future agents do not repeat the same investigation.

A useful result is not just a report. When implementation is authorized and the environment allows it, deliver a tested improvement. When a proposed change cannot be validated, explain precisely what remains uncertain.

## Engineering constraints and anti-patterns

Avoid these failure patterns:

- Asking the LLM to re-plan every few hundred milliseconds while deterministic work is in progress.
- Repeating the same failed action without new evidence or a changed strategy.
- Treating a generic “action failed” message as sufficient diagnosis.
- Reporting task success without checking world state or inventory postconditions.
- Marking quantity-based tasks complete based on mere item presence.
- Assuming a nearby entity death proves the bot killed it.
- Using a fixed 3D destination for a task that only requires horizontal travel over uneven terrain—or using horizontal-only goals where an exact elevation is necessary.
- Blindly mining, placing blocks, bridging, pillaring, or collecting drops without terrain and hazard checks.
- Letting stale actions or cleanup run after higher-priority preemption.
- Hardcoding a survival curriculum that hijacks custom owner objectives or fails in different biomes and starting conditions.
- Removing useful spatial or action information solely to reduce prompt tokens.
- Adopting another project's APIs or behavior without checking dependency versions and environment assumptions.
- Treating passing mocked tests as proof of survival-mode success.
- Making sweeping changes before establishing a baseline or isolating the root cause.
- Producing repeated architectural reports without improving and validating actual behavior.

## Definition of success

The project is succeeding when the bot can accept a meaningful goal, develop a workable plan, execute long-running tasks without unnecessary LLM intervention, ground progress in the actual world, survive and handle emergencies, recover from failures, and correctly determine when the goal is complete.

Its performance must be demonstrated in realistic scenarios—not inferred from architecture diagrams, function names, passing unit tests alone, or confident AI-generated reports.

**Guiding principle: research broadly, verify locally, change incrementally, and judge every improvement by the agent's real behavior in Minecraft.**
