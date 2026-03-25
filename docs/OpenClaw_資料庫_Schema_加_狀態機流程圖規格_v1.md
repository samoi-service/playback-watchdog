# OpenClaw 資料庫 Schema + 狀態機流程圖規格 v1.0

## 一、文件目的

本文件定義 OpenClaw 場域端監控控制系統的：

- Linux Central Control Server 資料庫 Schema
- Device / Command / Event / Metrics / Audit 資料模型
- Player Agent 與 Command 的狀態機
- 主要流程圖規格
- v1 實作邊界與索引建議

適用架構：

- 1 台 Linux Server
- 4 台 Windows Player
- Windows Player 以本機 Agent 常駐
- Linux Server 作為中央控制與監控節點

本文件目標是讓後續 Claude / 工程人員可直接依照資料結構與狀態流實作，不再自行猜測資料表與流程。

---

## 二、設計原則

### 2.1 核心原則

1. 資料模型必須支援集中監控
2. 所有 command 與高風險操作必須可追蹤
3. 每台 device 應可獨立判斷當前狀態
4. metrics 與 events 分流儲存
5. schema 先以 v1 實用為主，避免過度抽象
6. command 執行必須有明確狀態機
7. Player 離線時，Server 仍需保留最後有效狀態

### 2.2 建議資料庫

v1 建議優先使用：

```text
PostgreSQL
```

若是初期快速驗證也可使用：

```text
SQLite
```

但正式場域仍建議 PostgreSQL，因為後續會更適合：

- 多表查詢
- 狀態彙整
- 審計紀錄
- 索引
- 時間序列查詢
- dashboard 查詢

---

## 三、資料表總覽

v1 建議至少包含以下資料表：

```text
devices
device_heartbeats
device_metrics
device_events
commands
command_results
audit_logs
config_versions
device_config_assignments
```

### 表用途摘要

- `devices`：裝置主檔
- `device_heartbeats`：心跳摘要
- `device_metrics`：效能/資源指標
- `device_events`：事件與異常
- `commands`：待執行與歷史命令
- `command_results`：命令執行結果
- `audit_logs`：稽核紀錄
- `config_versions`：設定版本資料
- `device_config_assignments`：裝置配置指派狀態

---

## 四、資料庫 Schema

## 4.1 devices

### 用途
儲存每台 Windows Player 的主檔資料與最新狀態。

### 建議欄位

```sql
CREATE TABLE devices (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(128) NOT NULL UNIQUE,
    device_name VARCHAR(128) NOT NULL,
    zone VARCHAR(128),
    role VARCHAR(64),
    hostname VARCHAR(128),
    ip_address VARCHAR(64),
    os_name VARCHAR(128),
    agent_version VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'unknown',
    last_seen_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    last_metrics_at TIMESTAMPTZ,
    last_event_at TIMESTAMPTZ,
    last_command_poll_at TIMESTAMPTZ,
    last_command_result_at TIMESTAMPTZ,
    restart_count_24h INT NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### status 建議值

```text
unknown
healthy
warning
degraded
critical
offline
disabled
```

### 索引建議

```sql
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_last_seen_at ON devices(last_seen_at DESC);
```

---

## 4.2 device_heartbeats

### 用途
保存每次 heartbeat 摘要，供歷史追蹤與故障分析。

### 建議欄位

```sql
CREATE TABLE device_heartbeats (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(128) NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    overall_status VARCHAR(32) NOT NULL,
    uptime_sec BIGINT,
    cpu_percent NUMERIC(5,2),
    ram_percent NUMERIC(5,2),
    disk_percent NUMERIC(5,2),
    gpu_percent NUMERIC(5,2),
    player_process_name VARCHAR(128),
    player_process_running BOOLEAN,
    player_process_pid INT,
    player_process_uptime_sec BIGINT,
    player_restart_count_24h INT,
    server_reachable BOOLEAN,
    last_successful_command_poll_at TIMESTAMPTZ,
    raw_payload JSONB
);
```

### 索引建議

```sql
CREATE INDEX idx_device_heartbeats_device_id_sent_at
ON device_heartbeats(device_id, sent_at DESC);
```

---

## 4.3 device_metrics

### 用途
保存較完整的 metrics 快照。

### 建議欄位

```sql
CREATE TABLE device_metrics (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(128) NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_percent NUMERIC(5,2),
    ram_used_mb INT,
    ram_total_mb INT,
    disk_used_gb INT,
    disk_total_gb INT,
    gpu_percent NUMERIC(5,2),
    gpu_memory_used_mb INT,
    gpu_memory_total_mb INT,
    network_tx_kbps INT,
    network_rx_kbps INT,
    display_resolution VARCHAR(64),
    display_refresh_rate_hz INT,
    display_fullscreen BOOLEAN,
    raw_payload JSONB
);
```

### 索引建議

```sql
CREATE INDEX idx_device_metrics_device_id_sent_at
ON device_metrics(device_id, sent_at DESC);
```

---

## 4.4 device_events

### 用途
保存 Player 主動回報的事件與異常。

### 建議欄位

```sql
CREATE TABLE device_events (
    id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL UNIQUE,
    device_id VARCHAR(128) NOT NULL,
    level VARCHAR(32) NOT NULL,
    category VARCHAR(64) NOT NULL,
    code VARCHAR(128) NOT NULL,
    message TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details JSONB,
    raw_payload JSONB
);
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

