#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "[MCP-Aggregator] Starting gateway on http://127.0.0.1:3300..."
node gateway.js
