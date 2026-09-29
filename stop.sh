#!/usr/bin/env bash
PORT=${PORT:-3300}
echo "[MCP-Aggregator] Stopping gateway running on port $PORT..."
PID=$(lsof -ti :$PORT || true)
if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null || true
  echo "[MCP-Aggregator] Gateway stopped (PID: $PID)."
else
  echo "[MCP-Aggregator] No process found on port $PORT."
fi
