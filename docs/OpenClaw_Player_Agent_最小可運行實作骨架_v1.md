# OpenClaw Player Agent 最小可運行實作骨架 v1.0

## 一、目標

本文件提供一個可直接開始開發的最小可運行實作骨架，目標如下：

- Windows Player 上有一個 Node Agent 常駐
- Node Agent 可啟動並監控 OpenClaw Runtime
- Node Agent 可定時送 heartbeat 到 Linux Control Server
- Node Agent 可輪詢 pending commands
- Node Agent 可執行最小白名單命令
- Node Agent 可在 OpenClaw 掛掉時自動重啟
- Node Agent 可被 WinSW 包裝為 Windows Service
- PowerShell 只負責 install / uninstall / repair

本骨架刻意維持在 **v1 最小可落地**，不先做：

- 任意 remote shell
- 複雜自更新
- mTLS
- WebSocket 常駐通道
- 過度複雜的 process 管理

---

## 二、最小骨架總覽

```text
Linux Control Server
  ├─ POST /api/v1/heartbeat
  ├─ GET  /api/v1/commands/pending
  └─ POST /api/v1/command-result

Windows Player
  ├─ WinSW Service Wrapper
  ├─ Node Agent
  │   ├─ launcher
  │   ├─ process watcher
  │   ├─ heartbeat loop
  │   ├─ command poll loop
  │   └─ local command runner
  └─ OpenClaw Runtime
```

---

## 三、專案目錄結構

## 3.1 Windows Player Agent

```text
openclaw-player-agent/
├── package.json
├── tsconfig.json
├── README.md
├── app/
│   └── dist/
│       └── agent.js
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── logger.ts
│   ├── state.ts
│   ├── types.ts
│   ├── loops/
│   │   ├── heartbeatLoop.ts
│   │   ├── commandPollLoop.ts
│   │   └── watchdogLoop.ts
│   ├── runtime/
│   │   ├── openclawLauncher.ts
│   │   ├── processWatcher.ts
│   │   └── pidStore.ts
│   ├── commands/
│   │   ├── commandRunner.ts
│   │   ├── schemas.ts
│   │   └── handlers/
│   │       ├── restartOpenClaw.ts
│   │       ├── collectLogs.ts
│   │       ├── rotateLog.ts
│   │       ├── reloadConfig.ts
│   │       ├── restartAgent.ts
│   │       └── rebootHost.ts
│   ├── transport/
│   │   ├── apiClient.ts
│   │   ├── heartbeatApi.ts
│   │   ├── commandApi.ts
│   │   └── resultApi.ts
│   ├── metrics/
│   │   └── collectMetrics.ts
│   └── utils/
│       ├── delay.ts
│       ├── time.ts
│       └── fs.ts
├── config/
│   └── agent.example.json
├── scripts/
│   ├── install.ps1
│   ├── uninstall.ps1
│   └── repair.ps1
├── winsw/
│   ├── OpenClawPlayerAgent.exe
│   └── OpenClawPlayerAgent.xml
└── logs/
```

## 3.2 Linux Control Server（最小版）

```text
openclaw-control-server/
├── package.json
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── heartbeat.ts
│   │   ├── commands.ts
│   │   └── commandResult.ts
│   ├── store/
│   │   └── memoryStore.ts
│   └── types.ts
└── README.md
```

---

## 四、Windows Agent package.json

```json
{
  "name": "openclaw-player-agent",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "main": "app/dist/agent.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node app/dist/agent.js",
    "dev": "ts-node src/index.ts"
  },
  "dependencies": {
    "axios": "^1.8.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.7.3"
  }
}
```

---

## 五、Windows Agent 設定檔範例

檔名：

```text
C:\ProgramData\OpenClawPlayerAgent\config\agent.json
```

內容：

```json
{
  "protocolVersion": "1.0",
  "deviceId": "tw-site-a-player-01",
  "deviceName": "Player-A01",
  "serverBaseUrl": "https://control-server.local",
  "deviceToken": "REPLACE_ME",
  "heartbeatIntervalSec": 15,
  "commandPollIntervalSec": 5,
  "watchdogIntervalSec": 5,
  "logRetentionDays": 14,
  "allowedProcesses": ["openclaw"],
  "openclaw": {
    "nodePath": "C:\\Program Files\\nodejs\\node.exe",
    "scriptPath": "C:\\Program Files\\OpenClawRuntime\\openclaw.mjs",
    "args": [
      "node",
      "run",
      "--host",
      "example.tailnet.ts.net",
      "--port",
      "443",
      "--tls",
      "--display-name",
      "player-a01"
    ],
    "workingDirectory": "C:\\Program Files\\OpenClawRuntime"
  }
}
```

