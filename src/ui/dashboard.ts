import readline from 'readline';
import { AgentController } from '../agent/loop.js';
import { MemoryManager } from '../memory/index.js';
import { AgentLogger } from '../utils/logger.js';
import { ConnectionManager } from '../connection/index.js';

export class ConsoleDashboard {
  private rl: readline.Interface | null = null;
  private agentController: AgentController;
  private memory: MemoryManager;
  private connection: ConnectionManager;
  private logger: AgentLogger;

  constructor(
    agentController: AgentController,
    memory: MemoryManager,
    connection: ConnectionManager,
    logger: AgentLogger
  ) {
    this.agentController = agentController;
    this.memory = memory;
    this.connection = connection;
    this.logger = logger;
  }

  public startCLI(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.printHelp();

    this.rl.on('line', (line) => {
      const input = line.trim();
      if (!input) return;

      const [cmd, ...args] = input.split(' ');
      const argStr = args.join(' ');

      switch (cmd.toLowerCase()) {
        case 'pause':
          this.agentController.pause();
          console.log('[CLI] Paused AI decision loop.');
          break;

        case 'resume':
          this.agentController.resume();
          console.log('[CLI] Resumed AI decision loop.');
          break;

        case 'step':
          this.agentController.approveStep();
          console.log('[CLI] Approved single step.');
          break;

        case 'goal':
          if (argStr) {
            this.memory.setGoal(argStr);
            console.log(`[CLI] Updated goal to: "${argStr}"`);
          } else {
            console.log(`[CLI] Current goal: "${this.memory.state.currentGoal}"`);
          }
          break;

        case 'status':
          this.printStatus();
          break;

        case 'help':
          this.printHelp();
          break;

        case 'quit':
        case 'exit':
          console.log('[CLI] Gracefully quitting agent...');
          this.agentController.stop();
          this.connection.disconnect();
          this.rl?.close();
          process.exit(0);
          break;

        default:
          console.log(`[CLI] Unknown command '${cmd}'. Type 'help' for available commands.`);
      }
    });
  }

  public printStatus(): void {
    const bot = this.connection.currentBot;
    const pos = bot?.entity?.position;
    const health = bot?.health ?? 'unknown';
    const food = bot?.food ?? 'unknown';

    console.log('\n=================== AGENT STATUS ===================');
    console.log(`Goal:        ${this.memory.state.currentGoal}`);
    console.log(`Step:        ${this.memory.state.stepNumber}`);
    console.log(`Health:      ${health}/20 | Food: ${food}/20`);
    if (pos) {
      console.log(`Position:    X: ${pos.x.toFixed(1)} Y: ${pos.y.toFixed(1)} Z: ${pos.z.toFixed(1)}`);
    }
    const recent = this.memory.rollingHistory.slice(-1)[0];
    if (recent) {
      console.log(`Last Action: ${recent.action} (${recent.result})`);
      console.log(`Last Decision: "${recent.summary}"`);
    }
    console.log('====================================================\n');
  }

  public printHelp(): void {
    console.log('\n================ COMMANDS ================');
    console.log('pause         - Pause the AI decision loop');
    console.log('resume        - Resume the AI decision loop');
    console.log('step          - Approve next step (in step mode)');
    console.log('goal <text>   - Set a new high-level goal');
    console.log('status        - Print current status summary');
    console.log('help          - Show this command reference');
    console.log('quit / exit   - Gracefully disconnect and exit');
    console.log('==========================================\n');
  }

  public close(): void {
    this.rl?.close();
  }
}
