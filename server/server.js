#!/usr/bin/env node
const http = require('http');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');

// Gateway log paths
const GATEWAY_LOG = path.join(process.env.HOME, '.openclaw/logs/gateway.log');
const GATEWAY_ERR_LOG = path.join(process.env.HOME, '.openclaw/logs/gateway.err.log');
const METRICS_PORT = 9100;
const DASH_PORT = 3200;
const DB_PATH = path.join(__dirname, 'metrics.db');
const RETENTION_DAYS = 90;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const THRESHOLDS = {
  gpu_temp_c: { max: 85, label: 'GPU 溫度' },
  ram_percent: { max: 95, label: 'RAM 使用率' },
  disk_percent: { max: 90, label: '磁碟使用率' },
  cpu_percent: { max: 95, label: 'CPU 使用率' },
};
const OFFLINE_TIMEOUT_MS = 120000;
const EXPECTED_LAN_IPS = {
  'royal13-server': '192.168.1.179',
  'royal13-a2': '192.168.1.174',
  'royal13-a3': '192.168.1.178',
  'royal13-bigv': '192.168.0.201',
  'royal13-littlev': '192.168.0.198',
};

// Tapo smart plug integration (Cloud API — no LAN access needed)
const { cloudLogin } = require('tp-link-tapo-connect');
const TAPO_EMAIL = process.env.TAPO_EMAIL || '';
const TAPO_PASSWORD = process.env.TAPO_PASSWORD || '';
let tapoToken = null;
let tapoDeviceCache = null; // { alias → { deviceId, ... } }
const TAPO_CACHE_TTL = 300000; // 5 min
let tapoCacheTime = 0;

async function tapoEnsureToken() {
  if (tapoToken) return true;
  try {
    tapoToken = await cloudLogin(TAPO_EMAIL, TAPO_PASSWORD);
    console.log('[tapo] Cloud login OK');
    return true;
  } catch (e) {
    console.error('[tapo] Cloud login error:', e.message);
    tapoToken = null;
    return false;
  }
}

async function tapoRefreshDevices() {
  if (!await tapoEnsureToken()) return false;
  if (tapoDeviceCache && (Date.now() - tapoCacheTime) < TAPO_CACHE_TTL) return true;
  try {
    const devices = await tapoToken.listDevices();
    tapoDeviceCache = {};
    for (const d of devices) {
      // Store full device object for getTapoDevice (needs appServerUrl + deviceId)
      tapoDeviceCache[d.alias] = { _raw: d, deviceId: d.deviceId, model: d.deviceModel, mac: d.deviceMac, fw: d.fwVer, status: d.status };
    }
    tapoCacheTime = Date.now();
    console.log('[tapo] Devices refreshed:', Object.keys(tapoDeviceCache).join(', '));
    return true;
  } catch (e) {
    console.error('[tapo] List devices error:', e.message);
    tapoToken = null;
    return false;
  }
}

async function tapoControl(alias, action) {
  if (!await tapoRefreshDevices()) return { error: 'tapo cloud unavailable' };
  const info = tapoDeviceCache[alias];
  if (!info) return { error: `device "${alias}" not found. Available: ${Object.keys(tapoDeviceCache).join(', ')}` };
  try {
    const dev = tapoToken.getTapoDevice(info._raw);
    if (action === 'on') await dev.turnOn();
    else if (action === 'off') await dev.turnOff();
    else return { error: `unknown action: ${action}` };
    console.log(`[tapo] ${alias} → ${action} OK`);
    return { status: 'ok', alias, action };
  } catch (e) {
    const msg = e.message || '';
    // Device offline or known Tapo errors → return immediately, no retry
    if (msg.includes('-20571') || msg.includes('offline') || msg.includes('-20002')) {
      console.log(`[tapo] ${alias} → ${action}: device offline`);
      return { error: 'device_offline', message: `${alias} 目前離線（未通電或未連網）` };
    }
    console.error(`[tapo] ${alias} ${action} error:`, msg);
    // Only retry on auth/token errors
    tapoToken = null;
    tapoCacheTime = 0;
    if (!await tapoRefreshDevices()) return { error: 'tapo re-login failed' };
    const info2 = tapoDeviceCache[alias];
    if (!info2) return { error: `device "${alias}" not found after re-login` };
    try {
      const dev = tapoToken.getTapoDevice(info2._raw);
      if (action === 'on') await dev.turnOn();
      else await dev.turnOff();
      return { status: 'ok', alias, action };
    } catch (e2) {
      return { error: e2.message };
    }
  }
}