---

## 六、Windows Agent 最小 TypeScript 型別

```ts
// src/types.ts
export type AgentConfig = {
  protocolVersion: string;
  deviceId: string;
  deviceName: string;
  serverBaseUrl: string;
  deviceToken: string;
  heartbeatIntervalSec: number;
  commandPollIntervalSec: number;
  watchdogIntervalSec: number;
  logRetentionDays: number;
  allowedProcesses: string[];
  openclaw: {
    nodePath: string;
    scriptPath: string;
    args: string[];
    workingDirectory: string;
  };
};

export type CommandAction =
  | "restart_player_process"
  | "restart_agent"
  | "collect_logs"
  | "rotate_log"
  | "reload_config"
  | "reboot_host";

export type PendingCommand = {
  command_id: string;
  issued_at: string;
  expires_at: string;
  requested_by: string;
  reason: string;
  action: CommandAction;
  payload: Record<string, unknown>;
};
```

---

## 七、Windows Agent 入口檔

```ts
// src/index.ts
import { loadConfig } from "./config";
import { logger } from "./logger";
import { startHeartbeatLoop } from "./loops/heartbeatLoop";
import { startCommandPollLoop } from "./loops/commandPollLoop";
import { startWatchdogLoop } from "./loops/watchdogLoop";
import { ensureOpenClawRunning } from "./runtime/openclawLauncher";

async function main() {
  const config = loadConfig();

  logger.info("agent_starting", {
    deviceId: config.deviceId,
    serverBaseUrl: config.serverBaseUrl
  });

  await ensureOpenClawRunning(config);

  startHeartbeatLoop(config);
  startCommandPollLoop(config);
  startWatchdogLoop(config);

  process.on("SIGTERM", () => {
    logger.warn("agent_sigterm");
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    logger.error("agent_uncaught_exception", { message: err.message, stack: err.stack });
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("agent_unhandled_rejection", { reason: String(reason) });
  });
}

main().catch((err) => {
  logger.error("agent_fatal", { message: err.message, stack: err.stack });
  process.exit(1);
});
```

---

## 八、設定載入

```ts
// src/config.ts
import fs from "node:fs";
import path from "node:path";
import { AgentConfig } from "./types";

const CONFIG_PATH =
  process.env.OPENCLAW_AGENT_CONFIG ||
  "C:\\ProgramData\\OpenClawPlayerAgent\\config\\agent.json";

export function loadConfig(): AgentConfig {
  const raw = fs.readFileSync(path.resolve(CONFIG_PATH), "utf-8");
  return JSON.parse(raw) as AgentConfig;
}
```

---

## 九、最小 logger

```ts
// src/logger.ts
type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  });
  console.log(line);
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data)
};
```

---

## 十、OpenClaw Launcher

```ts
// src/runtime/openclawLauncher.ts
import { spawn } from "node:child_process";
import { AgentConfig } from "../types";
import { logger } from "../logger";
import { getRunningOpenClawPid, saveOpenClawPid } from "./pidStore";

export async function ensureOpenClawRunning(config: AgentConfig): Promise<void> {
  const existingPid = await getRunningOpenClawPid();
  if (existingPid) {
    logger.info("openclaw_already_running", { pid: existingPid });
    return;
  }

  const child = spawn(
    config.openclaw.nodePath,
    [config.openclaw.scriptPath, ...config.openclaw.args],
    {
      cwd: config.openclaw.workingDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );

  child.unref();
  saveOpenClawPid(child.pid ?? 0);

  logger.info("openclaw_started", { pid: child.pid });
}
```

---

## 十一、PID 管理

```ts
// src/runtime/pidStore.ts
import fs from "node:fs";

const PID_FILE = "C:\\ProgramData\\OpenClawPlayerAgent\\runtime\\openclaw.pid";

export function saveOpenClawPid(pid: number) {
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}

export async function getRunningOpenClawPid(): Promise<number | null> {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid)) return null;

    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
```

