#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-5173}"
PID_FILE="$ROOT_DIR/.frontend-dev.pid"
LOG_FILE="$ROOT_DIR/nohup.out"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Frontend dev server already running (PID: $EXISTING_PID)"
    echo "URL: http://localhost:$PORT"
    echo "Log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PORT_PID" ]]; then
    PORT_PID="${PORT_PID%%$'\n'*}"
    echo "$PORT_PID" > "$PID_FILE"
    echo "Port $PORT is already in use (PID: $PORT_PID)."
    echo "Assuming frontend service is already running."
    echo "URL: http://localhost:$PORT"
    exit 0
  fi
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting frontend dev server..."
npm run dev -- --host "$HOST" --port "$PORT" > "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

sleep 2

if kill -0 "$PID" 2>/dev/null; then
  echo "Started successfully (PID: $PID)"
  echo "URL: http://localhost:$PORT"
  echo "Log: $LOG_FILE"
  exit 0
fi

echo "Failed to start frontend dev server."
echo "Check log: $LOG_FILE"
rm -f "$PID_FILE"
exit 1
