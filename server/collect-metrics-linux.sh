#!/bin/bash
# Linux collector for venue-monitor (royal13-server)
# Runs every 30s, POST metrics to Mac mini

SERVER_URL="${1:-http://100.106.81.54:9100/metrics}"
NODE_NAME="${2:-royal13-server}"
INTERVAL=30

while true; do
  # CPU (1s sample)
  CPU=$(top -bn2 -d0.5 2>/dev/null | grep "Cpu(s)" | tail -1 | awk '{print $2+$4}')
  [ -z "$CPU" ] && CPU=$(awk '{u=$2+$4; t=$2+$4+$5; if(NR==1){ou=u;ot=t}else{printf "%.1f",(u-ou)/(t-ot)*100}}' <(grep 'cpu ' /proc/stat; sleep 1; grep 'cpu ' /proc/stat) 2>/dev/null)

  # RAM
  RAM_INFO=$(free -m 2>/dev/null)
  RAM_TOTAL=$(echo "$RAM_INFO" | awk '/^Mem:/{print $2}')
  RAM_USED=$(echo "$RAM_INFO" | awk '/^Mem:/{print $3}')
  RAM_PCT=$(echo "$RAM_INFO" | awk '/^Mem:/{printf "%.1f", $3/$2*100}')

  # Disk
  DISK_INFO=$(df -BG / 2>/dev/null | tail -1)
  DISK_TOTAL=$(echo "$DISK_INFO" | awk '{gsub("G",""); print $2}')
  DISK_FREE=$(echo "$DISK_INFO" | awk '{gsub("G",""); print $4}')
  DISK_PCT=$(echo "$DISK_INFO" | awk '{gsub("%",""); print $5}')

  # GPU (nvidia-smi if available)
  GPU_NAME=""
  GPU_PCT=""
  GPU_TEMP=""
  if command -v nvidia-smi &>/dev/null; then
    GPU_INFO=$(nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null)
    if [ -n "$GPU_INFO" ]; then
      GPU_NAME=$(echo "$GPU_INFO" | cut -d',' -f1 | xargs)
      GPU_PCT=$(echo "$GPU_INFO" | cut -d',' -f2 | xargs)
      GPU_TEMP=$(echo "$GPU_INFO" | cut -d',' -f3 | xargs)
    fi
  fi

  # Network (bytes/sec over 1s)
  if [ -f /proc/net/dev ]; then
    NET1=$(awk '/eth0|ens|enp/{gsub(/:/, ""); print $2,$10}' /proc/net/dev | head -1)
    sleep 1
    NET2=$(awk '/eth0|ens|enp/{gsub(/:/, ""); print $2,$10}' /proc/net/dev | head -1)
    NET_RECV=$(( $(echo $NET2 | awk '{print $1}') - $(echo $NET1 | awk '{print $1}') ))
    NET_SEND=$(( $(echo $NET2 | awk '{print $2}') - $(echo $NET1 | awk '{print $2}') ))
  else
    NET_RECV=0
    NET_SEND=0
  fi

  # Uptime
  UPTIME_H=$(awk '{printf "%.1f", $1/3600}' /proc/uptime 2>/dev/null)

  # Processes (top 5 by CPU)
  PROCS=$(ps aux --sort=-%cpu 2>/dev/null | head -6 | tail -5 | awk '{printf "\"%s (%.0f%%)\",", $11, $3}' | sed 's/,$//')

  TS=$(date +%s)

  # Build JSON
  JSON=$(cat <<EOF
{
  "timestamp": $TS,
  "node": "$NODE_NAME",
  "cpu_percent": ${CPU:-0},
  "ram_percent": ${RAM_PCT:-0},
  "ram_used_mb": ${RAM_USED:-0},
  "ram_total_mb": ${RAM_TOTAL:-0},
  "gpu_name": ${GPU_NAME:+\"$GPU_NAME\"}${GPU_NAME:-null},
  "gpu_percent": ${GPU_PCT:-null},
  "gpu_temp_c": ${GPU_TEMP:-null},
  "disk_percent": ${DISK_PCT:-0},
  "disk_free_gb": ${DISK_FREE:-0},
  "disk_total_gb": ${DISK_TOTAL:-0},
  "net_send_bps": ${NET_SEND:-0},
  "net_recv_bps": ${NET_RECV:-0},
  "uptime_hours": ${UPTIME_H:-0},
  "processes": [${PROCS}]
}
EOF
)

  curl -s -X POST "$SERVER_URL" \
    -H "Content-Type: application/json" \
    -d "$JSON" >/dev/null 2>&1

  sleep $INTERVAL
done