---

## 十二、Watchdog Loop

```ts
// src/loops/watchdogLoop.ts
import { AgentConfig } from "../types";
import { logger } from "../logger";
import { ensureOpenClawRunning } from "../runtime/openclawLauncher";

export function startWatchdogLoop(config: AgentConfig) {
  setInterval(async () => {
    try {
      await ensureOpenClawRunning(config);
    } catch (err) {
      logger.error("watchdog_failed", { message: String(err) });
    }
  }, config.watchdogIntervalSec * 1000);
}
```

---

## 十三、Heartbeat API Client

```ts
// src/transport/apiClient.ts
import axios from "axios";
import { AgentConfig } from "../types";

export function createApiClient(config: AgentConfig) {
  return axios.create({
    baseURL: config.serverBaseUrl,
    timeout: 5000,
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": config.deviceId,
      "X-Device-Token": config.deviceToken
    }
  });
}
```

```ts
// src/transport/heartbeatApi.ts
import os from "node:os";
import { AgentConfig } from "../types";
import { createApiClient } from "./apiClient";
import { getRunningOpenClawPid } from "../runtime/pidStore";

export async function sendHeartbeat(config: AgentConfig) {
  const client = createApiClient(config);
  const pid = await getRunningOpenClawPid();

  return client.post("/api/v1/heartbeat", {
    protocol_version: "1.0",
    device_id: config.deviceId,
    device_name: config.deviceName,
    sent_at: new Date().toISOString(),
    agent_version: "1.0.0",
    host: {
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      ip: null
    },
    status: {
      overall: pid ? "healthy" : "critical",
      uptime_sec: Math.floor(os.uptime()),
      cpu_percent: null,
      ram_percent: null,
      disk_percent: null,
      gpu_percent: null
    },
    player_process: {
      name: "openclaw",
      running: !!pid,
      pid,
      uptime_sec: null,
      restart_count_24h: 0
    },
    transport: {
      server_reachable: true,
      last_successful_command_poll_at: null
    }
  });
}
```

```ts
// src/loops/heartbeatLoop.ts
import { AgentConfig } from "../types";
import { logger } from "../logger";
import { sendHeartbeat } from "../transport/heartbeatApi";

export function startHeartbeatLoop(config: AgentConfig) {
  setInterval(async () => {
    try {
      await sendHeartbeat(config);
      logger.info("heartbeat_sent");
    } catch (err) {
      logger.warn("heartbeat_failed", { message: String(err) });
    }
  }, config.heartbeatIntervalSec * 1000);
}
```

---

## 十四、Command Poll Loop

```ts
// src/transport/commandApi.ts
import { AgentConfig, PendingCommand } from "../types";
import { createApiClient } from "./apiClient";

export async function pollPendingCommands(config: AgentConfig): Promise<PendingCommand[]> {
  const client = createApiClient(config);
  const res = await client.get("/api/v1/commands/pending", {
    params: {
      device_id: config.deviceId,
      limit: 10
    }
  });

  return res.data?.data?.commands ?? [];
}
```

```ts
// src/transport/resultApi.ts
import { AgentConfig } from "../types";
import { createApiClient } from "./apiClient";

export async function sendCommandResult(
  config: AgentConfig,
  payload: Record<string, unknown>
) {
  const client = createApiClient(config);
  await client.post("/api/v1/command-result", payload);
}
```

```ts
// src/loops/commandPollLoop.ts
import { AgentConfig } from "../types";
import { logger } from "../logger";
import { pollPendingCommands } from "../transport/commandApi";
import { runCommand } from "../commands/commandRunner";

export function startCommandPollLoop(config: AgentConfig) {
  setInterval(async () => {
    try {
      const commands = await pollPendingCommands(config);
      for (const cmd of commands) {
        await runCommand(config, cmd);
      }
    } catch (err) {
      logger.warn("command_poll_failed", { message: String(err) });
    }
  }, config.commandPollIntervalSec * 1000);
}
```

---

## 十五、最小 Command Runner

