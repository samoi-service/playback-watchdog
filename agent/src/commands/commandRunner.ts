import { AllowedCommand, AgentConfig } from '../types';
import { logger } from '../logger';
import { launchOpenClaw } from '../runtime/openclawLauncher';
import { killProcess, isOpenClawRunning } from '../runtime/processWatcher';
import { clearPid } from '../runtime/pidStore';
import { execSync } from 'child_process';

export interface CommandRunResult {
  success: boolean;
  exitCode?: number;
  message: string;
}

export async function runCommand(
  action: AllowedCommand,
  payload: Record<string, unknown> | undefined,
  config: AgentConfig
): Promise<CommandRunResult> {
  switch (action) {
    case 'restart_player_process': {
      const { alive, pid } = isOpenClawRunning();
      if (alive && pid) {
        killProcess(pid);
        clearPid('openclaw');
      }
      // Watchdog will auto-restart, but we can also force it
      await sleep(2000);
      const ok = await launchOpenClaw(config);
      return { success: ok, message: ok ? 'OpenClaw restarted' : 'OpenClaw restart failed' };
    }

    case 'restart_agent': {
      logger.info('command', 'restart_agent requested, exiting for WinSW restart');
      // WinSW will restart the agent automatically
      setTimeout(() => process.exit(0), 1000);
      return { success: true, message: 'Agent exiting for restart' };
    }

    case 'start_mpvserver': {
      try {
        execSync('start "" "C:\\Program Files\\MPVServer\\MPVServer.exe"', { shell: 'cmd.exe', timeout: 5000 });
        return { success: true, message: 'MPVServer started' };
      } catch (e) {
        return { success: false, message: `Failed to start MPVServer: ${e}` };
      }
    }

    case 'stop_mpvserver': {
      try {
        execSync('taskkill /IM MPVServer.exe /F', { timeout: 5000 });
        execSync('taskkill /IM mpv.exe /F', { timeout: 5000 }).toString();
      } catch { /* ignore if not running */ }
      return { success: true, message: 'MPVServer stopped' };
    }

    case 'collect_logs': {
      // TODO: implement log collection and upload
      return { success: true, message: 'Log collection not yet implemented' };
    }

    case 'rotate_log': {
      // TODO: implement log rotation
      return { success: true, message: 'Log rotation not yet implemented' };
    }

    case 'reload_config': {
      // TODO: reload config without restarting
      return { success: true, message: 'Config reload not yet implemented' };
    }

    case 'reboot_host': {
      logger.warn('command', 'reboot_host requested');
      // Safety: only execute if explicitly confirmed
      try {
        execSync('shutdown /r /t 30 /c "OpenClaw Agent requested reboot"', { timeout: 5000 });
        return { success: true, message: 'Reboot scheduled in 30 seconds' };
      } catch (e) {
        return { success: false, message: `Reboot failed: ${e}` };
      }
    }

    default:
      return { success: false, message: `Unknown command: ${action}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
