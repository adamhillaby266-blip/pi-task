#!/usr/bin/env bash
# Build and smoke-test Pi Task for macOS without touching real Pi data.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '此 E2 runner 只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

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

if [[ ! -x node_modules/.bin/next ]]; then
  printf '缺少已安装的项目依赖。此 runner 不会执行 npm install 或下载依赖；请停止并确认后再处理。\n' >&2
  exit 1
fi

# Do not call ensure-platform-native-deps.sh here: it may download packages.
if ! node -e "require('lightningcss'); require('@tailwindcss/oxide')"; then
  printf '当前 Mac 缺少可用的原生构建依赖。此 runner 已停止，未执行下载或安装。\n' >&2
  exit 1
fi

port="${PI_TASK_MACOS_BUILD_PORT:-30152}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  printf 'PI_TASK_MACOS_BUILD_PORT 必须是 1024–65535 之间的整数；当前值：%s\n' "$port" >&2
  exit 1
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '隔离验收端口 %s 已被占用；请更换 PI_TASK_MACOS_BUILD_PORT 或停止对应程序。\n' "$port" >&2
  exit 1
fi

umask 077
stamp="$(date +%Y%m%d-%H%M%S)"
runtime_dir="$repo_dir/.runtime/macos-local-build-$stamp"
# A stable distDir is predeclared in tsconfig.json so Next does not rewrite a
# tracked configuration file for each isolated build.
dist_rel=".runtime/macos-local-build/next"
dist_dir="$repo_dir/$dist_rel"
mkdir -p "$runtime_dir/home" "$runtime_dir/tmp" "$runtime_dir/pi" "$runtime_dir/task-data"

# Every mutable runtime location is isolated. In particular, this build never
# reads or writes the user's ~/.pi/agent or ~/.pi-task directories.
export HOME="$runtime_dir/home"
export TMPDIR="$runtime_dir/tmp"
export PI_CODING_AGENT_DIR="$runtime_dir/pi"
export PI_TASK_DATA_DIR="$runtime_dir/task-data"
export PI_TASK_NEXT_DIST_DIR="$dist_rel"
export PI_WEB_HOSTNAME=127.0.0.1
export PI_WEB_NO_OPEN=1
export NEXT_TELEMETRY_DISABLED=1
export NODE_ENV=production

printf '开始 macOS 隔离生产构建。不会下载依赖、不会访问真实 Pi 数据。\n'
if ! node_modules/.bin/next build --webpack >"$runtime_dir/build.log" 2>&1; then
  printf '构建失败；最后 100 行日志：\n' >&2
  tail -100 "$runtime_dir/build.log" >&2 || true
  exit 1
fi

for required in "$dist_dir/BUILD_ID" "$dist_dir/server" "$dist_dir/static"; do
  if [[ ! -e "$required" ]]; then
    printf '构建缺少必要产物：%s\n' "$required" >&2
    exit 1
  fi
done

server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=""
  fi
}
trap cleanup EXIT INT TERM

node_modules/.bin/next start -H 127.0.0.1 -p "$port" >"$runtime_dir/server.log" 2>&1 &
server_pid=$!
base_url="http://127.0.0.1:$port"
page_status="000"
for attempt in $(seq 1 60); do
  page_status="$(node - "$base_url/" "$runtime_dir/page.html" <<'NODE'
const { writeFileSync } = require("node:fs");
const [url, output] = process.argv.slice(2);
(async () => {
  try {
    const response = await fetch(url);
    writeFileSync(output, await response.text(), { mode: 0o600 });
    process.stdout.write(String(response.status));
  } catch {
    process.stdout.write("000");
  }
})();
NODE
)"
  if [[ "$page_status" == "200" ]]; then
    break
  fi
  sleep 1
done

if [[ "$page_status" != "200" ]]; then
  printf '隔离生产服务器未在 60 秒内返回页面；最后 100 行日志：\n' >&2
  tail -100 "$runtime_dir/server.log" >&2 || true
  exit 1
fi
if ! grep -q 'Pi Task' "$runtime_dir/page.html"; then
  printf '隔离生产页面未包含 Pi Task 标识，停止验收。\n' >&2
  exit 1
fi
cleanup
trap - EXIT INT TERM

auth_state="absent"
if [[ -f "$runtime_dir/pi/auth.json" ]]; then
  auth_value="$(tr -d '[:space:]' < "$runtime_dir/pi/auth.json")"
  if [[ "$auth_value" != '{}' ]]; then
    printf '隔离 auth.json 不是空对象，停止验收。\n' >&2
    exit 1
  fi
  auth_state="{}"
fi

export PI_TASK_MACOS_BUILD_RESULT="$runtime_dir/result.json"
export PI_TASK_MACOS_BUILD_RUNTIME="$runtime_dir"
export PI_TASK_MACOS_BUILD_DIST="$dist_rel"
export PI_TASK_MACOS_BUILD_PORT="$port"
export PI_TASK_MACOS_BUILD_PAGE_STATUS="$page_status"
export PI_TASK_MACOS_BUILD_AUTH="$auth_state"
node - <<'NODE'
const { writeFileSync } = require("node:fs");
const result = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  runtime: process.env.PI_TASK_MACOS_BUILD_RUNTIME,
  distDir: process.env.PI_TASK_MACOS_BUILD_DIST,
  port: Number(process.env.PI_TASK_MACOS_BUILD_PORT),
  pageStatus: Number(process.env.PI_TASK_MACOS_BUILD_PAGE_STATUS),
  auth: process.env.PI_TASK_MACOS_BUILD_AUTH,
  promotedToDefaultDist: false,
};
writeFileSync(process.env.PI_TASK_MACOS_BUILD_RESULT, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
NODE

printf 'macOS 隔离生产构建与页面冒烟通过。产物仅保留在 %s；尚未写入 .next，也未启动真实本机数据。\n' "$runtime_dir"
