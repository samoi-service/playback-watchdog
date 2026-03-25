import { loadConfig } from './config';
import { AgentState } from './state';
import { logger } from './logger';
import { createApiClient } from './transport/apiClient';
import { startWatchdogLoop, stopWatchdogLoop } from './loops/watchdogLoop';
import { startHeartbeatLoop, stopHeartbeatLoop } from './loops/heartbeatLoop';
import { startCommandPollLoop, stopCommandPollLoop } from './loops/commandPollLoop';
import { loadCommandHistory } from './commands/commandHistory';
import { loadOfflineQueue } from './transport/offlineQueue';

const AGENT_VERSION = '0.1.0';

async function main() {
  logger.info('main', `OpenClaw Player Agent v${AGENT_VERSION} starting...`);

  // Load config
  const configPath = process.argv[2]; // Optional: path to config file
  let config;
  try {
    config = loadConfig(configPath);
    logger.info('main', `Config loaded: deviceId=${config.deviceId}`);
  } catch (e) {
    logger.error('main', `Failed to load config: ${e}`);
    process.exit(1);
  }

  // Load persistent state
  loadCommandHistory();
  loadOfflineQueue();

  // Initialize state
  const state = new AgentState();
  state.transition('idle', 'agent started');

  // Create API client
  const client = createApiClient(config);

  // Start loops
  startWatchdogLoop(config, state);
  startHeartbeatLoop(config, state, client);
  startCommandPollLoop(config, state, client);

  logger.info('main', 'All loops started. Agent is running.');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('main', 'Shutting down...');
    stopWatchdogLoop();
    stopHeartbeatLoop();
    stopCommandPollLoop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  setInterval(() => {}, 60000);
}

main().catch((e) => {
  logger.error('main', `Fatal error: ${e}`);
  process.exit(1);
});