// Command queue for MPVServer control
const pendingCommands = new Map();
const CMD_EXPIRY_MS = 120000;

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
} catch(e) {
  console.error('[server] better-sqlite3 not found:', e.message);
  process.exit(1);
}
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, node TEXT NOT NULL, cpu_percent REAL, ram_percent REAL, ram_used_mb REAL, ram_total_mb REAL, gpu_name TEXT, gpu_percent REAL, gpu_temp_c REAL, disk_percent REAL, disk_free_gb REAL, disk_total_gb REAL, net_send_bps INTEGER, net_recv_bps INTEGER, uptime_hours REAL, processes TEXT, raw TEXT); CREATE INDEX IF NOT EXISTS idx_metrics_node_ts ON metrics(node, ts); CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);`);
try { db.exec('ALTER TABLE metrics ADD COLUMN mpvserver TEXT'); } catch(e) {}

// ── v1 Protocol Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    zone TEXT,
    role TEXT,
    hostname TEXT,
    ip_address TEXT,
    os_name TEXT,
    agent_version TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_seen_at TEXT,
    last_heartbeat_at TEXT,
    last_metrics_at TEXT,
    last_event_at TEXT,
    last_command_poll_at TEXT,
    restart_count_24h INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS device_heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    overall_status TEXT NOT NULL,
    uptime_sec INTEGER,
    cpu_percent REAL,
    ram_percent REAL,
    disk_percent REAL,
    gpu_percent REAL,
    player_process_name TEXT,
    player_process_running INTEGER,
    player_process_pid INTEGER,
    player_restart_count_24h INTEGER,
    raw_payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_device_heartbeats_device_ts ON device_heartbeats(device_id, sent_at DESC);

  CREATE TABLE IF NOT EXISTS device_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    cpu_percent REAL,
    ram_used_mb INTEGER,
    ram_total_mb INTEGER,
    disk_used_gb INTEGER,
    disk_total_gb INTEGER,
    gpu_percent REAL,
    gpu_memory_used_mb INTEGER,
    gpu_memory_total_mb INTEGER,
    network_tx_kbps INTEGER,
    network_rx_kbps INTEGER,
    display_resolution TEXT,
    display_refresh_rate_hz INTEGER,
    display_fullscreen INTEGER,
    raw_payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_device_metrics_device_ts ON device_metrics(device_id, sent_at DESC);

  CREATE TABLE IF NOT EXISTS device_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    details TEXT,
    raw_payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_device_events_device_ts ON device_events(device_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS v1_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    requested_by TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cancelled_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_v1_commands_device_status ON v1_commands(device_id, status);
  CREATE INDEX IF NOT EXISTS idx_v1_commands_status_expires ON v1_commands(status, expires_at);

  CREATE TABLE IF NOT EXISTS command_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    message TEXT,
    details TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    raw_payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_command_results_cmd ON command_results(command_id);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    device_id TEXT,
    command_id TEXT,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    reason TEXT,
    source_ip TEXT,
    metadata TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_device ON audit_logs(device_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_cmd ON audit_logs(command_id);

  CREATE TABLE IF NOT EXISTS device_tokens (
    device_id TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// v1 prepared statements
const v1 = {
  upsertDevice: db.prepare(`INSERT INTO devices (device_id, device_name, hostname, ip_address, os_name, agent_version, status, last_seen_at, last_heartbeat_at, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET device_name=excluded.device_name, hostname=excluded.hostname, ip_address=excluded.ip_address, os_name=excluded.os_name, agent_version=excluded.agent_version, status=excluded.status, last_seen_at=datetime('now'), last_heartbeat_at=datetime('now'), updated_at=datetime('now')`),
  insertHeartbeat: db.prepare(`INSERT INTO device_heartbeats (device_id, sent_at, overall_status, uptime_sec, cpu_percent, ram_percent, disk_percent, gpu_percent, player_process_name, player_process_running, player_process_pid, player_restart_count_24h, raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateDeviceMetricsTs: db.prepare(`UPDATE devices SET last_metrics_at=datetime('now'), updated_at=datetime('now') WHERE device_id=?`),
  insertDeviceMetrics: db.prepare(`INSERT INTO device_metrics (device_id, sent_at, cpu_percent, ram_used_mb, ram_total_mb, disk_used_gb, disk_total_gb, gpu_percent, gpu_memory_used_mb, gpu_memory_total_mb, network_tx_kbps, network_rx_kbps, display_resolution, display_refresh_rate_hz, display_fullscreen, raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  insertEvent: db.prepare(`INSERT OR IGNORE INTO device_events (event_id, device_id, level, category, code, message, occurred_at, details, raw_payload) VALUES (?,?,?,?,?,?,?,?,?)`),
  updateDeviceEventTs: db.prepare(`UPDATE devices SET last_event_at=datetime('now'), updated_at=datetime('now') WHERE device_id=?`),
  getPendingCommands: db.prepare(`SELECT command_id, issued_at, expires_at, requested_by, reason, action, payload FROM v1_commands WHERE device_id=? AND status='queued' ORDER BY issued_at LIMIT ?`),
  markCommandDelivered: db.prepare(`UPDATE v1_commands SET status='delivered', updated_at=datetime('now') WHERE command_id=?`),
  updateDeviceCmdPollTs: db.prepare(`UPDATE devices SET last_command_poll_at=datetime('now'), updated_at=datetime('now') WHERE device_id=?`),
  insertCommandResult: db.prepare(`INSERT INTO command_results (command_id, device_id, action, status, started_at, finished_at, exit_code, message, details, raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?)`),
  updateCommandStatus: db.prepare(`UPDATE v1_commands SET status=?, started_at=COALESCE(?,started_at), finished_at=?, last_error_message=?, updated_at=datetime('now') WHERE command_id=?`),
  insertAudit: db.prepare(`INSERT INTO audit_logs (actor_type, actor_id, device_id, command_id, action, result, reason, source_ip) VALUES (?,?,?,?,?,?,?,?)`),
  getDeviceToken: db.prepare(`SELECT token FROM device_tokens WHERE device_id=?`),
  insertCommand: db.prepare(`INSERT INTO v1_commands (command_id, device_id, action, payload, requested_by, reason, status, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)`),
  getAllDevices: db.prepare(`SELECT * FROM devices ORDER BY device_id`),
  getDevice: db.prepare(`SELECT * FROM devices WHERE device_id=?`),
  expireCommands: db.prepare(`UPDATE v1_commands SET status='expired', updated_at=datetime('now') WHERE status IN ('queued','delivered') AND expires_at < datetime('now')`),
};

// Seed device tokens for known players (only if empty)
const DEVICE_TOKENS = {
  'royal13-a2': process.env.DEVICE_TOKEN_A2 || 'change-me-a2',
  'royal13-a3': process.env.DEVICE_TOKEN_A3 || 'change-me-a3',
  'royal13-bigv': process.env.DEVICE_TOKEN_BIGV || 'change-me-bigv',
  'royal13-littlev': process.env.DEVICE_TOKEN_LITTLEV || 'change-me-littlev',
};
const seedToken = db.prepare(`INSERT OR IGNORE INTO device_tokens (device_id, token) VALUES (?,?)`);
for (const [did, tok] of Object.entries(DEVICE_TOKENS)) {
  seedToken.run(did, tok);
}

// v1 allowed command actions
const V1_ALLOWED_ACTIONS = new Set([
  'restart_player_process', 'restart_agent', 'collect_logs',
  'rotate_log', 'reload_config', 'reboot_host',
  'start_mpvserver', 'stop_mpvserver',
]);

// v1 auth helper
function v1Auth(req, res) {
  const deviceId = req.headers['x-device-id'];
  const deviceToken = req.headers['x-device-token'];
  if (!deviceId || !deviceToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ protocol_version: '1.0', success: false, timestamp: new Date().toISOString(), error: { code: 'UNAUTHORIZED', message: 'Missing X-Device-Id or X-Device-Token header.' } }));
    return null;
  }
  const row = v1.getDeviceToken.get(deviceId);
  if (!row || row.token !== deviceToken) {
    v1.insertAudit.run('device', deviceId, deviceId, null, 'auth_failed', 'rejected', 'invalid token', req.socket.remoteAddress);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ protocol_version: '1.0', success: false, timestamp: new Date().toISOString(), error: { code: 'INVALID_DEVICE_TOKEN', message: 'Device token is invalid.' } }));
    return null;
  }
  return deviceId;
}

function v1Ok(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ protocol_version: '1.0', success: true, timestamp: new Date().toISOString(), data }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

// Expire stale commands every 60s
setInterval(() => { v1.expireCommands.run(); }, 60000);

const insertMetric = db.prepare('INSERT INTO metrics (ts,node,cpu_percent,ram_percent,ram_used_mb,ram_total_mb,gpu_name,gpu_percent,gpu_temp_c,disk_percent,disk_free_gb,disk_total_gb,net_send_bps,net_recv_bps,uptime_hours,processes,mpvserver,raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const getLatest = db.prepare('SELECT * FROM metrics WHERE node=? ORDER BY ts DESC LIMIT 1');
const getNodes = db.prepare('SELECT DISTINCT node FROM metrics WHERE ts>? ORDER BY node');
const getHistory = db.prepare('SELECT ts,cpu_percent,ram_percent,gpu_percent,gpu_temp_c,disk_percent FROM metrics WHERE node=? AND ts>? ORDER BY ts');

const lastAlerts = {};
function shouldAlert(node, metric) { const k=`${node}:${metric}`; const now=Date.now(); if(lastAlerts[k]&&(now-lastAlerts[k])<ALERT_COOLDOWN_MS) return false; lastAlerts[k]=now; return true; }

function checkAlerts(m) {
  const a=[];
  for(const [f,c] of Object.entries(THRESHOLDS)){
    if(m[f]!=null&&m[f]>c.max){
      if(shouldAlert(m.node,f)){a.push(`⚠️ ${m.node}: ${c.label} = ${m[f]}（閾值 ${c.max}）`);}
    }
  }
  if(m.mpvserver && EXPECTED_LAN_IPS[m.node]){
    const ms = m.mpvserver;
    const expectedIP = EXPECTED_LAN_IPS[m.node];
    if(ms.process_count !== undefined && ms.process_count !== 2){
      if(shouldAlert(m.node,'mpvserver_process')){
        a.push(`🔴 ${m.node}: MPVServer 進程數=${ms.process_count}（應為 2）`);
      }
    }
    if(ms.instances && Array.isArray(ms.instances)){
      for(const inst of ms.instances){
        if(!inst.listening){
          if(shouldAlert(m.node,`mpvserver_listen_${inst.port}`)){
            a.push(`🔴 ${m.node}: MPVServer port ${inst.port} 未監聽`);
          }
        } else if(inst.listen_addr && inst.listen_addr !== expectedIP){
          if(shouldAlert(m.node,`mpvserver_addr_${inst.port}`)){
            a.push(`🟡 ${m.node}: MPVServer port ${inst.port} 監聽 ${inst.listen_addr}（應為 ${expectedIP}）`);
          }
        }
      }
    }
  }
  return a;
}

const metricsServer = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Device-Id,X-Device-Token');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.method==='POST'&&req.url==='/metrics'){
    let body='';
    req.on('data',c=>{body+=c;if(body.length>65536){req.destroy();return;}});
    req.on('end',()=>{
      try{
        const m=JSON.parse(body);
        if(!m.node||!m.timestamp){res.writeHead(400);res.end('missing node/timestamp');return;}
        const mpvserverJson = m.mpvserver ? JSON.stringify(m.mpvserver) : null;
        insertMetric.run(m.timestamp,m.node,m.cpu_percent,m.ram_percent,m.ram_used_mb,m.ram_total_mb,m.gpu_name,m.gpu_percent,m.gpu_temp_c,m.disk_percent,m.disk_free_gb,m.disk_total_gb,m.net_send_bps,m.net_recv_bps,m.uptime_hours,m.processes?JSON.stringify(m.processes):null,mpvserverJson,body);
        const alerts=checkAlerts(m);
        if(alerts.length>0)console.log('[ALERT]',alerts.join(' | '));
        // Check for pending command
        const cmd = pendingCommands.get(m.node);
        if(cmd && (Date.now()-cmd.timestamp)<CMD_EXPIRY_MS){
          pendingCommands.delete(m.node);
          console.log(`[control] Sending command to ${m.node}: ${cmd.action}`);
          const cmdObj = {action:cmd.action};
          if(cmd.payload) cmdObj.payload = cmd.payload;
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({status:'ok',command:cmdObj}));
        }else{
          if(cmd) pendingCommands.delete(m.node);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end('{"status":"ok"}');
        }
      }catch(e){res.writeHead(400);res.end('invalid json');}
    });
  }else if(req.method==='GET'&&req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',uptime:process.uptime()}));
  // SECURITY: /bootstrap endpoint removed — remote script deployment is prohibited

  // ── v1 Protocol API ──────────────────────────────────────────────────────
  }else if(req.method==='POST'&&req.url==='/api/v1/heartbeat'){
    readBody(req).then(body=>{
      const deviceId = v1Auth(req, res);
      if(!deviceId) return;
      const s = body.status || {};
      const pp = body.player_process || {};
      const h = body.host || {};
      v1.upsertDevice.run(deviceId, body.device_name||deviceId, h.hostname||null, h.ip||null, h.os||null, body.agent_version||null, s.overall||'unknown');
      v1.insertHeartbeat.run(deviceId, body.sent_at||new Date().toISOString(), s.overall||'unknown', s.uptime_sec||null, s.cpu_percent||null, s.ram_percent||null, s.disk_percent||null, s.gpu_percent||null, pp.name||null, pp.running?1:0, pp.pid||null, pp.restart_count_24h||0, JSON.stringify(body));
      v1.insertAudit.run('device', deviceId, deviceId, null, 'heartbeat', 'accepted', null, req.socket.remoteAddress);
      v1Ok(res, { accepted: true, next_heartbeat_sec: 15 });
    }).catch(()=>{ res.writeHead(400);res.end('invalid json'); });

  }else if(req.method==='POST'&&req.url==='/api/v1/metrics'){
    readBody(req).then(body=>{
      const deviceId = v1Auth(req, res);
      if(!deviceId) return;
      const m = body.metrics || {};
      const d = body.display || {};
      v1.insertDeviceMetrics.run(deviceId, body.sent_at||new Date().toISOString(), m.cpu_percent||null, m.ram_used_mb||null, m.ram_total_mb||null, m.disk_used_gb||null, m.disk_total_gb||null, m.gpu_percent||null, m.gpu_memory_used_mb||null, m.gpu_memory_total_mb||null, m.network_tx_kbps||null, m.network_rx_kbps||null, d.resolution||null, d.refresh_rate_hz||null, d.fullscreen?1:0, JSON.stringify(body));
      v1.updateDeviceMetricsTs.run(deviceId);
      v1Ok(res, { accepted: true });
    }).catch(()=>{ res.writeHead(400);res.end('invalid json'); });

  }else if(req.method==='POST'&&req.url==='/api/v1/events'){
    readBody(req).then(body=>{
      const deviceId = v1Auth(req, res);
      if(!deviceId) return;
      const events = body.events || [];
      let accepted = 0;
      for(const evt of events){
        try{
          v1.insertEvent.run(evt.event_id, deviceId, evt.level, evt.category, evt.code, evt.message, evt.occurred_at, evt.details?JSON.stringify(evt.details):null, JSON.stringify(evt));
          accepted++;
        }catch(e){}
      }
      v1.updateDeviceEventTs.run(deviceId);
      v1.insertAudit.run('device', deviceId, deviceId, null, 'events_reported', 'accepted', `${accepted} events`, req.socket.remoteAddress);
      v1Ok(res, { accepted, total: events.length });
    }).catch(()=>{ res.writeHead(400);res.end('invalid json'); });

  }else if(req.method==='GET'&&req.url.startsWith('/api/v1/commands/pending')){
    const deviceId = v1Auth(req, res);
    if(!deviceId) return;
    const url = new URL(req.url, `http://localhost:${METRICS_PORT}`);
    const limit = parseInt(url.searchParams.get('limit') || '10');
    const commands = v1.getPendingCommands.all(deviceId, limit);
    // Mark as delivered
    for(const cmd of commands){
      v1.markCommandDelivered.run(cmd.command_id);
      v1.insertAudit.run('system', 'server', deviceId, cmd.command_id, 'command_delivered', 'accepted', null, null);
      try { cmd.payload = JSON.parse(cmd.payload); } catch(e) {}
    }
    v1.updateDeviceCmdPollTs.run(deviceId);
    v1Ok(res, { commands });

  }else if(req.method==='POST'&&req.url==='/api/v1/command-result'){
    readBody(req).then(body=>{
      const deviceId = v1Auth(req, res);
      if(!deviceId) return;
      const cr = body.command_result || {};
      v1.insertCommandResult.run(cr.command_id, deviceId, cr.action||'', cr.status||'unknown', cr.started_at||null, cr.finished_at||null, cr.exit_code||null, cr.message||null, cr.details?JSON.stringify(cr.details):null, JSON.stringify(body));
      v1.updateCommandStatus.run(cr.status||'unknown', cr.started_at||null, cr.finished_at||null, cr.message||null, cr.command_id);
      v1.insertAudit.run('device', deviceId, deviceId, cr.command_id, cr.action||'command_result', cr.status||'unknown', cr.message||null, req.socket.remoteAddress);
      v1Ok(res, { accepted: true });
    }).catch(()=>{ res.writeHead(400);res.end('invalid json'); });

  // v1 Dashboard API: list devices, enqueue command
  }else if(req.method==='GET'&&req.url==='/api/v1/devices'){
    const devices = v1.getAllDevices.all();
    v1Ok(res, { devices });

  }else if(req.method==='POST'&&req.url==='/api/v1/commands'){
    readBody(req).then(body=>{
      const { device_id, action, payload, requested_by, reason, expires_in_sec } = body;
      if(!device_id||!action){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({protocol_version:'1.0',success:false,error:{code:'INVALID_REQUEST',message:'Missing device_id or action'}})); return; }
      if(!V1_ALLOWED_ACTIONS.has(action)){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({protocol_version:'1.0',success:false,error:{code:'INVALID_COMMAND_ACTION',message:`Action ${action} is not allowed.`}})); v1.insertAudit.run('operator',requested_by||'unknown',device_id,null,action,'rejected','action not allowed',req.socket.remoteAddress); return; }
      const now = new Date();
      const commandId = `cmd_${now.toISOString().replace(/[-:T]/g,'').slice(0,14)}_${String(Math.floor(Math.random()*100000)).padStart(5,'0')}`;
      const expiresAt = new Date(now.getTime() + (expires_in_sec || 300) * 1000).toISOString();
      v1.insertCommand.run(commandId, device_id, action, JSON.stringify(payload||{}), requested_by||'operator', reason||'', 'queued', now.toISOString(), expiresAt);
      v1.insertAudit.run('operator', requested_by||'operator', device_id, commandId, action, 'accepted', reason||'', req.socket.remoteAddress);
      v1Ok(res, { command_id: commandId, status: 'queued', expires_at: expiresAt });
    }).catch(()=>{ res.writeHead(400);res.end('invalid json'); });

  }else{res.writeHead(404);res.end('not found');}
});

