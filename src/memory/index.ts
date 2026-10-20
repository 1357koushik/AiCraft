import fs from 'fs';
import path from 'path';
import { MemoryNotes, AgentInternalState } from '../types/index.js';

export interface HistoryStepRecord {
  step: number;
  summary: string;
  action: string;
  result: string;
  timestamp: number;
}

export class MemoryManager {
  private dataDir: string;
  private worldId: string;
  private filePath: string;
  private memoryNotes: MemoryNotes;
  private history: HistoryStepRecord[] = [];
  private agentState: AgentInternalState;

  constructor(worldId: string = 'local_world', dataDir: string = './data') {
    this.worldId = worldId;
    this.dataDir = path.resolve(process.cwd(), dataDir);
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.filePath = path.join(this.dataDir, `memory-${worldId}.json`);

    this.memoryNotes = {
      namedLocations: {},
      facts: [],
      dangerZones: [],
      completedGoals: [],
    };

    this.agentState = {
      currentGoal: 'Survive the first day and gather resources',
      planSteps: [
        { step: 'Collect wood logs', completed: false },
        { step: 'Craft crafting table and wooden pickaxe', completed: false },
        { step: 'Gather cobblestone', completed: false },
        { step: 'Craft stone tools and find food', completed: false },
      ],
      stepNumber: 0,
      stuckCounter: 0,
      timeSinceLastProgressSeconds: 0,
    };

    this.loadFromDisk();
  }

  public get notes(): MemoryNotes {
    return this.memoryNotes;
  }

  public get state(): AgentInternalState {
    return this.agentState;
  }

  public get rollingHistory(): HistoryStepRecord[] {
    return this.history;
  }

  public setGoal(goal: string, steps?: string[]): void {
    this.agentState.currentGoal = goal;
    if (steps && steps.length > 0) {
      this.agentState.planSteps = steps.map((s) => ({ step: s, completed: false }));
    }
    this.saveToDisk();
  }

  public addHistoryRecord(record: HistoryStepRecord, maxHistory: number = 10): void {
    this.history.push(record);
    if (this.history.length > maxHistory) {
      this.history.shift();
    }
  }

  public rememberLocation(name: string, pos: { x: number; y: number; z: number }): void {
    this.memoryNotes.namedLocations[name] = pos;
    this.saveToDisk();
  }

  public rememberFact(fact: string): void {
    if (!this.memoryNotes.facts.includes(fact)) {
      this.memoryNotes.facts.push(fact);
      this.saveToDisk();
    }
  }

  public addDangerZone(name: string, pos: { x: number; y: number; z: number }, radius: number = 10): void {
    this.memoryNotes.dangerZones.push({ name, x: pos.x, y: pos.y, z: pos.z, radius });
    this.saveToDisk();
  }

  public markGoalComplete(goal: string): void {
    if (!this.memoryNotes.completedGoals.includes(goal)) {
      this.memoryNotes.completedGoals.push(goal);
      this.saveToDisk();
    }
  }

  public saveToDisk(): void {
    try {
      const dataToSave = {
        worldId: this.worldId,
        updatedAt: new Date().toISOString(),
        memory: this.memoryNotes,
        agentState: this.agentState,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('Failed to save memory to disk:', err.message);
    }
  }

  private loadFromDisk(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.memory) {
          this.memoryNotes = { ...this.memoryNotes, ...parsed.memory };
        }
        if (parsed.agentState) {
          this.agentState = { ...this.agentState, ...parsed.agentState };
        }
      } catch (err: any) {
        console.error('Failed to read memory file, initializing default:', err.message);
      }
    }
  }
}
