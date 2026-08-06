#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

./scripts/ensure-platform-native-deps.sh

runtime_dir="$repo_dir/.runtime/gate-d-browser-$(date +%Y%m%d-%H%M%S)"
port="${PI_TASK_GATE_D_PORT:-30144}"
platform="$(uname -s)-$(uname -m)"
mkdir -p "$runtime_dir/home" "$runtime_dir/tmp" "$runtime_dir/pi" "$runtime_dir/task-data" "$runtime_dir/fictional-project"

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

if ! node scripts/seed-gate-d-browser.mjs; then
  printf '\nGate D browser fixture failed. Server log:\n' >&2
  tail -100 "$runtime_dir/server.log" >&2
  exit 1
fi
session_id="$(node -e 'const fs=require("fs");const p=process.argv[1];process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).sessionId)' "$runtime_dir/result.json")"
url="http://127.0.0.1:${port}/?session=${session_id}"

printf '\nPi Task Gate D 浏览器检查已准备。\n地址：%s\n\n' "$url"
printf '%s\n' '请点击对话顶部“整理为任务”，检查表单；填写验收条件和预期产物后点击“创建并回到当前对话”。'
printf '%s\n' '不要发送预填提示词，本次只检查创建与恢复入口。终端需保持开启，结束时按 Ctrl+C。'

if command -v open >/dev/null 2>&1; then
  open "$url"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
fi

wait "$server_pid"
