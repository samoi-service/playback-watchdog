# OpenClaw 場域端 API 與 Command Protocol 規格 v1.0

## 一、文件目的

本文件定義 OpenClaw 場域端監控控制系統的：

- Linux Central Control Server API
- Windows Player Agent 通訊方式
- Command Protocol
- 狀態回報格式
- 安全與驗證要求
- 回應碼與錯誤模型
- v1 實作邊界

適用架構：

- 1 台 Linux Server
- 4 台 Windows Player
- Windows Player 以本機 Agent 方式常駐
- Linux Server 作為中央控制與監控節點

本文件目標是讓後續 Claude / 工程人員可直接依照明確規格實作，不再依賴臨場猜測。

---

## 二、設計原則

### 2.1 核心原則

1. Player 主動連線 Server
2. Server 不直接遠端執行任意腳本
3. 命令必須白名單
4. 所有重要操作必須可審計
5. Server 暫時離線不得影響 Player 基本播控
6. Protocol 必須可擴充
7. 回傳格式必須固定且結構化

### 2.2 通訊模式

v1 採用：

```text
HTTP(S) + JSON
```

且由 Windows Player Agent 主動：

- POST 狀態
- GET / POST 拉取命令
- POST 回報命令結果

### 2.3 為什麼不用任意 Remote Shell

v1 明確禁止：

- exec_ps
- 任意 PowerShell
- 任意 CMD
- 任意下載執行
- 任意 Base64 script payload

原因：

- 場域端 Player 連接商業空間播控與輸出設備
- 任意腳本等同高風險遠端接管能力
- 不符合 production 最小權限原則

---

## 三、版本與命名規則

## 3.1 API 版本

所有 API v1 路徑統一使用：

```text
/api/v1/
```

### 範例
```text
POST /api/v1/heartbeat
GET  /api/v1/commands/pending
POST /api/v1/command-result
```

## 3.2 協定版本

每個請求與回應應帶有：

```json
{
  "protocol_version": "1.0"
}
```

## 3.3 時間格式

統一使用：

```text
ISO 8601 UTC
```

範例：

```text
2026-03-25T08:30:15Z
```

## 3.4 ID 規則

### device_id
建議格式：

```text
tw-site-a-player-01
```

### command_id
建議格式：

```text
cmd_20260325_000001
```

### event_id
建議格式：

```text
evt_20260325_000001
```

---

## 四、身份驗證與安全要求

## 4.1 傳輸層

正式環境必須使用：

```text
HTTPS
```

禁止 HTTP 明文傳輸。

## 4.2 Device 身份驗證

v1 建議使用：

- device_id
- device_token

由 Player Agent 在 Header 帶入：

```http
X-Device-Id: tw-site-a-player-01
X-Device-Token: <secret>
```

### 補充
之後可升級為：

- HMAC 簽章
- mTLS
- 短期 access token + refresh token

但 v1 可先用固定 device token。

## 4.3 Token 存放要求

Windows Player 不得將 token 明文硬寫於：

- ps1
- bat
- scheduled task command line
- 可被一般使用者直接讀取的純文字檔

建議：

- DPAPI
- Credential Manager
- 受 ACL 限制的 config 檔案

## 4.4 指令安全要求

每個 command 應至少包含：

- command_id
- issued_at
- expires_at
- action
- payload
- requested_by
- reason

超過 expires_at 的 command 必須拒絕執行。

---

## 五、通用 JSON 結構

## 5.1 通用成功回應

```json
{
  "protocol_version": "1.0",
  "success": true,
  "timestamp": "2026-03-25T08:30:15Z",
  "data": {}
}
```

## 5.2 通用失敗回應

```json
{
  "protocol_version": "1.0",
  "success": false,
  "timestamp": "2026-03-25T08:30:15Z",
  "error": {
    "code": "INVALID_DEVICE_TOKEN",
    "message": "Device token is invalid."
  }
}
```

## 5.3 通用欄位規範

### success
- `true`：本次請求成功
- `false`：本次請求失敗

### timestamp
- Server 回應產生時間

### error.code
- 固定錯誤碼
- 不可只回傳自由文字

### data
- 成功時的主體資料

---

## 六、Player → Server API

## 6.1 Heartbeat API

### 用途
Player 定期回報自身狀態摘要。

### Method
```http
POST /api/v1/heartbeat
```

