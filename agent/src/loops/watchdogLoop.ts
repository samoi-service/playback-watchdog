import { AgentConfig } from '../types';
import { AgentState } from '../state';
import { logger } from '../logger';
import { isOpenClawRunning } from '../runtime/processWatcher';
import { launchOpenClaw, getBackoffMs, getFailureCount } from '../runtime/openclawLauncher';

let watchdogTimer: NodeJS.Timeout | null = null;
let lastStableTime: number = Date.now();
const STABLE_THRESHOLD_MS = 60000; // 60s running = considered stable

export function startWatchdogLoop(config: AgentConfig, state: AgentState): void {
  const intervalMs = config.watchdogIntervalSec * 1000;

  async function tick() {
    try {
      const { alive, pid } = isOpenClawRunning();

      if (alive) {
        // Check if stable long enough to reset backoff
        const uptime = Date.now() - lastStableTime;
        if (uptime > STABLE_THRESHOLD_MS && getFailureCount() > 0) {
          logger.info('watchdog', 'OpenClaw stable for 60s, resetting failure count');
          // resetFailureCount imported from launcher
          const { resetFailureCount } = require('../runtime/openclawLauncher');
          resetFailureCount();
        }
        if (state.status === 'degraded' || state.status === 'repairing') {
          state.transition('healthy', 'openclaw recovered');
        }
        return;
      }

      // OpenClaw is dead
      logger.warn('watchdog', `OpenClaw not running (pid=${pid}), attempting restart`);
      state.transition('repairing', 'openclaw not running');

      const backoffMs = getBackoffMs();
      logger.info('watchdog', `Backoff: ${backoffMs}ms (failures: ${getFailureCount()})`);
      await sleep(backoffMs);

      const ok = await launchOpenClaw(config);
      lastStableTime = Date.now();
      if (ok) {
        state.transition('healthy', 'openclaw restarted');
      } else {
        state.transition('degraded', 'openclaw restart failed');
      }
    } catch (e) {
      logger.error('watchdog', `Error: ${e}`);
    }
  }

  // Initial launch
  tick();
  watchdogTimer = setInterval(tick, intervalMs);
  logger.info('watchdog', `Started (every ${config.watchdogIntervalSec}s)`);
}

export function stopWatchdogLoop(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
