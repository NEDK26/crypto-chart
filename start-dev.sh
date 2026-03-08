#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MARKET_HOST="${MARKET_HOST:-0.0.0.0}"
MARKET_PORT="${MARKET_PORT:-4180}"
MARKET_PID_FILE="$ROOT_DIR/.market-dev.pid"
MARKET_LOG_FILE="$ROOT_DIR/bot/nohup.market.out"

is_market_healthy() {
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  curl -sf "http://127.0.0.1:${MARKET_PORT}/health" >/dev/null 2>&1
}

start_market_server() {
  if [[ -f "$MARKET_PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$MARKET_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      if is_market_healthy; then
        echo "Market server already running (PID: $existing_pid)"
        echo "URL: http://localhost:$MARKET_PORT"
        echo "Log: $MARKET_LOG_FILE"
        return
      fi

      echo "Found stale market PID ($existing_pid), restarting..."
      kill "$existing_pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$MARKET_PID_FILE"
  fi

  if command -v lsof >/dev/null 2>&1; then
    local port_pid
    port_pid="$(lsof -ti "tcp:${MARKET_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$port_pid" ]]; then
      port_pid="${port_pid%%$'\n'*}"
      echo "$port_pid" > "$MARKET_PID_FILE"
      if is_market_healthy; then
        echo "Market server port $MARKET_PORT already in use (PID: $port_pid)."
        echo "Assuming market server is already running."
        echo "URL: http://localhost:$MARKET_PORT"
        return
      fi

      echo "Port $MARKET_PORT is occupied by unhealthy process ($port_pid), restarting..."
      kill "$port_pid" 2>/dev/null || true
      rm -f "$MARKET_PID_FILE"
      sleep 1
    fi
  fi

  if [[ ! -d "$ROOT_DIR/bot/node_modules" ]]; then
    echo "Installing bot dependencies..."
    npm --prefix bot install
  fi

  echo "Starting market server..."
  MARKET_SERVER_HOST="$MARKET_HOST" MARKET_SERVER_PORT="$MARKET_PORT" \
    nohup npm --prefix bot run dev:market > "$MARKET_LOG_FILE" 2>&1 &
  local market_pid=$!
  echo "$market_pid" > "$MARKET_PID_FILE"

  sleep 2

  if ! kill -0 "$market_pid" 2>/dev/null; then
    echo "Failed to start market server."
    echo "Check log: $MARKET_LOG_FILE"
    rm -f "$MARKET_PID_FILE"
    exit 1
  fi

  if command -v curl >/dev/null 2>&1; then
    local health_ok="0"
    for _ in {1..20}; do
      if is_market_healthy; then
        health_ok="1"
        break
      fi
      sleep 0.5
    done

    if [[ "$health_ok" != "1" ]]; then
      echo "Market server process started but health check did not pass."
      echo "Check log: $MARKET_LOG_FILE"
      exit 1
    fi
  fi

  echo "Market server started (PID: $market_pid)"
  echo "URL: http://localhost:$MARKET_PORT"
  echo "Log: $MARKET_LOG_FILE"
}

start_market_server

echo "Starting frontend service..."
bash "$ROOT_DIR/start-frontend.sh"

echo ""
echo "All services are ready:"
echo "- Market server: http://localhost:$MARKET_PORT"
echo "- Frontend: http://localhost:6644"
