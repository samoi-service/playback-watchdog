# OpenClaw 程序層級架構圖與責任分層 v1.0

## 一、文件目的

本文件用來明確定義 OpenClaw 場域端部署時，各層程序之間的角色、責任與啟動關係，避免後續實作時混淆以下概念：

- OpenClaw 本體
- Windows 本機 Node Agent
- Windows Service Wrapper
- Linux Central Control Server

本文件的目標是讓系統架構、命名、職責與層級關係一次講清楚。

---

## 二、先講結論

目前建議架構不是：

```text
Node Server 包 OpenClaw 功能本體
```

而是：

```text
Node Agent / Supervisor 管理 OpenClaw 的執行與維運層
```

也就是說：

- OpenClaw 是被管理的工作程序
- Node Agent 是本機管理者
- WinSW 是把 Node Agent 包成 Windows Service 的外層
- Linux Server 是中央監控與控制中心

---

## 三、程序層級總覽

```text
Linux Central Control Server
        ↓
Windows Player Agent (Node Agent / Supervisor)
        ↓
OpenClaw Process
```

若加入 Windows Service 包裝層，實際程序關係如下：

```text
Windows Service Wrapper (WinSW)
        ↓
Node Agent / Supervisor
        ↓
OpenClaw Process
```

---

## 四、完整架構圖

```text
┌────────────────────────────────────────────┐
│             Linux Server                    │
│--------------------------------------------│
│ Central Control Server                      │
│ - Device Registry                           │
│ - Heartbeat API                             │
│ - Command Dispatcher                        │
│ - Alert Engine                              │
│ - Dashboard / Web UI                        │
│ - Log / Metrics Storage                     │
└────────────────────────────────────────────┘
                    │
                    │ HTTPS / JSON
                    ▼
┌────────────────────────────────────────────┐
│         Windows Player (單台)               │
│--------------------------------------------│
│ WinSW Windows Service Wrapper               │
│   └─ 負責將 Node Agent 註冊為 Service        │
│   └─ 負責 service 啟動 / 停止 / 自動恢復      │
│                                            │
│ Node Agent / Supervisor                     │
│   └─ 啟動 OpenClaw                          │
│   └─ 監控 OpenClaw 狀態                     │
│   └─ 收集 metrics                           │
│   └─ 回報 Linux Server                      │
│   └─ 接收白名單命令                         │
│   └─ 執行本機 repair                        │
│                                            │
│ OpenClaw Process                            │
│   └─ 執行實際 OpenClaw node run 任務         │
│   └─ 與 gateway / workflow 系統互動         │
│   └─ 提供原本 OpenClaw 應有功能             │
└────────────────────────────────────────────┘
```

---

## 五、三層責任分工

## 5.1 OpenClaw Process

### 定義
OpenClaw 是原本的核心工作程序，屬於被管理對象。

### 角色
- 執行 OpenClaw node runtime
- 處理本來 OpenClaw 應該執行的工作
- 與外部 gateway / workflow 互動
- 作為 agent 監控的核心程序

### 範例
```text
node openclaw.mjs node run --host ... --port ... --tls ...
```

### 它不應負責
- Windows Service 註冊
- 場域端中央監控
- command 白名單驗證
- 本機系統層 repair orchestration
- dashboard / audit storage

---

## 5.2 Node Agent / Supervisor

### 定義
Node Agent 是 Windows Player 上額外部署的一個本機常駐程式。

### 本質
```text
Supervisor / Watchdog / Local Control Agent
```

### 核心責任
- 啟動 OpenClaw
- 監控 OpenClaw process
- 收集本機 metrics
- 對 Linux Server 發 heartbeat
- 接收 Linux Server 的白名單命令
- 執行本機 repair
- 管理 logs、runtime 狀態、command 去重

### 建議模組
```text
agent/
├── launcher
├── process-watcher
├── command-runner
├── metrics-reporter
├── local-repair
├── logger
└── config-loader
```

---

## 5.3 Windows Service Wrapper（WinSW）

### 定義
WinSW 是把 Node Agent 變成 Windows Service 的外層 wrapper。

### 責任
- 把 Node Agent 註冊成 Windows Service
- 開機自動啟動 Node Agent
- 停止 / 啟動 / 重啟 service
- service recovery
- wrapper 層 log

### 不負責
- 直接管理 OpenClaw 業務邏輯
- 收集 metrics
- command protocol
- 與 Linux Server 溝通

---

## 六、Linux Server 的定位

Linux Server 是：

```text
Central Control Plane
```

### 核心責任
- 集中管理全部 Windows Player
- 收取 heartbeat / metrics / events
- 保存 command 與 audit logs
- Dashboard
- Alert
- 下發白名單命令

---

## 七、程序關係圖（最重要）

### 正確理解

```text
WinSW
 └─ Node Agent
     └─ OpenClaw
```

### 加上中央伺服器

```text
Linux Central Control Server
     ⇅
Node Agent
     ⇅
OpenClaw
```

---

## 八、不要混淆的錯誤理解

### 錯誤 1
```text
Node server = OpenClaw 本體
```

### 錯誤 2
```text
Linux Server 直接遠端接管 Windows Player
```

### 錯誤 3
```text
PowerShell 常駐腳本 = 正式 agent
```

### 錯誤 4
```text
WinSW 直接包 OpenClaw 就夠了
```

---

## 九、推薦命名方式

### Linux Server
```text
OpenClaw Control Server
```

### Windows Agent
```text
OpenClaw Player Agent
```

### 核心程序
```text
OpenClaw Runtime
```

### Windows Service 名稱
```text
OpenClawPlayerAgent
```

---

## 十、推薦程序生命週期

## 啟動流程

```text
Windows 開機
    ↓
WinSW Service 啟動
    ↓
Node Agent 啟動
    ↓
Node Agent 讀取 config
    ↓
Node Agent 啟動 OpenClaw
    ↓
Node Agent 發 heartbeat 到 Linux Server
```

## 異常流程

```text
OpenClaw 異常退出
    ↓
Node Agent 偵測失敗
    ↓
Node Agent repair / restart
    ↓
回報 Linux Server
```

## 更高層異常

```text
Node Agent 異常退出
    ↓
WinSW service recovery 拉起
```

---

## 十一、責任邊界一句話版

### WinSW
讓 agent 變成 Windows Service

### Node Agent
管理 OpenClaw 本機維運與通訊

### OpenClaw
執行原本任務

### Linux Server
集中監控、告警、命令與審計

---

## 十二、最終結論

完整層級應為：

```text
Linux Central Control Server
        ↓
Windows Service Wrapper (WinSW)
        ↓
Node Agent / Supervisor
        ↓
OpenClaw Runtime
```

這是最適合場域端部署的結構。
