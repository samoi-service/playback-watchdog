import { AxiosInstance } from 'axios';
import { AgentConfig, ALLOWED_COMMANDS, AllowedCommand } from '../types';
import { AgentState } from '../state';
import { logger } from '../logger';
import { fetchPendingCommands } from '../transport/commandApi';
import { reportCommandResult } from '../transport/resultApi';
import { runCommand } from '../commands/commandRunner';
import { wasAlreadyExecuted, markExecuted } from '../commands/commandHistory';

let commandTimer: NodeJS.Timeout | null = null;

export function startCommandPollLoop(config: AgentConfig, state: AgentState, client: AxiosInstance): void {
  const intervalMs = config.commandPollIntervalSec * 1000;

  async function tick() {
    if (!state.isServerReachable) return;

    try {
      const commands = await fetchPendingCommands(client, config.deviceId);

      for (const cmd of commands) {
        // Deduplication check
        if (wasAlreadyExecuted(cmd.commandId)) {
          logger.info('command', `Skipping duplicate command: ${cmd.commandId}`);
          continue;
        }

        // Whitelist check
        if (!ALLOWED_COMMANDS.includes(cmd.action as AllowedCommand)) {
          logger.warn('command', `Rejected non-whitelisted command: ${cmd.action}`, { commandId: cmd.commandId });
          await reportCommandResult(client, config.deviceId, {
            commandId: cmd.commandId,
            action: cmd.action,
            status: 'rejected',
            message: `Command "${cmd.action}" is not in the whitelist`,
          });
          continue;
        }

        // Expiry check
        if (new Date(cmd.expiresAt) < new Date()) {
          logger.warn('command', `Skipping expired command: ${cmd.commandId}`);
          continue;
        }

        logger.info('command', `Executing: ${cmd.action}`, { commandId: cmd.commandId });

        try {
          const result = await runCommand(cmd.action as AllowedCommand, cmd.payload, config);
          markExecuted(cmd.commandId);
          await reportCommandResult(client, config.deviceId, {
            commandId: cmd.commandId,
            action: cmd.action,
            status: result.success ? 'succeeded' : 'failed',
            exitCode: result.exitCode,
            message: result.message,
          });
        } catch (e) {
          markExecuted(cmd.commandId);
          await reportCommandResult(client, config.deviceId, {
            commandId: cmd.commandId,
            action: cmd.action,
            status: 'failed',
            message: `${e}`,
          });
        }
      }
    } catch (e) {
      // Don't mark server unreachable for poll failures (heartbeat handles that)
      logger.debug('command', `Poll failed: ${e}`);
    }
  }

  commandTimer = setInterval(tick, intervalMs);
  logger.info('command', `Started (every ${config.commandPollIntervalSec}s)`);
}

export function stopCommandPollLoop(): void {
  if (commandTimer) {
    clearInterval(commandTimer);
    commandTimer = null;
  }
}
