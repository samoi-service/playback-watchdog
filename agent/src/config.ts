import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig } from './types';

const DEFAULT_CONFIG_PATHS = [
  path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'OpenClawPlayerAgent', 'config', 'agent.json'),
  path.join(process.cwd(), 'config', 'agent.json'),
];

export function loadConfig(configPath?: string): AgentConfig {
  const paths = configPath ? [configPath] : DEFAULT_CONFIG_PATHS;

  for (const p of paths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const config = JSON.parse(raw) as AgentConfig;
      validateConfig(config);
      return config;
    }
  }

  throw new Error(`Config not found. Searched: ${paths.join(', ')}`);
}

function validateConfig(config: AgentConfig): void {
  if (!config.deviceId) throw new Error('config: deviceId is required');
  if (!config.serverBaseUrl) throw new Error('config: serverBaseUrl is required');
  if (!config.deviceToken) throw new Error('config: deviceToken is required');
  if (!config.openclaw?.nodePath) throw new Error('config: openclaw.nodePath is required');
  if (!config.openclaw?.scriptPath) throw new Error('config: openclaw.scriptPath is required');
  if (!config.openclaw?.gatewayToken) throw new Error('config: openclaw.gatewayToken is required');
}