```ts
// src/commands/commandRunner.ts
import { AgentConfig, PendingCommand } from "../types";
import { sendCommandResult } from "../transport/resultApi";
import { restartOpenClawHandler } from "./handlers/restartOpenClaw";
import { logger } from "../logger";

export async function runCommand(config: AgentConfig, cmd: PendingCommand) {
  const now = Date.now();
  const expiresAt = new Date(cmd.expires_at).getTime();

  if (expiresAt < now) {
    await sendCommandResult(config, {
      protocol_version: "1.0",
      device_id: config.deviceId,
      sent_at: new Date().toISOString(),
      command_result: {
        command_id: cmd.command_id,
        action: cmd.action,
        status: "expired",
        started_at: null,
        finished_at: new Date().toISOString(),
        exit_code: 1,
        message: "Command expired.",
        details: {}
      }
    });
    return;
  }

  logger.info("command_received", {
    commandId: cmd.command_id,
    action: cmd.action
  });

  const startedAt = new Date().toISOString();

  try {
    switch (cmd.action) {
      case "restart_player_process":
        await restartOpenClawHandler(config, cmd.payload);
        break;
      default:
        throw new Error(`Unsupported action: ${cmd.action}`);
    }

    await sendCommandResult(config, {
      protocol_version: "1.0",
      device_id: config.deviceId,
      sent_at: new Date().toISOString(),
      command_result: {
        command_id: cmd.command_id,
        action: cmd.action,
        status: "succeeded",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        exit_code: 0,
        message: "Command executed successfully.",
        details: {}
      }
    });
  } catch (err) {
    await sendCommandResult(config, {
      protocol_version: "1.0",
      device_id: config.deviceId,
      sent_at: new Date().toISOString(),
      command_result: {
        command_id: cmd.command_id,
        action: cmd.action,
        status: "failed",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        exit_code: 1,
        message: String(err),
        details: {}
      }
    });
  }
}
```

---

## 十六、restart_openclaw handler

```ts
// src/commands/handlers/restartOpenClaw.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentConfig } from "../../types";
import { ensureOpenClawRunning } from "../../runtime/openclawLauncher";
import { getRunningOpenClawPid } from "../../runtime/pidStore";

const execFileAsync = promisify(execFile);

export async function restartOpenClawHandler(config: AgentConfig, _payload: unknown) {
  const pid = await getRunningOpenClawPid();

  if (pid) {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  }

  await ensureOpenClawRunning(config);
}
```

---

## 十七、Linux Control Server 最小實作

## 17.1 package.json

```json
{
  "name": "openclaw-control-server",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "dev": "ts-node src/index.ts"
  },
  "dependencies": {
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.7.3"
  }
}
```

## 17.2 memory store

```ts
// src/store/memoryStore.ts
export const store = {
  heartbeats: [] as any[],
  commandsByDevice: new Map<string, any[]>(),
  commandResults: [] as any[]
};
```

## 17.3 index.ts

```ts
// src/index.ts
import express from "express";
import { store } from "./store/memoryStore";

const app = express();
app.use(express.json());

app.post("/api/v1/heartbeat", (req, res) => {
  store.heartbeats.push(req.body);
  return res.json({
    protocol_version: "1.0",
    success: true,
    timestamp: new Date().toISOString(),
    data: {
      accepted: true,
      next_heartbeat_sec: 15
    }
  });
});

app.get("/api/v1/commands/pending", (req, res) => {
  const deviceId = String(req.query.device_id || "");
  const commands = store.commandsByDevice.get(deviceId) || [];

  store.commandsByDevice.set(deviceId, []);

  return res.json({
    protocol_version: "1.0",
    success: true,
    timestamp: new Date().toISOString(),
    data: {
      commands
    }
  });
});

app.post("/api/v1/command-result", (req, res) => {
  store.commandResults.push(req.body);
  return res.json({
    protocol_version: "1.0",
    success: true,
    timestamp: new Date().toISOString(),
    data: {
      accepted: true
    }
  });
});

app.post("/debug/enqueue-command", (req, res) => {
  const { device_id, command } = req.body;
  const list = store.commandsByDevice.get(device_id) || [];
  list.push(command);
  store.commandsByDevice.set(device_id, list);
  return res.json({ ok: true });
});

app.listen(3000, () => {
  console.log("Control server listening on :3000");
});
```

---

## 十八、WinSW XML 範本

