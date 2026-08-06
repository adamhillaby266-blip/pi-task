#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

runtime_dir="$repo_dir/.runtime/gate-d-conversation-$(date +%Y%m%d-%H%M%S)"
port="${PI_TASK_GATE_D_PORT:-$((31000 + $$ % 1000))}"
platform="$(uname -s)-$(uname -m)"
mkdir -p "$runtime_dir/home" "$runtime_dir/tmp" "$runtime_dir/pi" "$runtime_dir/task-data" "$runtime_dir/project" "$runtime_dir/outside-project"

export HOME="$runtime_dir/home"
export TMPDIR="$runtime_dir/tmp"
export PI_CODING_AGENT_DIR="$runtime_dir/pi"
export PI_TASK_DATA_DIR="$runtime_dir/task-data"
export PI_TASK_NEXT_DIST_DIR=".runtime/next-build-${platform}-native-v1"
export PI_TASK_GATE_D_RUNTIME="$runtime_dir"
export PI_TASK_GATE_D_PORT="$port"
export PI_WEB_NO_OPEN=1
export NEXT_TELEMETRY_DISABLED=1
export NODE_ENV=development

node_modules/.bin/next dev -H 127.0.0.1 -p "$port" >"$runtime_dir/server.log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! node scripts/gate-d-conversation-smoke.mjs; then
  printf '\nGate D smoke failed. Server log:\n' >&2
  tail -100 "$runtime_dir/server.log" >&2
  exit 1
fi

printf '\nGate D conversation smoke passed.\nRuntime: %s\nResult: %s\n' "$runtime_dir" "$runtime_dir/result.json"
