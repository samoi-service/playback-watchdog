import * as fs from 'fs';
import * as path from 'path';
import { AxiosInstance } from 'axios';
import { logger } from '../logger';

const RUNTIME_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'OpenClawPlayerAgent', 'runtime'
);
const QUEUE_FILE = path.join(RUNTIME_DIR, 'offline-queue.json');
const MAX_QUEUED = 200;

interface QueuedItem {
  type: 'heartbeat' | 'metrics' | 'events' | 'command-result';
  url: string;
  payload: unknown;
  queuedAt: string;
}

let queue: QueuedItem[] = [];

export function loadOfflineQueue(): void {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    }
  } catch {
    queue = [];
  }
}

function saveQueue(): void {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue), 'utf-8');
  } catch (e) {
    logger.warn('offlineQueue', `Failed to save: ${e}`);
  }
}

export function enqueue(type: QueuedItem['type'], url: string, payload: unknown): void {
  queue.push({ type, url, payload, queuedAt: new Date().toISOString() });
  if (queue.length > MAX_QUEUED) {
    queue = queue.slice(-MAX_QUEUED);
  }
  saveQueue();
  logger.debug('offlineQueue', `Queued ${type}, total: ${queue.length}`);
}

export async function flushQueue(client: AxiosInstance): Promise<void> {
  if (queue.length === 0) return;
  const toSend = [...queue];
  queue = [];
  saveQueue();

  let sent = 0;
  let failed = 0;
  for (const item of toSend) {
    try {
      await client.post(item.url, item.payload);
      sent++;
    } catch {
      // Re-queue failed items
      queue.push(item);
      failed++;
    }
  }
  if (failed > 0) saveQueue();
  logger.info('offlineQueue', `Flushed: ${sent} sent, ${failed} re-queued`);
}

export function queueSize(): number {
  return queue.length;
}
