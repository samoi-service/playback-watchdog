# 1 Linux Server + 4 Windows Player 監控控制架構 v1.0

## 一、架構目標

本文件定義一套適用於場域端的監控與控制架構，部署場景如下：

- 1 台 Linux Server
- 4 台 Windows Player
- Windows Player 負責實際播控、渲染、播放、互動執行
- Linux Server 負責中央監控、狀態彙整、告警、命令下發

本架構的核心目標如下：

- 保證每台 Windows Player 可本地自治
- 保證 Linux Server 可集中掌握全場域狀態
- 即使 Linux Server 暫時離線，Windows Player 仍可持續運作
- 建立可控、可審計、可擴充的場域端監控基礎
- 避免把遠端任意執行權限直接暴露到 Player 主機

---

## 二、總體設計原則

本架構採用：

```text
Central Control Plane + Edge Agent
```

也就是：

- Linux Server = 中央控制平面
- Windows Player = 邊緣自治節點

### 核心原則

1. 中央看全局
2. 邊緣顧本機
3. 控制與執行分離
4. 命令必須白名單
5. 網路中斷時不可影響本機基本播控
6. 所有重要操作必須留下 log 與 audit 記錄

---

## 三、整體架構圖

```text
                        ┌──────────────────────────────┐
                        │         Linux Server         │
                        │  Central Monitoring Server   │
                        │                              │
                        │  - Device Registry           │
                        │  - Heartbeat API             │
                        │  - Command Dispatcher        │
                        │  - Alert Engine              │
                        │  - Dashboard / Web UI        │
                        │  - Log / Metrics Storage     │
                        └──────────────┬───────────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
                │                      │                      │
      ┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐
      │ Windows Player 01 │  │ Windows Player 02 │  │ Windows Player 03 │
      │                   │  │                   │  │                   │
      │  Local Agent      │  │  Local Agent      │  │  Local Agent      │
      │  Process Watcher  │  │  Process Watcher  │  │  Process Watcher  │
      │  Metrics Reporter │  │  Metrics Reporter │  │  Metrics Reporter │
      │  Command Runner   │  │  Command Runner   │  │  Command Runner   │
      │  Local Repair     │  │  Local Repair     │  │  Local Repair     │
      └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
                │                      │                      │
                └──────────────────────┼──────────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │ Windows Player 04   │
                            │                     │
                            │  Local Agent        │
                            │  Process Watcher    │
                            │  Metrics Reporter   │
                            │  Command Runner     │
                            │  Local Repair       │
                            └─────────────────────┘
```

---

## 四、角色與責任分工

## 4.1 Linux Server 的責任

Linux Server 是中央監控與控制中心，應承擔以下功能：

### 1. Device Registry
管理所有 Windows Player 的裝置資料：

- device_id
- device_name
- room / zone / screen mapping
- IP / hostname
- software version
- last heartbeat time
- current status
- last command result

### 2. Heartbeat API
接收各 Player 的定時心跳與狀態上報：

- 在線 / 離線
- CPU / RAM / Disk / GPU 狀態
- 播控程序狀態
- restart 次數
- health summary

### 3. Command Dispatcher
對指定 Player 下發白名單命令：

- restart_player_process
- restart_agent
- collect_logs
- rotate_log
- reboot_host
- reload_config

### 4. Alert Engine
集中處理告警條件，例如：

- 心跳逾時
- 連續 crash
- 程式未執行
- 本機磁碟不足
- GPU 異常
- 某 Player 長期高負載
- 指令執行失敗

### 5. Dashboard / Web UI
提供維運人員查看全場域狀態：

- 4 台 Player 是否在線
- 各機 CPU / RAM / GPU
- 播控程序狀態
- 最後重啟時間
- 最近警報
- 最近命令結果

### 6. Log / Metrics Storage
集中儲存：

- heartbeat logs
- command logs
- device event logs
- alert history
- metrics snapshots

---

## 4.2 Windows Player 的責任

每台 Windows Player 必須部署本機 agent，負責本機自治與狀態回報。

### 1. Local Agent
本機常駐程式，負責：

- 與 Linux Server 通訊
- 接收命令
- 回報狀態
- 保留最小自治能力

### 2. Process Watcher
監控本機指定程序，例如：

- OpenClaw node
- mpv
- Unreal
- OBS
- 自製播控程式
- 其他現場播放 / 控制程序

### 3. Metrics Reporter
回報本機資訊：