### 索引建議

```sql
CREATE INDEX idx_device_events_device_id_occurred_at
ON device_events(device_id, occurred_at DESC);

CREATE INDEX idx_device_events_level_occurred_at
ON device_events(level, occurred_at DESC);

CREATE INDEX idx_device_events_code
ON device_events(code);
```

---

## 4.5 commands

### 用途
保存中央下發給各裝置的命令主檔。

### 建議欄位

```sql
CREATE TABLE commands (
    id BIGSERIAL PRIMARY KEY,
    command_id VARCHAR(128) NOT NULL UNIQUE,
    device_id VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by VARCHAR(128) NOT NULL,
    reason TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    last_error_code VARCHAR(128),
    last_error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### status 建議值

```text
queued
delivered
started
succeeded
failed
rejected
expired
cancelled
```

### 索引建議

```sql
CREATE INDEX idx_commands_device_id_status
ON commands(device_id, status);

CREATE INDEX idx_commands_device_id_issued_at
ON commands(device_id, issued_at DESC);

CREATE INDEX idx_commands_status_expires_at
ON commands(status, expires_at);
```

---

## 4.6 command_results

### 用途
保存 Player 回報的命令執行結果細節。

### 建議欄位

```sql
CREATE TABLE command_results (
    id BIGSERIAL PRIMARY KEY,
    command_id VARCHAR(128) NOT NULL,
    device_id VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    exit_code INT,
    message TEXT,
    details JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB
);
```

### 索引建議

```sql
CREATE INDEX idx_command_results_command_id
ON command_results(command_id);

CREATE INDEX idx_command_results_device_id_received_at
ON command_results(device_id, received_at DESC);
```

### 設計補充
`commands` 保留主狀態，`command_results` 保留 Player 實際回報內容。  
若未來一個 command 需要多段回報，也可保留擴充空間。

---

## 4.7 audit_logs

### 用途
保存高風險操作與重要系統動作的稽核紀錄。

### 建議欄位

```sql
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    audit_id VARCHAR(128) NOT NULL UNIQUE,
    actor_type VARCHAR(64) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    device_id VARCHAR(128),
    command_id VARCHAR(128),
    action VARCHAR(128) NOT NULL,
    result VARCHAR(64) NOT NULL,
    reason TEXT,
    source_ip VARCHAR(64),
    metadata JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### actor_type 建議值

```text
system
operator
device
scheduler
api
```

### result 建議值

```text
accepted
rejected
succeeded
failed
expired
cancelled
```

### 索引建議

```sql
CREATE INDEX idx_audit_logs_device_id_occurred_at
ON audit_logs(device_id, occurred_at DESC);

CREATE INDEX idx_audit_logs_command_id
ON audit_logs(command_id);

CREATE INDEX idx_audit_logs_actor_id_occurred_at
ON audit_logs(actor_id, occurred_at DESC);
```

---

## 4.8 config_versions

### 用途
保存可用的設定版本資訊。

### 建議欄位

```sql
CREATE TABLE config_versions (
    id BIGSERIAL PRIMARY KEY,
    config_version VARCHAR(64) NOT NULL UNIQUE,
    config_name VARCHAR(128) NOT NULL,
    config_body JSONB NOT NULL,
    checksum VARCHAR(128),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 4.9 device_config_assignments

### 用途
保存每台裝置被指派的設定版本與套用狀態。

### 建議欄位

```sql
CREATE TABLE device_config_assignments (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(128) NOT NULL,
    config_version VARCHAR(64) NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by VARCHAR(128) NOT NULL,
    apply_status VARCHAR(32) NOT NULL DEFAULT 'pending',
    applied_at TIMESTAMPTZ,
    last_error_code VARCHAR(128),
    last_error_message TEXT
);
```

### apply_status 建議值

```text
pending
applied
failed
rolled_back
```

---

## 五、表關聯建議

### 關聯邏輯

```text
devices.device_id
  ├── device_heartbeats.device_id
  ├── device_metrics.device_id
  ├── device_events.device_id
  ├── commands.device_id
  ├── command_results.device_id
  ├── audit_logs.device_id
  └── device_config_assignments.device_id

commands.command_id
  ├── command_results.command_id
  └── audit_logs.command_id