const dashServer = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const url=new URL(req.url,`http://localhost:${DASH_PORT}`);

  // Control API: POST /api/control/:node/:action
  // SECURITY: only allow safe whitelisted actions (exec_ps, update_collector removed)
  const ctrlMatch = url.pathname.match(/^\/api\/control\/([^/]+)\/(start|stop|restart_node)$/);
  if(req.method==='POST' && ctrlMatch){
    const node=ctrlMatch[1];
    let action=ctrlMatch[2];
    if(action==='start') action='start_mpvserver';
    else if(action==='stop') action='stop_mpvserver';
    if(!EXPECTED_LAN_IPS[node]){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'unknown node'}));return;}
    pendingCommands.set(node,{action,timestamp:Date.now()});
    console.log(`[control] Queued ${action} for ${node}`);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'queued',node,action}));
    return;
  }

  // Command status: GET /api/commands
  if(url.pathname==='/api/commands'){
    const cmds={};
    for(const [node,cmd] of pendingCommands){
      if((Date.now()-cmd.timestamp)<CMD_EXPIRY_MS){
        cmds[node]={action:cmd.action,age:Math.floor((Date.now()-cmd.timestamp)/1000)};
      }
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(cmds));
    return;
  }

  // Tapo smart plug API: POST /api/tapo/:alias/on or /api/tapo/:alias/off
  const tapoCtrlMatch = url.pathname.match(/^\/api\/tapo\/([^/]+)\/(on|off)$/);
  if(req.method==='POST' && tapoCtrlMatch){
    const alias=decodeURIComponent(tapoCtrlMatch[1]);
    const action=tapoCtrlMatch[2];
    tapoControl(alias, action).then(result=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    }).catch(e=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));});
    return;
  }

  // Tapo device list: GET /api/tapo/devices
  if(req.method==='GET' && url.pathname==='/api/tapo/devices'){
    tapoRefreshDevices().then(ok=>{
      if(!ok){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'tapo cloud unavailable'}));return;}
      const out = {};
      for (const [alias, info] of Object.entries(tapoDeviceCache || {})) {
        out[alias] = { deviceId: info.deviceId, model: info.model, mac: info.mac, fw: info.fw, status: info.status };
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(out));
    }).catch(e=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));});
    return;
  }

  // Tapo status (backwards compat): GET /api/tapo/status
  if(req.method==='GET' && url.pathname==='/api/tapo/status'){
    tapoRefreshDevices().then(ok=>{
      if(!ok){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'tapo cloud unavailable'}));return;}
      const results = {};
      for (const [alias, info] of Object.entries(tapoDeviceCache || {})) {
        results[alias] = { online: info.status === 0, model: info.model, mac: info.mac, fw: info.fw };
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(results));
    }).catch(e=>{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));});
    return;
  }

  // Gateway log viewer page
  if(url.pathname==='/gateway'){
    const gp=path.join(__dirname,'gateway.html');
    if(fs.existsSync(gp)){res.writeHead(200,{'Content-Type':'text/html'});res.end(fs.readFileSync(gp));}
    else{res.writeHead(404);res.end('gateway.html not found');}
    return;
  }

  // Gateway log SSE stream
  if(url.pathname==='/api/gateway/stream'){
    res.writeHead(200,{
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache',
      'Connection':'keep-alive',
      'X-Accel-Buffering':'no'
    });

    // Read last N lines from a file
    function readTail(filePath, n) {
      return new Promise((resolve) => {
        if (!fs.existsSync(filePath)) { resolve([]); return; }
        const result = [];
        const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }) });
        rl.on('line', (line) => {
          result.push(line);
          if (result.length > n) result.shift();
        });
        rl.on('close', () => resolve(result));
        rl.on('error', () => resolve(result));
      });
    }

    // Send backfill
    Promise.all([readTail(GATEWAY_LOG, 400), readTail(GATEWAY_ERR_LOG, 100)]).then(([logLines, errLines]) => {
      // Tag each line with source, merge and sort by timestamp
      const tagged = [];
      for (const l of logLines) tagged.push({ line: l, source: 'log' });
      for (const l of errLines) tagged.push({ line: l, source: 'err' });
      tagged.sort((a, b) => {
        const ta = a.line.substring(0, 30);
        const tb = b.line.substring(0, 30);
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      // Keep last 500
      const backfill = tagged.slice(-500);
      res.write('event: backfill\ndata: ' + JSON.stringify(backfill) + '\n\n');
    }).catch(() => {});

    // Track file positions for tailing
    const fileState = {};
    function initFilePos(fp) {
      try { fileState[fp] = fs.statSync(fp).size; } catch(e) { fileState[fp] = 0; }
    }
    initFilePos(GATEWAY_LOG);
    initFilePos(GATEWAY_ERR_LOG);

    function readNewLines(fp, source) {
      try {
        const stat = fs.statSync(fp);
        const prev = fileState[fp] || 0;
        if (stat.size <= prev) {
          // File was truncated or no new data
          if (stat.size < prev) fileState[fp] = stat.size;
          return;
        }
        const stream = fs.createReadStream(fp, { start: prev, encoding: 'utf8' });
        let buf = '';
        stream.on('data', (chunk) => { buf += chunk; });
        stream.on('end', () => {
          fileState[fp] = stat.size;
          const newLines = buf.split('\n');
          for (const line of newLines) {
            if (!line.trim()) continue;
            try { res.write('event: log\ndata: ' + JSON.stringify({ line, source }) + '\n\n'); } catch(e) {}
          }
        });
        stream.on('error', () => {});
      } catch(e) {}
    }

    // Watch both files
    const watchers = [];
    function watchFile(fp, source) {
      try {
        const w = fs.watch(fp, () => { readNewLines(fp, source); });
        watchers.push(w);
      } catch(e) {}
    }
    watchFile(GATEWAY_LOG, 'log');
    watchFile(GATEWAY_ERR_LOG, 'err');

    // Keepalive
    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch(e) {}
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(keepalive);
      for (const w of watchers) { try { w.close(); } catch(e) {} }
    });
    return;
  }

  // Gateway log stats
  if(url.pathname==='/api/gateway/stats'){
    const stats = {};
    try { const s = fs.statSync(GATEWAY_LOG); stats.logSize = s.size; stats.lastModified = s.mtimeMs; } catch(e) {}
    try { const s = fs.statSync(GATEWAY_ERR_LOG); stats.errSize = s.size; } catch(e) {}
    try { stats.gatewayPid = execSync('pgrep -f "openclaw.*gateway"', { encoding: 'utf8' }).trim().split('\n')[0]; } catch(e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  if(url.pathname==='/api/nodes'){
    const knownNodes = Object.keys(EXPECTED_LAN_IPS);
    const result=knownNodes.map(node=>{
      const latest=getLatest.get(node);
      if(!latest) return {node, online:false};
      const isOnline=(Date.now()/1000-latest.ts)<(OFFLINE_TIMEOUT_MS/1000);
      const out = {...latest, online:isOnline};
      if(out.mpvserver){try{out.mpvserver=JSON.parse(out.mpvserver);}catch(e){}}
      if(out.processes){try{out.processes=JSON.parse(out.processes);}catch(e){}}
      const cmd=pendingCommands.get(node);
      if(cmd&&(Date.now()-cmd.timestamp)<CMD_EXPIRY_MS){out.pending_command={action:cmd.action,age:Math.floor((Date.now()-cmd.timestamp)/1000)};}
      return out;
    });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(result));
  }else if(url.pathname==='/api/history'){
    const node=url.searchParams.get('node');
    const hours=parseInt(url.searchParams.get('hours')||'24');
    if(!node){res.writeHead(400);res.end('missing node');return;}
    const since=Math.floor(Date.now()/1000)-(hours*3600);
    const rows=getHistory.all(node,since);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(rows));
  }else if(url.pathname==='/'||url.pathname==='/index.html'){
    const hp=path.join(__dirname,'dashboard.html');
    if(fs.existsSync(hp)){res.writeHead(200,{'Content-Type':'text/html'});res.end(fs.readFileSync(hp));}
    else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Venue Monitor</h1><p>Dashboard not deployed yet.</p>');}
  }else{res.writeHead(404);res.end('not found');}
});

setInterval(()=>{const cutoff=Math.floor(Date.now()/1000)-(RETENTION_DAYS*86400);const r=db.prepare('DELETE FROM metrics WHERE ts<?').run(cutoff);if(r.changes>0)console.log(`[cleanup] Removed ${r.changes} old records`);},86400000);
metricsServer.listen(METRICS_PORT,'0.0.0.0',()=>console.log(`[server] Metrics API on :${METRICS_PORT}`));
dashServer.listen(DASH_PORT,'0.0.0.0',()=>console.log(`[server] Dashboard on :${DASH_PORT}`));

setInterval(()=>{
  for(const node of Object.keys(EXPECTED_LAN_IPS)){
    const latest=getLatest.get(node);
    if(latest&&(Date.now()/1000-latest.ts)>(OFFLINE_TIMEOUT_MS/1000)){
      if(shouldAlert(node,'offline'))console.log(`[ALERT] 🔴 ${node}: offline >120s`);
    }
  }
},60000);
console.log('[server] Venue Monitor started');