### Request Body
```json
{
  "protocol_version": "1.0",
  "device_id": "tw-site-a-player-01",
  "device_name": "Player-A01",
  "sent_at": "2026-03-25T08:30:15Z",
  "agent_version": "1.0.0",
  "host": {
    "hostname": "PLAYER-A01",
    "os": "Windows 11",
    "ip": "192.168.1.101"
  },
  "status": {
    "overall": "healthy",
    "uptime_sec": 86400,
    "cpu_percent": 23.5,
    "ram_percent": 61.2,
    "disk_percent": 70.1,
    "gpu_percent": 45.8
  },
  "player_process": {
    "name": "openclaw-player",
    "running": true,
    "pid": 1234,
    "uptime_sec": 7200,
    "restart_count_24h": 1
  },
  "transport": {
    "server_reachable": true,
    "last_successful_command_poll_at": "2026-03-25T08:29:45Z"
  }
}
```

### overall 狀態建議值
```text
healthy
warning
degraded
critical
offline
```

### Success Response
```json
{
  "protocol_version": "1.0",
  "success": true,
  "timestamp": "2026-03-25T08:30:16Z",
  "data": {
    "accepted": true,
    "next_heartbeat_sec": 15
  }
}
```

---

## 6.2 Metrics API

### 用途
回報較完整 metrics 快照，可低頻傳送。

### Method
```http
POST /api/v1/metrics
```

### Request Body
```json
{
  "protocol_version": "1.0",
  "device_id": "tw-site-a-player-01",
  "sent_at": "2026-03-25T08:30:15Z",
  "metrics": {
    "cpu_percent": 23.5,
    "ram_used_mb": 15780,
    "ram_total_mb": 32768,
    "disk_used_gb": 512,
    "disk_total_gb": 1024,
    "gpu_percent": 45.8,
    "gpu_memory_used_mb": 8200,
    "gpu_memory_total_mb": 24576,
    "network_tx_kbps": 1200,
    "network_rx_kbps": 850
  },
  "display": {
    "resolution": "3840x2160",
    "refresh_rate_hz": 60,
    "fullscreen": true
  }
}
```

### Success Response
```json
{
  "protocol_version": "1.0",
  "success": true,
  "timestamp": "2026-03-25T08:30:16Z",
  "data": {
    "accepted": true
  }
}
```

---

## 6.3 Events API

### 用途
Player 回報重要事件與異常。

### Method
```http
POST /api/v1/events
```

### Request Body
```json
{
  "protocol_version": "1.0",
  "device_id": "tw-site-a-player-01",
  "sent_at": "2026-03-25T08:30:15Z",
  "events": [
    {
      "event_id": "evt_20260325_000001",
      "level": "warning",
      "category": "process",
      "code": "PLAYER_PROCESS_RESTARTED",
      "message": "Player process restarted by local agent.",
      "occurred_at": "2026-03-25T08:29:50Z",
      "details": {
        "old_pid": 4321,
        "new_pid": 1234,
        "restart_reason": "health_check_failed"
      }
    }
  ]
}
```

### level 建議值
```text
info
warning
error
critical
```

### category 建議值
```text
process
system
network
display
storage
security
command
```

---

## 6.4 Command Result API

### 用途
Player 回報命令執行結果。

### Method
```http
POST /api/v1/command-result
```

### Request Body
```json
{
  "protocol_version": "1.0",
  "device_id": "tw-site-a-player-01",
  "sent_at": "2026-03-25T08:30:15Z",
  "command_result": {
    "command_id": "cmd_20260325_000001",
    "action": "restart_player_process",
    "status": "succeeded",
    "started_at": "2026-03-25T08:29:58Z",
    "finished_at": "2026-03-25T08:30:05Z",
    "exit_code": 0,
    "message": "Player process restarted successfully.",
    "details": {
      "old_pid": 4321,
      "new_pid": 1234
    }
  }
}
```

### status 建議值
```text
queued
started
succeeded
failed
rejected
expired
cancelled
```

---

## 七、Server → Player Command API

## 7.1 Pending Commands API

### 用途
Player 主動拉取待執行命令。

### Method
```http
GET /api/v1/commands/pending
```

### Headers
```http
X-Device-Id: tw-site-a-player-01
X-Device-Token: <secret>
```

### Query Parameters
```text
device_id=tw-site-a-player-01
limit=10
```

### Success Response
```json
{
  "protocol_version": "1.0",
  "success": true,
  "timestamp": "2026-03-25T08:30:15Z",
  "data": {
    "commands": [
      {
        "command_id": "cmd_20260325_000001",
        "issued_at": "2026-03-25T08:29:55Z",
        "expires_at": "2026-03-25T08:34:55Z",
        "requested_by": "operator_admin",
        "reason": "Player process stopped unexpectedly.",
        "action": "restart_player_process",
        "payload": {
          "process_name": "openclaw-player"
        }
      }
    ]
  }
}
```

