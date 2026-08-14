#!/usr/bin/env bash
# Build, promote, and restart an existing Pi Task LaunchAgent without touching Pi data.
set -euo pipefail

label='com.pi-task.local'
port=30142

usage() {
  printf '用法：%s --confirm-idle\n' "$(basename "$0")" >&2
  printf '仅在确认没有活动 Pi Task Run 时升级；过程会短暂重启本机后台服务。\n' >&2
}

if [[ "${1:-}" != '--confirm-idle' || $# -ne 1 ]]; then
  usage
  exit 1
fi
if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf '此升级器只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v lsof >/dev/null 2>&1; then
  printf '升级器需要 node 和 lsof；未修改现有服务。\n' >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Git 工作树不干净；为保证构建与源码对应，升级器不会继续。\n' >&2
  exit 1
fi

home_dir="${HOME:?HOME is required for a user LaunchAgent}"
uid="$(id -u)"
plist_path="$home_dir/Library/LaunchAgents/$label.plist"
service_target="gui/$uid/$label"
base_url="http://127.0.0.1:$port"
if [[ ! -f "$plist_path" ]]; then
  printf '未找到已安装的 Pi Task 后台服务：%s\n' "$plist_path" >&2
  exit 1
fi

page_status() {
  node - "$base_url/" <<'NODE'
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
}

wait_for_page() {
  local expected="$1"
  local attempts="${2:-45}"
  local status
  for _ in $(seq 1 "$attempts"); do
    status="$(page_status)"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_port_release() {
  for _ in $(seq 1 30); do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_background_service() {
  launchctl bootstrap "gui/$uid" "$plist_path" || return 1
  if ! launchctl kickstart -k "$service_target"; then
    launchctl bootout "$service_target" 2>/dev/null || true
    return 1
  fi
}

promotion_pid=''
previous_dist=''
marker_file=''
promotion_result=''
service_stopped=0
upgrade_succeeded=0
cleanup_foreground() {
  if [[ -n "$promotion_pid" ]] && kill -0 "$promotion_pid" 2>/dev/null; then
    kill -TERM "$promotion_pid" 2>/dev/null || true
    wait "$promotion_pid" 2>/dev/null || true
  fi
  promotion_pid=''
}

load_previous_dist() {
  previous_dist=''
  [[ -n "$promotion_result" && -f "$promotion_result" ]] || return 0
  previous_dist="$(node - "$promotion_result" <<'NODE'
const { readFileSync } = require("node:fs");
try {
  const value = JSON.parse(readFileSync(process.argv[2], "utf8")).previousDist;
  if (typeof value === "string") process.stdout.write(value);
} catch {}
NODE
)"
  case "$previous_dist" in
    "$repo_dir"/.runtime/*) ;;
    *) previous_dist='' ;;
  esac
}

restore_service() {
  cleanup_foreground
  launchctl bootout "$service_target" 2>/dev/null || true

  # E3 records its prior generated build in a non-data runtime backup. Restore
  # only that generated directory if the new background launch did not work.
  if [[ -n "$previous_dist" && -d "$previous_dist" && -d "$repo_dir/.next" ]]; then
    local failed_dist="$repo_dir/.runtime/macos-local-failed-next-$(date +%Y%m%d-%H%M%S)"
    mv "$repo_dir/.next" "$failed_dist"
    mv "$previous_dist" "$repo_dir/.next"
    printf '新构建未能启动，已恢复上一份 .next：%s\n' "$previous_dist" >&2
  fi

  if start_background_service && wait_for_page '200' 45; then
    service_stopped=0
    printf '已恢复 Pi Task 后台服务。\n' >&2
  else
    printf '无法自动恢复后台服务；请查看日志：%s/Library/Logs/Pi Task/pi-task-error.log\n' "$home_dir" >&2
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_foreground
  [[ -z "$marker_file" ]] || rm -f "$marker_file"
  if [[ "$service_stopped" == 1 && "$upgrade_succeeded" == 0 ]]; then
    printf '升级未完成，正在尝试恢复原后台服务。\n' >&2
    restore_service
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$repo_dir/.runtime"
marker_file="$(mktemp "$repo_dir/.runtime/macos-upgrade-marker.XXXXXX")"

printf '开始 macOS 隔离构建；不会读取真实 Pi 认证、会话或 Task 数据。\n'
"$repo_dir/scripts/run-macos-local-build.sh"
runtime_dir="$(find "$repo_dir/.runtime" -mindepth 1 -maxdepth 1 -type d -name 'macos-local-build-*' -newer "$marker_file" -print | sort | tail -n 1)"
rm -f "$marker_file"
marker_file=''
if [[ -z "$runtime_dir" || ! -f "$runtime_dir/result.json" ]]; then
  printf '未找到本次 E2 构建结果；现有后台服务没有被停止。\n' >&2
  exit 1
fi

printf 'E2 已通过。现在短暂停止后台服务并提升已验证构建。\n'
if launchctl print "$service_target" >/dev/null 2>&1; then
  launchctl bootout "$service_target"
fi
service_stopped=1
if ! wait_for_port_release; then
  printf '端口 %s 未释放；未提升构建。\n' "$port" >&2
  exit 1
fi

task_backup_result="$runtime_dir/task-data-backup.json"
if ! node "$repo_dir/scripts/backup-task-data-for-upgrade.mjs" \
  --confirm-stopped \
  "$home_dir/.pi-task/pi-task.sqlite" \
  "$home_dir/.pi-task-backups" \
  "$task_backup_result"; then
  printf 'Task 数据备份或副本迁移验证失败；不会提升构建。\n' >&2
  exit 1
fi

promotion_log="$runtime_dir/upgrade-promotion.log"
promotion_result="$runtime_dir/promotion.json"
"$repo_dir/scripts/promote-macos-local-build.sh" --confirm-idle "$runtime_dir" >"$promotion_log" 2>&1 &
promotion_pid=$!

foreground_ready=0
for _ in $(seq 1 60); do
  if wait_for_page '200' 1; then
    foreground_ready=1
    break
  fi
  if ! kill -0 "$promotion_pid" 2>/dev/null; then
    wait "$promotion_pid" 2>/dev/null || true
    break
  fi
done
load_previous_dist
if [[ "$foreground_ready" != 1 ]]; then
  printf '提升后的前台服务未能启动；最后日志：\n' >&2
  tail -80 "$promotion_log" >&2 || true
  restore_service
  exit 1
fi

# E3 intentionally starts a foreground service. It proved the promoted build
# can use shared data; now return ownership to the existing user LaunchAgent.
cleanup_foreground
if ! wait_for_port_release; then
  printf '前台验证服务未能停止；保留新构建，未重新加载 LaunchAgent。\n' >&2
  exit 1
fi
if ! start_background_service || ! wait_for_page '200' 45; then
  printf '新构建未能由 LaunchAgent 启动，尝试恢复。\n' >&2
  restore_service
  exit 1
fi

"$repo_dir/scripts/status-macos-background-service.sh"
service_stopped=0
upgrade_succeeded=1
trap - EXIT INT TERM
printf 'Pi Task 已升级并恢复为后台服务。Task 数据备份与迁移验证记录：%s\n' "$task_backup_result"
printf '此次升级未发送模型提示词；现在可从 Dock 发送一条无敏感内容的测试消息。\n'
