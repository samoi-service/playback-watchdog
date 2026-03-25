import { execSync } from 'child_process';
import { loadPid } from './pidStore';
import { logger } from '../logger';

export function isProcessAlive(pid: number): boolean {
  try {
    // On Windows, tasklist is more reliable than process.kill(pid, 0)
    const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8', timeout: 5000 });
    return output.includes(String(pid));
  } catch {
    return false;
  }
}

export function isOpenClawRunning(): { alive: boolean; pid: number | null } {
  const pid = loadPid('openclaw');
  if (pid === null) return { alive: false, pid: null };
  return { alive: isProcessAlive(pid), pid };
}

export function killProcess(pid: number): boolean {
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { timeout: 10000 });
    logger.info('processWatcher', `Killed process ${pid}`);
    return true;
  } catch (e) {
    logger.warn('processWatcher', `Failed to kill ${pid}: ${e}`);
    return false;
  }
}