```

### 補充
v1 可先不強制建立全部外鍵，避免過早被匯入順序與歷史資料卡住。  
但正式版建議至少在應用層保證關聯完整性。

---

## 六、狀態彙整規則

## 6.1 devices.status 更新原則

`devices.status` 不應手動隨意寫死，而應由 Server 根據最近 heartbeat / events 推算。

### 建議規則

#### healthy
- 最近 heartbeat 在閾值內
- 無 critical event
- player_process_running = true

#### warning
- heartbeat 正常
- 但 CPU / RAM / Disk / GPU 有接近閾值
或
- 最近有 warning event

#### degraded
- heartbeat 正常
- 但 player process 最近頻繁重啟
或
- command 連續失敗

#### critical
- 最近有 critical event
或
- player process 未運行
或
- 本機修復失敗

#### offline
- heartbeat 超過離線閾值未更新

### 建議閾值

```text
heartbeat > 45 秒未更新 => offline
restart_count_24h >= 3 => degraded
critical event within 5 分鐘 => critical
```

---

## 七、Command 狀態機規格

## 7.1 Command 狀態列表

```text
queued
delivered
started
succeeded
failed
rejected
expired
cancelled
```

## 7.2 狀態意義

- `queued`：Server 已建立，尚未被 Player 拉取
- `delivered`：Player 已拉取到該 command
- `started`：Player 已開始執行
- `succeeded`：執行成功
- `failed`：執行失敗
- `rejected`：Player 拒絕執行
- `expired`：超過有效時間
- `cancelled`：Server 取消

## 7.3 Command 狀態流

```text
queued -> delivered -> started -> succeeded
queued -> delivered -> started -> failed
queued -> delivered -> rejected
queued -> expired
queued -> cancelled
delivered -> expired
delivered -> cancelled
```

### 注意
v1 不建議出現從 `succeeded` 再回退到其他狀態。  
Command 最終狀態應為不可逆。

---

## 八、Player Agent 狀態機規格

## 8.1 Player Agent 高層狀態

```text
booting
idle
healthy
warning
degraded
repairing
offline_buffering
```

## 8.2 狀態意義

- `booting`：Agent 啟動中
- `idle`：已啟動，尚未完成首次狀態同步
- `healthy`：運作正常
- `warning`：可運作，但有資源或事件警告
- `degraded`：核心功能仍可用，但有明顯異常
- `repairing`：正在執行本機修復
- `offline_buffering`：Server 不可達，正在本地暫存資料

## 8.3 Player Agent 狀態流

```text
booting -> idle -> healthy
healthy -> warning
warning -> healthy
warning -> degraded
degraded -> repairing
repairing -> healthy
repairing -> degraded
healthy -> offline_buffering
warning -> offline_buffering
degraded -> offline_buffering
offline_buffering -> healthy
```

---

## 九、流程圖規格

以下流程圖以文字圖描述，供 Claude / 工程人員直接轉換成 Mermaid、PlantUML 或正式圖表。

## 9.1 Device 註冊 / 啟動流程

```text
[Player Agent 啟動]
    ↓
[讀取本機 config]
    ↓
[驗證 device_id / token / server_url]
    ↓
[建立本機 runtime 狀態]
    ↓
[送出首次 heartbeat]
    ↓
[Server 建立或更新 devices 主檔]
    ↓
[Player 進入 idle]
    ↓
[首次 command poll 成功]
    ↓
[Player 進入 healthy]
```

---

## 9.2 Heartbeat 流程

```text
[排程 heartbeat 觸發]
    ↓
[收集 host / process / transport 狀態]
    ↓
[組成 heartbeat payload]
    ↓
[POST /api/v1/heartbeat]
    ↓
{成功?}
 ├─ 是 → [寫入 device_heartbeats]
 │        ↓
 │      [更新 devices.last_seen_at / status]
 │        ↓
 │      [回傳 next_heartbeat_sec]
 │
 └─ 否 → [本地記錄失敗]
          ↓
        [依 backoff 策略重試]
```

---

## 9.3 Command Poll 流程

```text
[排程 command poll 觸發]
    ↓
[GET /api/v1/commands/pending]
    ↓
{有 commands?}
 ├─ 否 → [更新 devices.last_command_poll_at]
 │        ↓
 │      [等待下一輪]
 │
 └─ 是 → [逐筆驗證 command]
          ↓
        {驗證通過?}
         ├─ 否 → [回報 rejected / expired]
         │
         └─ 是 → [commands.status = delivered]
                   ↓
                 [開始執行]
                   ↓
                 [commands.status = started]
                   ↓
                 [執行 action handler]
                   ↓
                 {成功?}
                  ├─ 是 → [回報 succeeded]
                  └─ 否 → [回報 failed]
```

---

## 9.4 本機修復流程

```text
[Health Check 失敗]
    ↓
