#!/usr/bin/env bash
# Double-clickable, loopback-only Pi Task launcher for a verified Mac build.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Pi Task 的本机启动器仅适用于 macOS。\n' >&2
  exit 1
fi

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${PORT:-30142}"

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  printf 'PORT 必须是 1024–65535 之间的整数；当前值：%s\n' "$port" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js。Pi Task 需要 Node.js 22.19.0 或更高版本。\n' >&2
  exit 1
fi

if [[ ! -f "$package_dir/.next/BUILD_ID" ]]; then
  printf '未找到已验证的 Pi Task 构建产物。此启动器不会自动构建；请先按本机交付流程完成构建。\n' >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '端口 %s 已被占用。若它是已启动的 Pi Task，请打开 http://127.0.0.1:%s；否则先停止占用该端口的程序。\n' "$port" "$port" >&2
  exit 1
fi

# This launcher deliberately leaves HOME, PI_CODING_AGENT_DIR, and
# PI_TASK_DATA_DIR unchanged: normal Mac use shares ~/.pi/agent and keeps
# Task data in ~/.pi-task. A caller can still supply explicit directories.
unset PI_TASK_NEXT_DIST_DIR
export PI_WEB_NO_OPEN=0
export NEXT_TELEMETRY_DISABLED=1

printf 'Pi Task 将仅监听 http://127.0.0.1:%s，并复用现有 Pi 数据。关闭此终端或按 Control-C 可停止服务。\n' "$port"
cd "$package_dir"
exec node "$package_dir/bin/pi-web.js" --hostname 127.0.0.1 --port "$port"
