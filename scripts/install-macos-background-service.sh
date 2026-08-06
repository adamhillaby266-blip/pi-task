#!/usr/bin/env bash
# Install a user-scoped, loopback-only Pi Task LaunchAgent.
set -euo pipefail

label='com.pi-task.local'
port=30142
usage() {
  printf '用法：%s --confirm-install\n' "$(basename "$0")" >&2
}

if [[ "${1:-}" != "--confirm-install" || $# -ne 1 ]]; then
  usage
  exit 1
fi
if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf '此安装器只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if [[ ! -f "$repo_dir/.next/BUILD_ID" ]]; then
  printf '未找到已验证的 .next 构建产物；不会安装后台服务。\n' >&2
  exit 1
fi
# E2 staging type files retain their old relative source paths after E3 moves
# the runtime build into .next. They are not used by next start.
rm -rf "$repo_dir/.next/types" "$repo_dir/.next/dev/types"
if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js。Pi Task 需要 Node.js 22.19.0 或更高版本。\n' >&2
  exit 1
fi
if ! node - <<'NODE'
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./bin/node-version.js");
if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}
NODE
then
  exit 1
fi

home_dir="${HOME:?HOME is required for a user LaunchAgent}"
if [[ ! -d "$home_dir" ]]; then
  printf 'HOME 目录不存在：%s\n' "$home_dir" >&2
  exit 1
fi
uid="$(id -u)"
plist_dir="$home_dir/Library/LaunchAgents"
plist_path="$plist_dir/$label.plist"
log_dir="$home_dir/Library/Logs/Pi Task"
service_target="gui/$uid/$label"

if [[ -e "$plist_path" ]] || launchctl print "$service_target" >/dev/null 2>&1; then
  printf 'Pi Task 后台服务似乎已经安装。为避免覆盖现有配置，本安装器已停止。\n' >&2
  printf '请先运行 scripts/status-macos-background-service.sh 查看状态；如需移除，运行 uninstall 脚本。\n' >&2
  exit 1
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '端口 %s 已被占用。请先停止当前 Pi Task 或其他服务，再安装后台服务。\n' "$port" >&2
  exit 1
fi

umask 077
mkdir -p "$plist_dir" "$log_dir" "$repo_dir/.runtime"
node_path="$(node -p 'process.execPath')"
launch_path="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
stamp="$(date +%Y%m%d-%H%M%S)"
temp_plist="$repo_dir/.runtime/macos-launch-agent-$stamp.plist"
node scripts/write-macos-launch-agent.mjs "$temp_plist" "$node_path" "$repo_dir" "$home_dir" "$log_dir" "$launch_path"
plutil -lint "$temp_plist" >/dev/null
cp "$temp_plist" "$plist_path"
chmod 600 "$plist_path"

cleanup_failed_install() {
  launchctl bootout "$service_target" 2>/dev/null || true
  rm -f "$plist_path"
}

if ! launchctl bootstrap "gui/$uid" "$plist_path"; then
  cleanup_failed_install
  printf 'LaunchAgent 注册失败；已移除本次配置。\n' >&2
  exit 1
fi
if ! launchctl kickstart -k "$service_target"; then
  cleanup_failed_install
  printf 'LaunchAgent 启动失败；已移除本次配置。\n' >&2
  exit 1
fi

base_url="http://127.0.0.1:$port"
page_status='000'
for attempt in $(seq 1 45); do
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
  printf '后台服务未能在 45 秒内启动；最后日志：\n' >&2
  tail -80 "$log_dir/pi-task.log" >&2 || true
  tail -80 "$log_dir/pi-task-error.log" >&2 || true
  cleanup_failed_install
  printf '本次 LaunchAgent 配置已移除；真实 Pi 数据未被删除。\n' >&2
  exit 1
fi

printf 'Pi Task 本机后台服务已启动：%s\n' "$base_url"
printf 'LaunchAgent：%s\n日志目录：%s\n' "$plist_path" "$log_dir"
printf '后台服务不会发送模型提示词；现在将打开浏览器，可继续把 Pi Task 加入 Dock。\n'
open "$base_url"
