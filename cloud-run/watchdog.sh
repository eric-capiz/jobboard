#!/usr/bin/env bash
# JobBoard local-stack watchdog (VM-hosted deployment).
# Runs every 5 min via cron. Restarts anything dead: mongod, the service.
# The tunnel is NOT managed here: no tunnel client works through this VM's
# egress proxy (cloudflared ignores the proxy and goes direct; SSH port 22
# is blocked; localtunnel/pinggy/bore hosts are unreachable; /etc/hosts is
# read-only and iptables is blocked). When a tunnel client works, add it
# here (check its URL, restart if dead, write it to live-url.txt).
# Logs to watchdog.log. Never touches the live board or the v7 sweep.
set -u
LOG="/home/hatch/workspace/jobboard/cloud-run/watchdog.log"
MONGO_BIN="/home/hatch/workspace/mongodb/mongodb-linux-x86_64-ubuntu2204-7.0.14/bin/mongod"
MONGO_DATA="/home/hatch/workspace/mongodb/data"
MONGO_LOG="/home/hatch/workspace/mongodb/logs/mongod.log"
SERVICE="/home/hatch/workspace/jobboard/cloud-run/start-service.sh"
SERVICE_LOG="/home/hatch/workspace/jobboard/cloud-run/service.log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
http_ok() { [ "$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null)" = "200" ]; }

# --- mongod ---
if ss -ltn 2>/dev/null | grep -q "127.0.0.1:27017"; then
  echo "$(ts) watchdog: mongod ok" >> "$LOG"
else
  echo "$(ts) watchdog: mongod NOT listening on 27017; restarting" >> "$LOG"
  # stale lock cleanup: only if no mongod process is running
  if ! pgrep -x mongod >/dev/null 2>&1; then
    rm -f "$MONGO_DATA/mongod.lock"
  fi
  if "$MONGO_BIN" --fork --dbpath "$MONGO_DATA" --logpath "$MONGO_LOG" \
      --bind_ip 127.0.0.1 --port 27017 >> "$LOG" 2>&1; then
    echo "$(ts) watchdog: mongod restarted" >> "$LOG"
  else
    echo "$(ts) watchdog: mongod restart FAILED" >> "$LOG"
  fi
fi

# --- service ---
if http_ok "http://127.0.0.1:8080/healthz"; then
  echo "$(ts) watchdog: service ok" >> "$LOG"
else
  echo "$(ts) watchdog: service NOT responding on 8080; restarting" >> "$LOG"
  setsid nohup "$SERVICE" >> "$SERVICE_LOG" 2>&1 < /dev/null &
  sleep 3
  if http_ok "http://127.0.0.1:8080/healthz"; then
    echo "$(ts) watchdog: service restarted" >> "$LOG"
  else
    echo "$(ts) watchdog: service restart FAILED" >> "$LOG"
  fi
fi
echo "$(ts) watchdog: done" >> "$LOG"
