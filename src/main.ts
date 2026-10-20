import { loadConfig } from './config/index.js';
import { AgentLogger } from './utils/logger.js';
import { MemoryManager } from './memory/index.js';
import { SafetyManager } from './safety/index.js';
import { createLLMProvider } from './llm/index.js';
import { ConnectionManager } from './connection/index.js';
import { AgentController } from './agent/loop.js';
import { ConsoleDashboard } from './ui/dashboard.js';

async function main() {
  console.log('===========================================================');
  console.log('     Minecraft Java 1.21.6 LLM Agent Starting Up           ');
  console.log('===========================================================');

  // 1. Load config
  const config = loadConfig();

  // 2. Setup logger
  const logger = new AgentLogger(config);
  logger.info(`Starting agent with log level: ${config.logging.level}`);

  // 3. Setup persistent memory and safety
  const memory = new MemoryManager(`world_${config.server.host}_${config.server.port}`);
  const safety = new SafetyManager(config);

  // 4. Setup LLM provider
  const llmProvider = createLLMProvider(config, logger);

  // 5. Setup connection manager
  const connection = new ConnectionManager(config, logger);

  // Graceful shutdown handling
  let isShuttingDown = false;
  const handleShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Received shutdown signal. Disconnecting bot and saving state...');
    memory.saveToDisk();
    connection.disconnect();
    setTimeout(() => {
      logger.info('Clean shutdown complete.');
      process.exit(0);
    }, 1000);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  // 6. Connect to Minecraft server
  let agentController: AgentController | null = null;
  let dashboard: ConsoleDashboard | null = null;

  try {
    await connection.connect({
      onSpawn: (connectedBot) => {
        logger.info(
          `Bot spawned at X: ${connectedBot.entity.position.x.toFixed(1)} Y: ${connectedBot.entity.position.y.toFixed(1)} Z: ${connectedBot.entity.position.z.toFixed(1)}`
        );

        if (!agentController) {
          // Initialize agent loop on first connection
          agentController = new AgentController(
            connectedBot,
            config,
            logger,
            memory,
            safety,
            llmProvider
          );

          // Initialize console dashboard
          dashboard = new ConsoleDashboard(agentController, memory, connection, logger);
          dashboard.startCLI();

          // Start agent loop
          agentController.start().catch((err) => {
            logger.error({ err }, `Agent loop terminated with error: ${err.message}`);
          });
        } else {
          // Subsequent connection (reconnect): rebind existing controller cleanly
          agentController.updateBotInstance(connectedBot);
        }
      },
    });
  } catch (err: any) {
    logger.error({ err }, `Fatal connection error: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Unhandled fatal error during startup:', err);
  process.exit(1);
});
