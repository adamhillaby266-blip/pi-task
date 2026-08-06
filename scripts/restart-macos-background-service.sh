#!/usr/bin/env bash
# Restart the user LaunchAgent after a proxy or local network configuration change.
set -euo pipefail

label='com.pi-task.local'
port=30142

if [[ "${1:-}" != '--confirm-idle' || $# -ne 1 ]]; then
  printf '用法：%s --confirm-idle\n' "$(basename "$0")" >&2
  printf '仅在确认没有活动 Pi Task Run 时重启；重启会中断正在执行的对话。\n' >&2
  exit 1
fi
if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf '此重启器只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js，无法检查 Pi Task 页面。\n' >&2
  exit 1
fi

home_dir="${HOME:?HOME is required for a user LaunchAgent}"
uid="$(id -u)"
plist_path="$home_dir/Library/LaunchAgents/$label.plist"
service_target="gui/$uid/$label"
log_dir="$home_dir/Library/Logs/Pi Task"

if [[ ! -f "$plist_path" ]]; then
  printf '未安装 Pi Task 本机后台服务：%s\n' "$plist_path" >&2
  exit 1
fi
if ! launchctl print "$service_target" >/dev/null 2>&1; then
  printf 'LaunchAgent 文件存在，但服务未加载：%s\n' "$service_target" >&2
  exit 1
fi

# --confirm-idle is required because -k stops the current server before a new
# process reads the active macOS proxy or private local network configuration.
if ! launchctl kickstart -k "$service_target"; then
  printf 'Pi Task 后台服务重启失败。查看日志：%s\n' "$log_dir/pi-task-error.log" >&2
  exit 1
fi

base_url="http://127.0.0.1:$port"
page_status='000'
for attempt in $(seq 1 30); do
  page_status="$(node - "$base_url/" <<'NODE'
(async () => {
  try {
    const response = await fetch(process.argv[2]);
    await response.body?.cancel();
    process.stdout.write(String(response.status));
  } catch {
    process.stdout.write("000");
  }
})();
NODE
)"
  if [[ "$page_status" == '200' ]]; then
    break
  fi
  sleep 1
done

if [[ "$page_status" != '200' ]]; then
  printf '后台服务重启后未能在 30 秒内打开页面；最后日志：\n' >&2
  tail -80 "$log_dir/pi-task.log" >&2 || true
  tail -80 "$log_dir/pi-task-error.log" >&2 || true
  exit 1
fi

printf 'Pi Task 后台服务已重启：%s\n' "$base_url"
printf '请运行 scripts/status-macos-background-service.sh 查看不含代理地址的网络来源。\n'
