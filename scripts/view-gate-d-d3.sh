#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

./scripts/ensure-platform-native-deps.sh

runtime_dir="$repo_dir/.runtime/gate-d-d3-browser-$(date +%Y%m%d-%H%M%S)"
port="${PI_TASK_GATE_D_PORT:-30147}"
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

if ! node scripts/seed-gate-d-d3-browser.mjs; then
  printf '\nGate D D3 browser fixture failed. Server log:\n' >&2
  tail -100 "$runtime_dir/server.log" >&2
  exit 1
fi
session_id="$(node -e 'const fs=require("fs");const p=process.argv[1];process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).sessionId)' "$runtime_dir/result.json")"
url="http://127.0.0.1:${port}/?session=${session_id}"

printf '\nPi Task Gate D D3 浏览器检查已准备。\n地址：%s\n\n' "$url"
printf '%s\n' '进入顶部“任务”页后：先打开“补全虚构交接合同”，确认“合同待补全”和“编辑合同”；补全目标、验收条件、预期产物后保存，再用“移到待办”确认状态变化。'
printf '%s\n' '桌面端：在积压事项列内拖动“同列排序：再整理目录说明”到“同列排序：先整理封面说明”前面，确认排序持久。'
printf '%s\n' '触控回退：打开任一积压/待办任务，使用“上移 / 下移 / 移到待办 / 移回积压”按钮，不依赖 HTML 拖拽。'
printf '%s\n' '请检查窄窗口下合同提示、编辑表单、队列按钮和长文本不截断；这是隔离虚构项目，不要发送任务提示词。终端需保持开启，结束时按 Ctrl+C。'

if command -v open >/dev/null 2>&1; then
  open "$url"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
fi

wait "$server_pid"
