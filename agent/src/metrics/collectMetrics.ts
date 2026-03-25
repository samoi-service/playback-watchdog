import { execSync } from 'child_process';
import { MetricsSnapshot } from '../types';
import { logger } from '../logger';
import * as os from 'os';

export async function collectMetrics(): Promise<MetricsSnapshot> {
  const cpuPercent = getCpuPercent();
  const { ramPercent, ramUsedMb, ramTotalMb } = getRamInfo();
  const { diskPercent, diskFreeGb, diskTotalGb } = getDiskInfo();
  const gpu = getGpuInfo();
  const net = getNetworkInfo();
  const uptimeHours = os.uptime() / 3600;
  const mpvserver = getMpvserverInfo();

  return {
    cpuPercent,
    ramPercent,
    ramUsedMb,
    ramTotalMb,
    gpuName: gpu.name,
    gpuPercent: gpu.percent,
    gpuTempC: gpu.tempC,
    diskPercent,
    diskFreeGb,
    diskTotalGb,
    netSendBps: net.sendBps,
    netRecvBps: net.recvBps,
    uptimeHours: Math.round(uptimeHours * 10) / 10,
    mpvserver,
  };
}

function getCpuPercent(): number {
  try {
    const out = execSync(
      'wmic cpu get LoadPercentage /value',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const match = out.match(/LoadPercentage=(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

function getRamInfo(): { ramPercent: number; ramUsedMb: number; ramTotalMb: number } {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramTotalMb = Math.round(totalMem / (1024 * 1024));
    const ramUsedMb = Math.round(usedMem / (1024 * 1024));
    const ramPercent = Math.round((usedMem / totalMem) * 1000) / 10;
    return { ramPercent, ramUsedMb, ramTotalMb };
  } catch {
    return { ramPercent: 0, ramUsedMb: 0, ramTotalMb: 0 };
  }
}

function getDiskInfo(): { diskPercent: number; diskFreeGb: number; diskTotalGb: number } {
  try {
    const out = execSync(
      'wmic logicaldisk where DeviceID="C:" get Size,FreeSpace /value',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const freeMatch = out.match(/FreeSpace=(\d+)/);
    const sizeMatch = out.match(/Size=(\d+)/);
    if (freeMatch && sizeMatch) {
      const free = parseInt(freeMatch[1], 10);
      const total = parseInt(sizeMatch[1], 10);
      const diskFreeGb = Math.round(free / (1024 ** 3) * 10) / 10;
      const diskTotalGb = Math.round(total / (1024 ** 3) * 10) / 10;
      const diskPercent = Math.round((1 - free / total) * 1000) / 10;
      return { diskPercent, diskFreeGb, diskTotalGb };
    }
    return { diskPercent: 0, diskFreeGb: 0, diskTotalGb: 0 };
  } catch {
    return { diskPercent: 0, diskFreeGb: 0, diskTotalGb: 0 };
  }
}

function getGpuInfo(): { name: string | null; percent: number | null; tempC: number | null } {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const parts = out.trim().split(',').map((s) => s.trim());
    return {
      name: parts[0] || null,
      percent: parts[1] ? parseFloat(parts[1]) : null,
      tempC: parts[2] ? parseFloat(parts[2]) : null,
    };
  } catch {
    return { name: null, percent: null, tempC: null };
  }
}

function getNetworkInfo(): { sendBps: number; recvBps: number } {
  // Simplified: return 0 for now, can be enhanced with perf counters
  return { sendBps: 0, recvBps: 0 };
}

function getMpvserverInfo(): MetricsSnapshot['mpvserver'] {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq MPVServer.exe" /NH',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const lines = out.split('\n').filter((l) => l.includes('MPVServer.exe'));
    return {
      processCount: lines.length,
      instances: lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[1], 10);
        return { port: 0, pid: isNaN(pid) ? 0 : pid, listening: true, listenAddr: '' };
      }),
    };
  } catch {
    return { processCount: 0, instances: [] };
  }
}