### 無命令時回應
```json
{
  "protocol_version": "1.0",
  "success": true,
  "timestamp": "2026-03-25T08:30:15Z",
  "data": {
    "commands": []
  }
}
```

---

## 八、Command Action 白名單

v1 只允許以下 action。

## 8.1 restart_player_process

### 用途
重啟指定播控程序。

### payload
```json
{
  "process_name": "openclaw-player"
}
```

### Agent 行為
- 驗證 process_name 是否在白名單
- 停止舊程序
- 啟動新程序
- 驗證程序成功啟動
- 回報 command_result

---

## 8.2 restart_agent

### 用途
重啟本機 agent。

### payload
```json
{
  "delay_sec": 3
}
```

### Agent 行為
- 記錄 command log
- 安全結束目前 agent
- 由 Scheduled Task / Service 自動恢復

---

## 8.3 collect_logs

### 用途
收集指定時間範圍 log 並打包。

### payload
```json
{
  "since_minutes": 60,
  "include": ["agent", "player", "system"]
}
```

### Agent 行為
- 收集本機 logs
- 產生 zip
- 回報產物路徑或上傳結果

---

## 8.4 rotate_log

### 用途
立即執行 log rotation。

### payload
```json
{
  "target": "agent"
}
```

---

## 8.5 reload_config

### 用途
重新載入本機設定檔。

### payload
```json
{
  "expected_config_version": "1.0.3"
}
```

### Agent 行為
- 驗證 config 檔存在
- 驗證格式合法
- 套用新設定
- 回報成功或失敗

---

## 8.6 reboot_host

### 用途
重開機。

### payload
```json
{
  "delay_sec": 10,
  "force": false
}
```

### 額外要求
此 action 必須有額外保護，建議至少符合以下其中之一：

- 僅 admin 角色可下
- 必須帶 maintenance window
- 必須在 reason 欄位清楚說明
- 必須記錄高優先級 audit log

---

## 九、明確禁止的 Action

以下 action 在 v1 明確禁止：

```text
exec_ps
exec_cmd
eval_js
download_and_run
update_collector
run_base64_script
```

### 理由
這些都會導致本機執行權限邊界失控，不適合場域端 production 系統。

---

## 十、Command 執行狀態機

每個 command 應遵循以下狀態流：

```text
queued -> started -> succeeded
queued -> started -> failed
queued -> rejected
queued -> expired
queued -> cancelled
```

### 說明

- `queued`：Server 已建立，等待 Player 拉取
- `started`：Player 已開始執行
- `succeeded`：執行成功
- `failed`：執行失敗
- `rejected`：Player 拒絕執行，例如 action 不合法
- `expired`：超過 expires_at
- `cancelled`：Server 主動取消

---

## 十一、Player Agent 執行規則

## 11.1 Command 驗證流程

Player 收到 command 後，必須依序驗證：

1. protocol_version 是否支援
2. device_id 是否匹配自己
3. command_id 是否未重複執行
4. expires_at 是否未過期
5. action 是否在白名單
6. payload 是否符合該 action schema
7. 本機當前狀態是否允許執行

任一失敗即應回報：

- rejected
或
- expired

## 11.2 冪等性要求

若同一 `command_id` 已成功執行過，Player 應避免重複執行。  
應以本機 command history 做去重。

---

## 十二、建議輪詢頻率

v1 建議如下：

### heartbeat
```text
每 10~15 秒一次
```

### commands/pending
```text
每 3~5 秒一次
```

### metrics
```text
每 30~60 秒一次
```

### events
```text
事件發生即送，必要時可批次
```

---

## 十三、離線與重試策略

## 13.1 Server 暫時不可達

Player 應：

- 繼續本地播控
- 繼續本地 health check
- 將 heartbeat / events / metrics 暫存佇列
- 在恢復連線後重送

## 13.2 重試策略

建議使用 exponential backoff：

```text
3s -> 5s -> 10s -> 20s -> 30s 上限
```

### 禁止
- 固定高頻無限重送
- 因傳送失敗立即重啟播控程序
- 因 command poll 失敗進入重啟風暴

---

## 十四、錯誤碼規格

## 14.1 通用錯誤碼

```text
INVALID_REQUEST
INVALID_PROTOCOL_VERSION
INVALID_DEVICE_ID
INVALID_DEVICE_TOKEN
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
RATE_LIMITED
INTERNAL_ERROR
```

## 14.2 Command 相關錯誤碼

