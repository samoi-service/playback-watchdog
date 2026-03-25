import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';

const RUNTIME_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'OpenClawPlayerAgent', 'runtime'
);
const HISTORY_FILE = path.join(RUNTIME_DIR, 'command-history.json');
const MAX_ENTRIES = 500;

interface HistoryEntry {
  commandId: string;
  executedAt: string;
}

let history: HistoryEntry[] = [];

export function loadCommandHistory(): void {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {
    history = [];
  }
}

function saveHistory(): void {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf-8');
  } catch (e) {
    logger.warn('commandHistory', `Failed to save: ${e}`);
  }
}

export function wasAlreadyExecuted(commandId: string): boolean {
  return history.some((h) => h.commandId === commandId);
}

export function markExecuted(commandId: string): void {
  history.push({ commandId, executedAt: new Date().toISOString() });
  // Trim old entries
  if (history.length > MAX_ENTRIES) {
    history = history.slice(-MAX_ENTRIES);
  }
  saveHistory();
}
