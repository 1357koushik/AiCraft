# Minecraft LLM Agent (Java 1.21.6)

Autonomous, provider-agnostic LLM agent playing Minecraft Java Edition 1.21.6 (Protocol 771, Data Version 4435) built with Mineflayer, TypeScript, and Node.js 24 LTS.

---

## Architecture Overview

```
Minecraft Java 1.21.6 Server <---> Bot Connection (Mineflayer + Pathfinder)
                                            |                  ^
                                            v                  |
           Perception Engine (Vitals, Inventory, Blocks, Map)  Action Executor (Revalidated)
                                            |                  ^
                                            v                  |
     Prompt Builder (Catalog + Observation) --> LLM Provider --+
                                           (LM Studio / OpenAI / Anthropic / Mock)
                                            |
                                            v
     Memory Store & History <--- Agent Controller (Loop, Reflexes, Stuck Detection, CLI)
```

### Core Components

1. **Connection Manager (`src/connection/`)**:
   - Manages connection to Minecraft Java 1.21.6 servers (offline or Microsoft auth).
   - Initializes `mineflayer-pathfinder` with Movements configured for 1.21.6.
   - Bounded exponential backoff reconnection.
   - Optional live 3D web viewer with `prismarine-viewer`.

2. **Perception Engine (`src/perception/`)**:
   - Vitals: health, food, oxygen, armor, potion effects, movement state, item use.
   - Position: exact and block coordinates, velocity, yaw/pitch, cardinal facing, biome, dimension, depth context.
   - Inventory: main/off hands, hotbar, 27 inventory slots, equipped armor, tool tier summary, food list, placeable blocks, live craftable recipes query.
   - Blocks & Local Map: 9x9 compact horizontal grid map (ASCII with legend), walkability in cardinal directions, hazard detection (lava, fire, deep drops >= 3, berry bushes, powder snow), notable block scanning (ores, logs, crafting tables, chests).
   - Entities: short IDs (`e1`, `e2`, ...) mapped to runtime entities, line-of-sight raycasts, distance, hostile/passive categorization, owner identification.

3. **Action Registry & Availability Engine (`src/actions/`)**:
   - **Movement**: `goto`, `follow`, `flee`, `move`, `jump`, `swim_up`, `sprint`, `sneak`, `look_at`, `explore`, `stop`.
   - **Mining & Building**: `dig_block`, `mine_resource`, `chop_tree`, `place_block`, `collect_items`, `use_bucket`, `till`, `plant`, `harvest`.
   - **Inventory & Crafting**: `equip`, `select_hotbar`, `swap_hands`, `drop`, `eat`, `craft`, `open_container`, `deposit`, `withdraw`, `close_container`.
   - **Combat**: `attack`, `attack_nearest`, `shoot`, `block_with_shield`.
   - **World Interaction**: `interact_block`, `interact_entity`, `sleep`, `wake`, `mount`, `dismount`.
   - **Meta**: `chat`, `wait`, `remember`, `set_goal`, `respawn`, `run_command` (strictly disabled by default).
   - **Availability Engine**: evaluates legality and parameter choices before sending to LLM, and **revalidates state immediately before execution**.

4. **LLM Provider Layer (`src/llm/`)**:
   - **LM Studio**: local HTTP API at `http://localhost:1234/v1` with JSON mode or structured schema.
   - **OpenAI-compatible**: standard OpenAI API, OpenRouter, Groq, Ollama.
   - **Anthropic**: Claude 3.5 Sonnet messages API.
   - **Mock Provider**: deterministic/scripted test provider for offline execution and CI.
   - Tolerant JSON parser with markdown fence removal, substring bracket extraction, and Zod validation.

5. **Agent Controller & Emergency Reflexes (`src/agent/`)**:
   - Single in-flight LLM call with bounded retries on malformed JSON.
   - Sub-second reflex layer (bypasses LLM latency): emergency flee at critical health, auto-eat when hungry, swim up when out of oxygen, jump/flee from lava.
   - Stuck detector: detects unchanged position or repeated failed actions.
   - Owner command listener: `!goal <goal>`, `!pause`, `!resume`, `!step`.

6. **Memory & Long-term Storage (`src/memory/`)**:
   - Rolling short-term history of decisions and outcomes.
   - Persistent per-world JSON file (`data/memory-<world>.json`) saving named locations (home, base, death point), facts learned, danger zones, and goal progress.

7. **Safety (`src/safety/`)**:
   - Owner and friend protection: strictly prevents attacking configured owner or friendly players.
   - Protected entities list (pets, horses, villagers, iron golems).
   - Bounded coordinate checking for pathfinding.
   - Command allowlist and rate limiting.

8. **Dashboard & Replay Tool (`src/ui/`, `src/tools/replay.ts`)**:
   - Interactive console CLI: `pause`, `resume`, `step`, `goal <text>`, `status`, `help`, `quit`.
   - Per-step JSONL logging in `logs/agent-steps-<timestamp>.jsonl`.
   - Replay tool to benchmark and compare models against recorded decision logs.

---

## Getting Started

### Prerequisites
- Node.js 24 LTS (or Node 20+)
- Java 21+ (for Minecraft 1.21.6 server)
- Minecraft Java Edition 1.21.6 client

### Installation

```bash
git clone <repo>
cd minecraft_ai_scratch
npm install
```

### Configuration

Copy `.env.example` to `.env` if using API keys:
```bash
cp .env.example .env
```

Edit `config/config.yaml` to configure your server address, LLM provider, and agent settings:
```yaml
server:
  host: "127.0.0.1"
  port: 25565
  version: "1.21.6"
  username: "AIAgentBot"
  auth: "offline"

llm:
  provider: "lmstudio" # "lmstudio" | "openai" | "anthropic" | "mock"
  baseUrl: "http://127.0.0.1:1234/v1"
  model: "default"
  temperature: 0.3
  jsonMode: true
```

---

## Running the Agent

### Start the Bot
```bash
npm start
```
Or for development with automatic reload on changes:
```bash
npm run dev
```

### Interactive Console CLI Commands
While running, type directly into the terminal:
- `status`: prints health, food, position, goal, auto-attack status, and last action.
- `attack-mode [on|off]`: toggles or sets real-time auto-attack defense mode.
- `pause`: pauses the AI decision loop.
- `resume`: resumes the decision loop.
- `step`: approves a single decision turn (when `stepMode: true`).
- `goal <text>`: updates the high-level goal (e.g. `goal Collect 10 iron ingots`).
- `quit`: cleanly saves state, disconnects the bot, and exits.

### In-Game Owner Commands
From Minecraft chat (must match a username listed in `agent.owners` in `config.yaml`):
- `!attack [on|off]`: toggles or sets auto-attack defense mode.
- `!goal <goal>`: changes agent goal.
- `!pause`: pauses bot.
- `!resume`: resumes bot.
- `!step`: approves next step.

---

## Running Tests

Run the full automated test suite (unit tests, perception, availability, safety, and end-to-end scenario loop):
```bash
npm test
```

Build TypeScript to `dist/`:
```bash
npm run build
```

---

## Model Replay and Comparison Tool

Replay recorded step observations from a JSONL log to evaluate alternative models:
```bash
npx tsx src/tools/replay.ts logs/agent-steps-<timestamp>.jsonl [provider]
```
This benchmarks valid-JSON rate, action selection quality, and response latency.