檔名：

```text
winsw/OpenClawPlayerAgent.xml
```

內容：

```xml
<service>
  <id>OpenClawPlayerAgent</id>
  <name>OpenClaw Player Agent</name>
  <description>OpenClaw field player agent service</description>

  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>app\dist\agent.js</arguments>
  <workingdirectory>%BASE%</workingdirectory>

  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>

  <onfailure action="restart" delay="10 sec" />
  <startmode>Automatic</startmode>
</service>
```

---

## 十九、install.ps1 最小流程

```powershell
$ErrorActionPreference = "Stop"

$Base = "C:\Program Files\OpenClawPlayerAgent"
$Data = "C:\ProgramData\OpenClawPlayerAgent"

New-Item -ItemType Directory -Force -Path $Base | Out-Null
New-Item -ItemType Directory -Force -Path "$Base\app\dist" | Out-Null
New-Item -ItemType Directory -Force -Path $Data | Out-Null
New-Item -ItemType Directory -Force -Path "$Data\config" | Out-Null
New-Item -ItemType Directory -Force -Path "$Data\logs" | Out-Null
New-Item -ItemType Directory -Force -Path "$Data\runtime" | Out-Null

Copy-Item ".\winsw\OpenClawPlayerAgent.exe" "$Base\OpenClawPlayerAgent.exe" -Force
Copy-Item ".\winsw\OpenClawPlayerAgent.xml" "$Base\OpenClawPlayerAgent.xml" -Force
Copy-Item ".\app\dist\agent.js" "$Base\app\dist\agent.js" -Force

if (-not (Test-Path "$Data\config\agent.json")) {
    Copy-Item ".\config\agent.example.json" "$Data\config\agent.json"
}

Push-Location $Base
.\OpenClawPlayerAgent.exe install
.\OpenClawPlayerAgent.exe start
Pop-Location
```

---

## 二十、uninstall.ps1 最小流程

```powershell
$Base = "C:\Program Files\OpenClawPlayerAgent"

Push-Location $Base
.\OpenClawPlayerAgent.exe stop
.\OpenClawPlayerAgent.exe uninstall
Pop-Location
```

---

## 二十一、repair.ps1 最小流程

```powershell
$Base = "C:\Program Files\OpenClawPlayerAgent"

if (-not (Test-Path "$Base\OpenClawPlayerAgent.exe")) {
    throw "Service wrapper not found."
}

Push-Location $Base
.\OpenClawPlayerAgent.exe stop
Start-Sleep -Seconds 2
.\OpenClawPlayerAgent.exe start
Pop-Location
```

---

## 二十二、最小驗收流程

## 1. 啟動 Linux server

```bash
npm install
npm run dev
```

## 2. Windows agent build

```powershell
npm install
npm run build
```

## 3. 安裝 service

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## 4. 檢查 heartbeat
確認 Linux server 有收到：

- `/api/v1/heartbeat`

## 5. 測試 command enqueue
對 Linux server 送：

```json
{
  "device_id": "tw-site-a-player-01",
  "command": {
    "command_id": "cmd_20260325_000001",
    "issued_at": "2026-03-25T08:29:55Z",
    "expires_at": "2099-03-25T08:34:55Z",
    "requested_by": "operator_admin",
    "reason": "manual test",
    "action": "restart_player_process",
    "payload": {}
  }
}
```

## 6. 確認 agent 有拉到 command 並送回 command-result

---

## 二十三、v1 下一步建議

當最小骨架跑起來後，再補：

- metrics 真實採集
- command 去重
- audit log
- config reload
- collect logs zip
- reboot protection
- DPAPI / Credential Manager
- PostgreSQL
- dashboard
- alert engine

---

## 二十四、結論

這份最小骨架的核心重點是：

```text
WinSW 負責 service
Node Agent 負責本機維運
OpenClaw 負責原本 runtime
Linux Server 負責中央控制
```

也就是先把整套系統切成最小可跑的 4 層：

```text
Linux Control Server
    ↓
WinSW
    ↓
Node Agent
    ↓
OpenClaw Runtime
```

這樣你就可以直接把本文件丟給 Claude，要求它先做出一個真正可啟動、可發 heartbeat、可收 command、可重啟 OpenClaw 的 v1 最小版本。
