# OpenClaw 場域端 Agent 安全部署規格 v1.0

## 一、目標

本文件定義 OpenClaw 在商業場域（飯店、展館、LED 播控主機、沉浸式空間）中的正式部署標準，目標如下：

- 保證 Node / Agent 可在開機後自動恢復運作
- 發生異常時可自動檢測並有限度恢復
- 遠端僅能執行白名單操作
- 避免任意 PowerShell / Script 被遠端注入
- 保證 token、更新、監控資料不以明文暴露
- 在網路中斷時維持本地穩定，不產生重啟風暴
- 可供現場維運人員快速診斷

---

## 二、正式部署架構

```text
OpenClaw-Agent
├── Launcher
├── Health Monitor
├── Command Runner
├── Metrics Reporter
└── Updater
```

### 模組責任

### 1. Launcher
負責：

- 啟動 node.exe
- 建立 PID file
- crash restart
- backoff 控制（避免連續重啟）

### 2. Health Monitor
負責：

- Process health
- Gateway transport health
- Functional health

### 3. Command Runner
負責：

- 僅執行白名單 action
- 禁止任意 script

### 4. Metrics Reporter
負責：

- CPU
- RAM
- GPU
- Process status
- 最近 heartbeat

### 5. Updater
負責：

- 僅接受正式版本包
- hash 驗證
- signature 驗證
- rollback

---

## 三、禁止事項（Production 不允許）

### 禁止 exec_ps

不得接受：

```powershell
Invoke-Expression
```

不得接受 base64 script payload。

### 禁止遠端直接覆寫 collector

不得允許：

- server 下發任意腳本覆寫本機 agent

### 禁止 HTTP metrics

不得使用：

```text
http://
```

必須使用：

```text
https://
```

### 禁止 token 明文寫入 script

不得出現：

```powershell
$env:OPENCLAW_GATEWAY_TOKEN="..."
```

---

## 四、建議目錄結構

```text
C:\Program Files\OpenClaw\
C:\ProgramData\OpenClaw\config\
C:\ProgramData\OpenClaw\logs\
C:\ProgramData\OpenClaw\runtime\
```

### 說明

- Program Files：主程式
- ProgramData/config：設定檔
- ProgramData/logs：log
- runtime：pid / lock / temp

---

## 五、Token 安全存放

建議：

- Windows Credential Manager
或
- DPAPI 加密設定檔

### 不允許

```text
寫死在 ps1
寫死在 bat
寫死在 scheduled task command line
```

---

## 六、白名單命令（允許遠端）

允許：

```text
restart_node
restart_monitor
start_mpvserver
stop_mpvserver
collect_logs
rotate_log
reboot_host（需額外保護）
```

### 不允許

```text
任意 powershell
任意 cmd
任意下載執行
```

---

## 七、Health Check 三層模型

## Layer 1 Process

- PID 是否存在
- 啟動時間
- crash count

## Layer 2 Transport

- TLS 是否成功
- Gateway 最近成功連線時間

## Layer 3 Functional

- localhost health endpoint
- heartbeat response

---

## 八、Windows 啟動方式

建議：

### Scheduled Task + Service 雙保險

### Scheduled Task
開機啟動：

```text
At startup
```

### Service
若需要更高穩定性：

```text
Windows Service
```

---

## 九、Log 要求

log 必須包含：

- 啟動時間
- command id
- action
- result
- crash reason
- restart count

### log rotation

建議：

- 每日一檔
- 保留 14 天

---

## 十、更新機制

### 僅接受：

```text
正式版本號 + HTTPS package
```

### 更新流程

1. download
2. hash verify
3. signature verify
4. replace
5. rollback if fail

---

## 十一、驗收標準

### 必測

- 開機後自動恢復
- node crash 自動重啟
- gateway 中斷不重啟風暴
- token 不可被一般使用者讀取
- command log 完整存在

### 安全測試

- 嘗試注入 script 應失敗
- HTTP request 應拒絕
- 非白名單 command 應拒絕

---

## 十二、現階段建議（立即執行）

### 立即做

- rotate token
- 移除 exec_ps
- 移除 update_collector
- metrics 改 HTTPS
- token 改加密存放

### 再進一步

建立：

```text
OpenClaw Production Agent v1
```

---

## 十三、建議後續版本

下一版應加入：

- device registration
- unique host id
- nonce / expiry command
- audit trail
- crash dump upload
- remote diagnostics package

---

## 結論

目前測試版腳本可作為內部驗證用途，但不得直接部署到正式場域。

正式場域必須遵守：

- 最小權限
- 白名單命令
- 加密通訊
- 可審計
- 可 rollback