```text
COMMAND_EXPIRED
COMMAND_ALREADY_EXECUTED
COMMAND_REJECTED
INVALID_COMMAND_ACTION
INVALID_COMMAND_PAYLOAD
PROCESS_NOT_ALLOWED
PROCESS_RESTART_FAILED
CONFIG_RELOAD_FAILED
REBOOT_NOT_ALLOWED
```

## 14.3 回應範例

```json
{
  "protocol_version": "1.0",
  "success": false,
  "timestamp": "2026-03-25T08:30:15Z",
  "error": {
    "code": "INVALID_COMMAND_ACTION",
    "message": "Action exec_ps is not allowed."
  }
}
```

---

## 十五、資料模型建議

## 15.1 Device Registry

```json
{
  "device_id": "tw-site-a-player-01",
  "device_name": "Player-A01",
  "zone": "MainWall",
  "role": "Playback",
  "agent_version": "1.0.0",
  "last_seen_at": "2026-03-25T08:30:15Z",
  "status": "healthy"
}
```

## 15.2 Command Record

```json
{
  "command_id": "cmd_20260325_000001",
  "device_id": "tw-site-a-player-01",
  "action": "restart_player_process",
  "payload": {
    "process_name": "openclaw-player"
  },
  "requested_by": "operator_admin",
  "reason": "Player process stopped unexpectedly.",
  "issued_at": "2026-03-25T08:29:55Z",
  "expires_at": "2026-03-25T08:34:55Z",
  "status": "queued"
}
```

## 15.3 Command Result Record

```json
{
  "command_id": "cmd_20260325_000001",
  "device_id": "tw-site-a-player-01",
  "status": "succeeded",
  "message": "Player process restarted successfully.",
  "started_at": "2026-03-25T08:29:58Z",
  "finished_at": "2026-03-25T08:30:05Z",
  "exit_code": 0
}
```

---

## 十六、建議目錄與設定檔

## 16.1 Windows Player

```text
C:\Program Files\OpenClawPlayerAgent\
C:\ProgramData\OpenClawPlayerAgent\config\agent.json
C:\ProgramData\OpenClawPlayerAgent\logs\
C:\ProgramData\OpenClawPlayerAgent\runtime\
```

## 16.2 agent.json 建議欄位

```json
{
  "protocol_version": "1.0",
  "device_id": "tw-site-a-player-01",
  "device_name": "Player-A01",
  "server_base_url": "https://control-server.local",
  "heartbeat_interval_sec": 15,
  "command_poll_interval_sec": 5,
  "metrics_interval_sec": 60,
  "allowed_processes": ["openclaw-player", "mpv", "custom-player"],
  "log_retention_days": 14
}
```

---

## 十七、審計要求

以下操作必須寫入 audit log：

- 建立 command
- Player 拉取 command
- command 開始執行
- command 成功 / 失敗 / 拒絕
- reboot_host
- restart_agent
- reload_config
- token 驗證失敗
- 非白名單 action 嘗試

### audit log 至少包含
- timestamp
- device_id
- command_id（若有）
- actor
- action
- result
- reason
- source_ip

---

## 十八、v1 實作邊界

v1 建議先做以下範圍：

### 必做
- heartbeat
- metrics
- events
- pending commands
- command result
- 6 個白名單 action
- token 驗證
- expires_at 驗證
- command 去重
- audit log

### 暫不做
- 任意 shell
- 複雜自更新
- 雙向 websocket 常駐通道
- mTLS
- 分散式 message broker
- 高自由度遠端除錯

---

## 十九、驗收標準

### API 驗收
- heartbeat 可正常寫入 Server
- metrics 可正常保存
- events 可正常查詢
- Player 可成功拉取 commands
- command-result 可正確更新狀態

### Protocol 驗收
- expired command 會被拒絕
- 重複 command_id 不會重複執行
- 非白名單 action 會被拒絕
- payload 不合規時會回傳固定錯誤碼

### 安全驗收
- 不存在 exec_ps 類型 action
- token 不以明文出現在公開腳本
- 所有高風險 action 有 audit log
- reboot_host 有額外保護與記錄

---

## 二十、結論

OpenClaw 場域端 v1 的 API 與 Command Protocol 應以：

```text
固定 JSON Schema
+ Player 主動拉取命令
+ Server 集中管理
+ 白名單 Action
+ 明確審計與錯誤碼
```

作為核心原則。

這樣的設計能同時滿足：

- 場域端穩定性
- 監控可用性
- 維運可追蹤性
- 安全邊界控制
- 後續擴充能力

適合作為 1 Linux Server + 4 Windows Player 的第一版正式通訊規格。
