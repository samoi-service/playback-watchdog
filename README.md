# Playback Watchdog System

1 台 Linux 監控伺服器 + N 台 Windows 播控主機的全自動健康監控與重啟系統。

---

## 快速導覽

| 文件 | 內容 |
|------|------|
| **[AI-DEPLOY.md](./AI-DEPLOY.md)** | AI 自動部署（Claude / Codex / Gemini 通用） |
| [DEPLOY.md](./DEPLOY.md) | 完整部署手冊（手動步驟 + 設定說明 + API） |
| [DEV-SPEC.md](./DEV-SPEC.md) | 技術規格與架構設計 |

---

## 系統架構

本 repo 包含兩套系統：

### v1 — 通用 Watchdog（linux-monitor + windows-agent）

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Linux 監控伺服器 :3100      │  ping   │  Windows 播控主機 A :4010    │
│  linux-monitor              ├────────>│  windows-agent               │
│                             ├─GET────>│  GET  /api/v1/status         │
│                             ├─POST───>│  POST /api/v1/restart        │
│  ◄──────────────────────────┤         │  heartbeat 每 5 秒           │
│  POST /api/v1/heartbeat     │         └──────────────────────────────┘
│  GET  /api/v1/nodes         │
│  GET  /api/v1/nodes/:id     │         ┌──────────────────────────────┐
└─────────────────────────────┘         │  Windows 播控主機 B :4010    │
                                        └──────────────────────────────┘
```

### v2 — Royal13 OpenClaw 場域監控（server + agent）

```
Mac mini: Control Server (server/)
    | HTTPS / JSON (v1 Protocol)
4x Windows Player: Player Agent (agent/)
    WinSW -> Agent -> OpenClaw Runtime
```

---

## 目錄結構

```
playback-watchdog/
├── linux-monitor/          ← v1 通用監控伺服器 (Fastify)
├── windows-agent/          ← v1 通用 Windows Agent (Fastify)
├── server/                 ← v2 Royal13 Control Server (Node.js)
├── agent/                  ← v2 Royal13 Player Agent (TypeScript)
├── docs/                   ← v2 設計文件
├── scripts/                ← v2 部署腳本
├── DEPLOY.md               ← v1 部署手冊
├── DEV-SPEC.md             ← v1 技術規格
└── AI-DEPLOY.md            ← AI 自動部署提示
```

## v2 Royal13 設備

| ID | 名稱 | LAN IP |
|----|------|--------|
| royal13-a2 | Royal13-A2 | 192.168.1.174 |
| royal13-a3 | Royal13-A3 | 192.168.1.178 |
| royal13-bigv | Royal13-BigV | 192.168.0.201 |
| royal13-littlev | Royal13-LittleV | 192.168.0.198 |

## 健康狀態 (v1)

| 狀態 | 條件 | 動作 |
|------|------|------|
| `healthy` | ping + heartbeat + appRunning 全 OK | 無 |
| `degraded` | heartbeat 超時 或 appRunning=false | **自動重啟** |
| `recovering` | 已發出 restart，等待確認（30s timeout） | 輪詢確認 |
| `agent_down` | ping 通但 /status 無回應 | 僅警示 |
| `offline` | ping 失敗 | 僅記錄 |

## 快速啟動

### v1 通用 Watchdog

```bash
# Linux 伺服器
cd linux-monitor && npm install && npm run build
PORT=3100 npm start
```

```powershell
# Windows 主機（以管理員執行）
cd windows-agent && npm install && npm run build
# 修改 config\agent.config.json 後：
powershell -ExecutionPolicy Bypass -File scripts\install-task-scheduler.ps1
```

### v2 Royal13 OpenClaw

```bash
# Mac mini Control Server
cd server && npm install && npm start
```

```powershell
# Windows Player Agent
cd agent && npm install && npm run build
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

## 測試 (v1)

```bash
cd linux-monitor
npm test                              # 5 個單元整合測試
python3 tests/live-system.test.py    # 12 項 live 驗收測試（需系統在線）
```