[判斷是否屬於可自修範圍]
    ↓
{可自修?}
 ├─ 否 → [產生 critical event]
 │        ↓
 │      [回報 server]
 │
 └─ 是 → [Agent 進入 repairing]
          ↓
        [停止舊程序]
          ↓
        [清理 lock / temp]
          ↓
        [重啟目標程序]
          ↓
        [驗證 localhost health / process running]
          ↓
        {成功?}
         ├─ 是 → [產生 repair success event]
         │        ↓
         │      [回到 healthy]
         │
         └─ 否 → [產生 repair failed event]
                  ↓
                [回到 degraded 或 critical]
```

---

## 9.5 Server 判定離線流程

```text
[排程 offline checker]
    ↓
[掃描 devices.last_heartbeat_at]
    ↓
{現在時間 - last_heartbeat_at > 45 秒?}
 ├─ 否 → [保持現狀]
 └─ 是 → [devices.status = offline]
          ↓
        [寫入 audit / event]
          ↓
        [必要時觸發 alert]
```

---

## 9.6 Command 建立與稽核流程

```text
[Operator / Scheduler 發起 command]
    ↓
[Server 驗證 action 是否白名單]
    ↓
[建立 commands 記錄，status = queued]
    ↓
[寫入 audit_logs: accepted]
    ↓
[Player poll 到 command]
    ↓
[Player 執行並回報 command-result]
    ↓
[Server 更新 commands 狀態]
    ↓
[寫入 audit_logs: succeeded / failed / rejected / expired]
```

---

## 十、建議查詢場景

## 10.1 Dashboard 列表

### 需求
顯示全部 Player：

- device_name
- zone
- status
- last_seen_at
- agent_version
- restart_count_24h

### 主要來源
- `devices`

---

## 10.2 單台 Player 詳細頁

### 需求
顯示：

- 最近 heartbeat
- 最近 metrics
- 最近 events
- 最近 commands
- 最近 audit logs

### 主要來源
- `devices`
- `device_heartbeats`
- `device_metrics`
- `device_events`
- `commands`
- `audit_logs`

---

## 10.3 異常追查

### 需求
查某台 Player 過去 24 小時的：

- critical event
- repair event
- failed commands

### 主要來源
- `device_events`
- `commands`
- `command_results`
- `audit_logs`

---

## 十一、保留與清理策略

## 11.1 建議保留期間

### devices
- 長期保留

### device_heartbeats
- 30~90 天

### device_metrics
- 30~60 天
- 之後可做彙整降採樣

### device_events
- 90~180 天

### commands / command_results
- 至少 180 天

### audit_logs
- 至少 180 天，正式環境可更久

## 11.2 清理策略
建議每日夜間排程做：

- heartbeat 舊資料清理
- metrics 舊資料清理
- 大型 JSON payload 壓縮或刪除
- 索引維護

---

## 十二、v1 不建議先做的 Schema 複雜化

為了先穩定落地，v1 不建議一開始就做：

- 複雜多租戶
- 跨場域權限模型
- 分片 metrics 儲存
- event sourcing 全量重建架構
- message broker 狀態表
- 過度細碎的 process 子表

v1 先把：

- device
- heartbeat
- metrics
- events
- commands
- audit

這幾個核心表做穩即可。

---

## 十三、建議 Migration 順序

```text
001_create_devices.sql
002_create_device_heartbeats.sql
003_create_device_metrics.sql
004_create_device_events.sql
005_create_commands.sql
006_create_command_results.sql
007_create_audit_logs.sql
008_create_config_versions.sql
009_create_device_config_assignments.sql
010_add_indexes.sql
```

---

## 十四、驗收標準

### Schema 驗收
- 可成功建立全部核心資料表
- device_id / command_id / event_id 唯一性有效
- 常用查詢有對應索引
- 可正確保存 JSON payload

### 狀態機驗收
- queued command 可正確流轉到 succeeded / failed / rejected / expired
- Player 狀態可正確進入 repairing / offline_buffering
- offline checker 可正確標記 offline

### 查詢驗收
- Dashboard 查詢在 4 台 Player 情境下應快速回應
- 單台 Player 詳細頁可完整拉出最近狀態
- 24 小時異常追查可正確交叉對照 event / command / audit

---

## 十五、結論

OpenClaw 場域端 v1 的資料層與狀態機應以：

```text
清楚的核心表
+ 明確的 command 狀態流
+ 可追蹤的 audit 記錄
+ Player / Server 各自可判斷狀態
+ 簡單但可擴充的 schema
```

作為基礎。

這樣的設計適合：

- 1 台 Linux Server
- 4 台 Windows Player
- 場域端中央監控 + 邊緣自治架構

並能讓後續 Claude / 工程人員直接依照同一份資料與流程規格實作 server 與 agent。
