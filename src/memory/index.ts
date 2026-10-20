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
    const tempPath = `${this.filePath}.tmp`;
    try {
      const dataToSave = {
        schemaVersion: 1,
        worldId: this.worldId,
        updatedAt: new Date().toISOString(),
        memory: this.memoryNotes,
        agentState: this.agentState,
      };
      fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err: any) {
      console.error('Failed to save memory to disk atomically:', err.message);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
    }
  }

  private loadFromDisk(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.memory && typeof parsed.memory === 'object') {
          this.memoryNotes = {
            namedLocations: parsed.memory.namedLocations || {},
            facts: Array.isArray(parsed.memory.facts) ? parsed.memory.facts : [],
            dangerZones: Array.isArray(parsed.memory.dangerZones) ? parsed.memory.dangerZones : [],
            completedGoals: Array.isArray(parsed.memory.completedGoals) ? parsed.memory.completedGoals : [],
          };
        }
        if (parsed.agentState && typeof parsed.agentState === 'object') {
          this.agentState = {
            currentGoal: parsed.agentState.currentGoal || this.agentState.currentGoal,
            planSteps: Array.isArray(parsed.agentState.planSteps) ? parsed.agentState.planSteps : this.agentState.planSteps,
            stepNumber: typeof parsed.agentState.stepNumber === 'number' ? parsed.agentState.stepNumber : 0,
            stuckCounter: 0,
            timeSinceLastProgressSeconds: 0,
          };
        }
      } catch (err: any) {
        console.error('Corrupted memory file detected. Quarantining:', err.message);
        try {
          const quarantinePath = `${this.filePath}.corrupted-${Date.now()}`;
          fs.renameSync(this.filePath, quarantinePath);
        } catch {}
      }
    }
  }
}
