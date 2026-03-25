import * as fs from 'fs';
import * as path from 'path';

const PID_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'OpenClawPlayerAgent', 'runtime'
);

export function savePid(name: string, pid: number): void {
  if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(path.join(PID_DIR, `${name}.pid`), String(pid));
}

export function loadPid(name: string): number | null {
  const p = path.join(PID_DIR, `${name}.pid`);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

export function clearPid(name: string): void {
  const p = path.join(PID_DIR, `${name}.pid`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
