#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if node -e "fetch('http://127.0.0.1:30142/api/projects').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  printf '%s\n' '端口 30142 已有 Pi Task 服务运行。请先停止该服务再执行测试。' >&2
  exit 2
fi

"$repo_dir/scripts/ensure-platform-native-deps.sh"

printf '%s\n' 'Pi Task Gate C：MiniMax M3 双 Run 外部模型测试'
printf '%s\n' '1) MiniMax 国内平台（api.minimaxi.com，默认）'
printf '%s\n' '2) MiniMax 国际平台（api.minimax.io）'
read -r -p '请选择 [1/2]：' platform
case "${platform:-1}" in
  1)
    provider='minimax-cn'
    key_var='MINIMAX_CN_API_KEY'
    ;;
  2)
    provider='minimax'
    key_var='MINIMAX_API_KEY'
    ;;
  *)
    printf '%s\n' '选择无效，测试未启动。' >&2
    exit 2
    ;;
esac

read -r -s -p '请粘贴 MiniMax API Key（输入不会显示）：' api_key
printf '\n'
if [[ -z "$api_key" ]]; then
  printf '%s\n' 'API Key 为空，测试未启动。' >&2
  exit 2
fi

umask 077
runtime_name="external-gate-c-$(date +%Y%m%d-%H%M%S)"
next_build_name="next-build-$(uname -s)-$(uname -m)"
runtime_dir="$repo_dir/.runtime/$runtime_name"
mkdir -p "$runtime_dir/home" "$runtime_dir/tmp" "$runtime_dir/pi" "$runtime_dir/task-data" "$runtime_dir/fictional-project"
printf '{\n  "defaultProvider": "%s",\n  "defaultModel": "MiniMax-M3"\n}\n' "$provider" > "$runtime_dir/pi/settings.json"

export HOME="$runtime_dir/home"
export TMPDIR="$runtime_dir/tmp"
export PI_CODING_AGENT_DIR="$runtime_dir/pi"
export PI_TASK_DATA_DIR="$runtime_dir/task-data"
export PI_TASK_TEST_RUNTIME="$runtime_dir"
export PI_TASK_TEST_PROVIDER="$provider"
export PI_TASK_TEST_BASE_URL='http://127.0.0.1:30142'
export PI_TASK_NEXT_DIST_DIR=".runtime/$next_build_name"
export NPM_CONFIG_USERCONFIG="$repo_dir/.npmrc"
export NODE_ENV=development
export NEXT_TELEMETRY_DISABLED=1
unset PI_PROVIDER PI_MODEL PI_REASONING_LEVEL PI_SESSION_FILE PI_SESSION_ID
if [[ "$key_var" == 'MINIMAX_CN_API_KEY' ]]; then
  export MINIMAX_CN_API_KEY="$api_key"
  unset MINIMAX_API_KEY || true
else
  export MINIMAX_API_KEY="$api_key"
  unset MINIMAX_CN_API_KEY || true
fi
api_key=''

server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  unset MINIMAX_CN_API_KEY MINIMAX_API_KEY
}
trap cleanup EXIT INT TERM

printf '%s\n' '正在启动隔离的 Pi Task 服务……'
node_modules/.bin/next dev -H 127.0.0.1 -p 30142 >"$runtime_dir/server.log" 2>&1 </dev/null &
server_pid=$!
unset MINIMAX_CN_API_KEY MINIMAX_API_KEY
ready='false'
for _ in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:30142/api/projects').then(r=>{if(!r.ok)process.exit(1)})" >/dev/null 2>&1; then
    ready='true'
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf '%s\n' 'Pi Task 服务启动失败：' >&2
    tail -80 "$runtime_dir/server.log" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != 'true' ]]; then
  printf '%s\n' 'Pi Task 服务在 90 秒内未就绪。' >&2
  tail -80 "$runtime_dir/server.log" >&2
  exit 1
fi

printf '%s\n' '服务已就绪，将发送一项完全虚构的 Markdown 文件任务。第一轮后由你确认是否退回并启动第二个 Run。'
test_status=0
node scripts/gate-c-external.mjs || test_status=$?
cleanup
trap - EXIT INT TERM
printf '%s\n' '测试结束。API Key 已随服务进程退出清除，未写入测试结果。'
exit "$test_status"