- CPU
- RAM
- Disk
- GPU
- Process uptime
- restart count
- 顯示輸出狀態
- 最近 heartbeat

### 4. Command Runner
執行 Linux Server 下發的白名單命令：

- restart_player_process
- restart_agent
- collect_logs
- reboot_host（需額外保護）
- reload_config

### 5. Local Repair
當本機檢測到異常時，先做最小範圍自修：

- 重啟播控程式
- 清除 lock file
- 重建 worker process
- 回報錯誤碼與狀態

---

## 五、為什麼不能只放 Linux Server

若只在 Linux Server 放中央監控，而不在 Windows Player 放本機 agent，會有下列問題：

### Linux Server 可看到的通常只有：
- ping 是否通
- 某個 port 是否存在
- 某個 API 是否有回應

### 但 Linux Server 看不到或看不準的通常包括：
- 程式是否假活著但已卡死
- 本機播控視窗是否消失
- GPU driver 是否異常
- 指定程序是否無回應
- 顯示輸出是否處於錯誤模式
- 本機資源是否已接近崩潰
- 是否有人手動關閉播控程式

因此，Linux Server 必須搭配 Windows 本機 agent，才能真正形成可用的場域監控體系。

---

## 六、為什麼也不能只做 Windows 本機腳本

若每台 Windows Player 都只做自己的本機 watcher，而不建立中央控制層，則會有以下問題：

- 無法集中查看 4 台 Player 狀態
- 難以統一管理告警
- 難以跨機器下達指令
- 難以集中保存 logs
- 難以做版本控管
- 難以建立真正的場域 dashboard

因此，Windows 本機 agent 只能解決「顧自己」，無法解決「看全場」。

---

## 七、推薦架構：中央控制 + 邊緣自治

正式建議如下：

### Linux Server 負責：
- 看全局
- 統一管理
- 統一告警
- 統一下達命令
- 提供 dashboard
- 保存歷史資料

### Windows Player 負責：
- 顧本機
- 本機 health check
- 本機 repair
- 狀態上報
- 接收與執行有限命令

這個模型最符合你的場域需求。

---

## 八、通訊模式建議

## 8.1 建議模式

Windows Player 主動向 Linux Server 發送：

- heartbeat
- metrics
- event logs
- command result

Linux Server 則提供：

- command queue / pull API
或
- command dispatch API

### 建議優先使用：
```text
Player 主動 pull command
```

原因：

- 較容易穿透不同網段
- 較容易做安全限制
- Linux Server 不必直接主動打進每台 Windows
- 比較適合場域端設備管理

---

## 8.2 建議 API 類型

### Player → Server
- POST /heartbeat
- POST /metrics
- POST /events
- POST /command-result

### Player ← Server
- GET /commands/pending?device_id=...
- GET /config/current?device_id=...
- GET /alerts/ack-required?device_id=...

---

## 九、命令模型

## 9.1 允許命令白名單

Windows Player 端 agent 只應接受固定命令，例如：

```text
restart_player_process
restart_agent
collect_logs
rotate_log
reload_config
reboot_host
```

## 9.2 不允許

```text
exec_ps
任意 powershell
任意 cmd
任意 base64 script payload
任意下載後執行
```

### 理由
場域端 Player 通常連接播控、畫面輸出、商業空間設備，若允許任意腳本遠端執行，風險過高。

---

## 十、健康檢查分層

每台 Windows Player 應採三層健康檢查。

## Layer 1：Process Health
- 目標程序 PID 是否存在
- uptime 是否合理
- crash 次數是否異常

## Layer 2：Functional Health
- 本機 localhost health endpoint 是否正常
- 指定程序是否仍有回應
- 必要子程序是否存活

## Layer 3：Transport Health
- 與 Linux Server 的連線是否成功
- 最近一次 heartbeat 時間
- command pull 是否成功

### 注意
Transport Health 失敗，不應直接等於本機播放停止。  
也就是：

> Server 掛掉 ≠ Player 停播

---

## 十一、離線容錯原則

這一點非常重要。

### 當 Linux Server 中斷時，Windows Player 必須：
- 繼續播放
- 繼續做本機 watchdog
- 繼續本機程序重啟
- 暫存 logs / metrics
- 等恢復連線後再補送資料

### 不應該：
- 因 server 失聯就停止播控
- 因心跳失敗就進入無限重啟
- 因 command API 無法取得就視為重大故障

---

## 十二、推薦部署方式

## 12.1 Linux Server
建議部署：

