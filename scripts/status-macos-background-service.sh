#!/usr/bin/env bash
# Show Pi Task's user LaunchAgent and loopback page status without changing it.
set -euo pipefail

label='com.pi-task.local'
port=30142

if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf '此状态检查只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
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

if [[ ! -f "$plist_path" ]]; then
  printf '未安装 Pi Task 本机后台服务：%s\n' "$plist_path" >&2
  exit 1
fi
if ! launchctl print "$service_target" >/dev/null 2>&1; then
  printf 'LaunchAgent 文件存在，但服务未加载：%s\n' "$service_target" >&2
  exit 1
fi

base_url="http://127.0.0.1:$port"
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
printf 'LaunchAgent：%s\n页面：http://127.0.0.1:%s/（HTTP %s）\n' "$service_target" "$port" "$page_status"
if [[ "$page_status" == '200' ]]; then
  node - "$base_url/api/network/status" <<'NODE'
(async () => {
  const labels = {
    environment: "标准环境变量",
    "local-config": "本机私有配置",
    "macos-system": "macOS 系统代理",
    direct: "直连",
  };
  try {
    const response = await fetch(process.argv[2], { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    const status = await response.json();
    const http = status.http?.enabled ? labels[status.http.source] : "直连";
    const https = status.https?.enabled ? labels[status.https.source] : "直连";
    console.log(`网络：HTTP ${http}；HTTPS ${https}`);
    if (Array.isArray(status.warnings) && status.warnings.length > 0) {
      console.log(`网络提示：${status.warnings.join(", ")}`);
    }
  } catch {
    console.log("网络：状态不可用（当前构建可能早于网络状态接口）");
  }
})();
NODE
fi
if [[ "$page_status" != '200' ]]; then
  printf '查看日志：%s/Library/Logs/Pi Task/pi-task-error.log\n' "$home_dir" >&2
  exit 1
fi
