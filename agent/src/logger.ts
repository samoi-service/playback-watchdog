import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'OpenClawPlayerAgent', 'logs'
);

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `agent-${date}.log`);
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function writeLog(level: LogLevel, component: string, message: string, extra?: Record<string, unknown>): void {
  ensureLogDir();
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...extra,
  };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(getLogPath(), line);

  // Also write to stdout for WinSW capture
  if (level === 'ERROR') {
    process.stderr.write(`[${level}] [${component}] ${message}\n`);
  } else {
    process.stdout.write(`[${level}] [${component}] ${message}\n`);
  }
}

export const logger = {
  info: (component: string, message: string, extra?: Record<string, unknown>) =>
    writeLog('INFO', component, message, extra),
  warn: (component: string, message: string, extra?: Record<string, unknown>) =>
    writeLog('WARN', component, message, extra),
  error: (component: string, message: string, extra?: Record<string, unknown>) =>
    writeLog('ERROR', component, message, extra),
  debug: (component: string, message: string, extra?: Record<string, unknown>) =>
    writeLog('DEBUG', component, message, extra),
};
