#!/usr/bin/env bash
# Remove only Pi Task's user LaunchAgent; never remove Pi sessions, Task data, builds, or logs.
set -euo pipefail

label='com.pi-task.local'

if [[ "${1:-}" != '--confirm-remove' || $# -ne 1 ]]; then
  printf '用法：%s --confirm-remove\n' "$(basename "$0")" >&2
  exit 1
fi
if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf '此卸载器只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
  exit 1
fi

home_dir="${HOME:?HOME is required for a user LaunchAgent}"
uid="$(id -u)"
plist_path="$home_dir/Library/LaunchAgents/$label.plist"
service_target="gui/$uid/$label"

launchctl bootout "$service_target" 2>/dev/null || true
rm -f "$plist_path"
printf '已移除 Pi Task 本机后台服务。保留：~/.pi/agent、~/.pi-task、.next 与日志目录。\n'
