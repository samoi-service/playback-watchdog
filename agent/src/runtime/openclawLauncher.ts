import { spawn, ChildProcess } from 'child_process';
import { AgentConfig } from '../types';
import { logger } from '../logger';
import { savePid, clearPid } from './pidStore';
import { killProcess, isOpenClawRunning } from './processWatcher';

let openclawProcess: ChildProcess | null = null;
let launchTime: Date | null = null;
let consecutiveFailures = 0;
const BASE_BACKOFF_SEC = 10;
const MAX_BACKOFF_SEC = 300;

export function getOpenClawStatus(): { pid: number | null; uptimeSec: number | null; running: boolean } {
  const { alive, pid } = isOpenClawRunning();
  const uptimeSec = alive && launchTime ? Math.floor((Date.now() - launchTime.getTime()) / 1000) : null;
  return { pid, uptimeSec, running: alive };
}

export function getBackoffMs(): number {
  const sec = Math.min(BASE_BACKOFF_SEC * Math.pow(2, consecutiveFailures), MAX_BACKOFF_SEC);
  return sec * 1000;
}

export async function launchOpenClaw(config: AgentConfig): Promise<boolean> {
  // Kill any existing process first
  const current = isOpenClawRunning();
  if (current.alive && current.pid) {
    logger.info('launcher', `Killing existing OpenClaw pid=${current.pid}`);
    killProcess(current.pid);
    clearPid('openclaw');
    await sleep(2000);
  }

  const args = [
    config.openclaw.scriptPath,
    ...config.openclaw.args,
  ];

  logger.info('launcher', `Starting OpenClaw: ${config.openclaw.nodePath} ${args.join(' ')}`);

  try {
    const child = spawn(config.openclaw.nodePath, args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_TOKEN: config.openclaw.gatewayToken,
      },
    });

    if (!child.pid) {
      logger.error('launcher', 'Failed to start OpenClaw: no PID');
      consecutiveFailures++;
      return false;
    }

    child.unref();
    openclawProcess = child;
    launchTime = new Date();
    savePid('openclaw', child.pid);
    logger.info('launcher', `OpenClaw started pid=${child.pid}`);

    child.on('exit', (code) => {
      logger.warn('launcher', `OpenClaw exited code=${code}`);
      clearPid('openclaw');
      openclawProcess = null;
    });

    // Wait a bit to see if it stays alive
    await sleep(3000);
    const check = isOpenClawRunning();
    if (check.alive) {
      consecutiveFailures = 0; // Reset on success
      return true;
    } else {
      consecutiveFailures++;
      logger.error('launcher', `OpenClaw died immediately after launch (failure #${consecutiveFailures})`);
      return false;
    }
  } catch (e) {
    logger.error('launcher', `Failed to spawn OpenClaw: ${e}`);
    consecutiveFailures++;
    return false;
  }
}

export function resetFailureCount(): void {
  consecutiveFailures = 0;
}

export function getFailureCount(): number {
  return consecutiveFailures;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