- Node.js control server
- PostgreSQL / SQLite（視規模）
- Redis（若需要 command queue）
- Nginx / Caddy 作 reverse proxy
- Dashboard 前端（可選）

### Linux Server 主要模組
```text
control-server/
├── api/
├── device-registry/
├── command-dispatcher/
├── alert-engine/
├── storage/
├── dashboard/
└── logs/
```

---

## 12.2 Windows Player
建議部署：

- 本機 Node agent
- 安裝腳本（PowerShell）
- Scheduled Task 或 Windows Service

### Windows Player 主要模組
```text
player-agent/
├── launcher/
├── process-watcher/
├── command-runner/
├── metrics/
├── local-repair/
├── logger/
└── config/
```

---

## 十三、建議目錄結構

## Linux Server

```text
/opt/openclaw-control/
├── app/
├── config/
├── logs/
├── storage/
└── backups/
```

## Windows Player

```text
C:\Program Files\OpenClawPlayerAgent\
C:\ProgramData\OpenClawPlayerAgent\config\
C:\ProgramData\OpenClawPlayerAgent\logs\
C:\ProgramData\OpenClawPlayerAgent\runtime\
```

---

## 十四、身份識別建議

不要只靠電腦名稱識別 Player。

每台 Player 應有：

- device_id（唯一）
- device_name（可讀）
- zone / room / screen role
- registration token 或 device secret

### 範例
```text
device_id: tw-site-a-player-01
device_name: Player-A01
zone: MainWall
role: Playback
```

---

## 十五、最低安全要求

### 必要項目
- 命令白名單
- HTTPS / TLS
- token 不明文硬寫在腳本
- 所有 command result 有 log
- reboot / restart 有審計紀錄
- 非法 command 必須拒絕
- Linux Server 不可直接執行 Windows 任意腳本

### 建議項目
- command 帶 expiry time
- command 帶 nonce
- device registration
- 配置版本號
- log rotation
- crash dump 採集
- 重要動作寫入 event log

---

## 十六、v1 建議技術選型

## Linux Server
建議：
- Node.js / TypeScript
- Express / Fastify
- SQLite 或 PostgreSQL
- Redis（可選）
- Web dashboard（可選）

## Windows Player
建議：
- Node.js / TypeScript agent
- PowerShell 只做 install / repair
- Scheduled Task 先上線
- 後續可升級 Windows Service

---

## 十七、v1 不建議先做的項目

為了先穩定落地，v1 不建議一開始就做太多：

- 不做任意 script 遠端執行
- 不做高自由度 remote shell
- 不做複雜自更新
- 不做過度依賴 server 的控制模式
- 不做太多跨機協調邏輯

### v1 的重點
先把以下事情做穩：

- 本機 agent 穩定
- server 能看到所有 player
- 告警可用
- restart 邏輯穩定
- log 可回收
- 命令白名單清楚

---

## 十八、驗收標準

### 基本驗收
- 4 台 Windows Player 都能成功註冊到 Linux Server
- 每台 Player 都能固定回報 heartbeat
- Linux Server 可看到所有 Player 狀態
- 可對單台 Player 下達 restart_player_process
- Player 可執行本機 repair
- Linux Server 中斷時，Player 仍持續運作

### 安全驗收
- 非白名單命令會被拒絕
- token 不可從一般腳本中直接讀出
- command result 有完整 log
- command history 可追蹤

### 壓力驗收
- 心跳暫停時不引發重啟風暴
- 播控程序異常退出時可自動恢復
- 多台 Player 同時上報不造成 server 異常

---

## 十九、最終建議

你的場域端架構不應該只做其中一邊，而應該明確分成兩層：

### Linux Server
作為：
- 中央監控中心
- 狀態中心
- 指令中心
- 告警中心
- 儀表板中心

### Windows Player
作為：
- 本機自治節點
- 本機監測節點
- 本機修復節點
- 指令執行節點

這樣的兩層式架構，才適合你現在的：

- 1 台 Linux Server
- 4 台 Windows Player
- 商業場域端播放與控制需求

---

## 二十、結論

最適合你的架構不是：

- 只在 Linux Server 放監控
也不是
- 只在 Windows Player 放本機腳本

而是：

```text
Linux Central Control Server + Windows Edge Agent
```

這種方式兼具：

- 集中管理能力
- 本地自治能力
- 安全性
- 可維運性
- 可擴充性

適合作為 OpenClaw 場域端監控控制系統的 v1 基礎架構。
