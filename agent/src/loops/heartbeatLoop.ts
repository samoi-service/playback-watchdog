import { AxiosInstance } from 'axios';
import { AgentConfig, HeartbeatPayload } from '../types';
import { AgentState } from '../state';
import { logger } from '../logger';
import { sendHeartbeat } from '../transport/heartbeatApi';
import { getOpenClawStatus } from '../runtime/openclawLauncher';
import { collectMetrics } from '../metrics/collectMetrics';
import { enqueue, flushQueue } from '../transport/offlineQueue';

const AGENT_VERSION = '0.1.0';
let heartbeatTimer: NodeJS.Timeout | null = null;

export function startHeartbeatLoop(config: AgentConfig, state: AgentState, client: AxiosInstance): void {
  const intervalMs = config.heartbeatIntervalSec * 1000;

  async function tick() {
    let payload: HeartbeatPayload | null = null;
    try {
      const ocStatus = getOpenClawStatus();
      const metrics = await collectMetrics();

      payload = {
        deviceId: config.deviceId,
        protocolVersion: config.protocolVersion,
        agentVersion: AGENT_VERSION,
        timestamp: new Date().toISOString(),
        overallStatus: state.status,
        metrics,
        openclawRuntime: {
          pid: ocStatus.pid,
          uptimeSec: ocStatus.uptimeSec,
          connected: ocStatus.running,
          lastRestartReason: null,
        },
      };

      await sendHeartbeat(client, payload);
      state.setServerReachable(true);

      if (state.status === 'booting' || state.status === 'idle') {
        state.transition('healthy', 'first heartbeat sent');
      }

      // Flush any queued offline data
      await flushQueue(client);
    } catch (e) {
      state.setServerReachable(false);
      // Queue heartbeat for later delivery (if payload was built)
      if (payload) {
        enqueue('heartbeat', '/api/v1/heartbeat', payload);
      }
      logger.warn('heartbeat', `Failed to send heartbeat (queued offline): ${e}`);
    }
  }

  tick();
  heartbeatTimer = setInterval(tick, intervalMs);
  logger.info('heartbeat', `Started (every ${config.heartbeatIntervalSec}s)`);
}

export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
