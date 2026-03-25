export interface AgentConfig {
  protocolVersion: string;
  deviceId: string;
  deviceName: string;
  serverBaseUrl: string;
  deviceToken: string;
  heartbeatIntervalSec: number;
  commandPollIntervalSec: number;
  watchdogIntervalSec: number;
  logRetentionDays: number;
  openclaw: {
    nodePath: string;
    scriptPath: string;
    args: string[];
    gatewayToken: string;
  };
}

export type AgentStatus =
  | 'booting'
  | 'idle'
  | 'healthy'
  | 'warning'
  | 'degraded'
  | 'repairing'
  | 'offline_buffering';

export type CommandStatus =
  | 'queued'
  | 'delivered'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export interface PendingCommand {
  commandId: string;
  action: string;
  payload?: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
}

export interface CommandResult {
  commandId: string;
  action: string;
  status: 'succeeded' | 'failed' | 'rejected';
  exitCode?: number;
  message?: string;
  details?: Record<string, unknown>;
}

export interface HeartbeatPayload {
  deviceId: string;
  protocolVersion: string;
  agentVersion: string;
  timestamp: string;
  overallStatus: AgentStatus;
  metrics: MetricsSnapshot;
  openclawRuntime: {
    pid: number | null;
    uptimeSec: number | null;
    connected: boolean;
    lastRestartReason: string | null;
  };
}

export interface MetricsSnapshot {
  cpuPercent: number;
  ramPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  gpuName: string | null;
  gpuPercent: number | null;
  gpuTempC: number | null;
  diskPercent: number;
  diskFreeGb: number;
  diskTotalGb: number;
  netSendBps: number;
  netRecvBps: number;
  uptimeHours: number;
  mpvserver?: {
    processCount: number;
    instances: Array<{
      port: number;
      pid: number;
      listening: boolean;
      listenAddr: string;
    }>;
  };
}

export const ALLOWED_COMMANDS = [
  'restart_player_process',
  'restart_agent',
  'start_mpvserver',
  'stop_mpvserver',
  'collect_logs',
  'rotate_log',
  'reload_config',
  'reboot_host',
] as const;

export type AllowedCommand = typeof ALLOWED_COMMANDS[number];
