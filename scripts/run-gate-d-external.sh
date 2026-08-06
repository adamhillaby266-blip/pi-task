#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

port="${PI_TASK_GATE_D_EXTERNAL_PORT:-30146}"
if ! [[ "$port" =~ ^[0-9]+$ ]]; then
  printf '端口必须是数字：%s\n' "$port" >&2
  exit 2
fi
if node -e "fetch('http://127.0.0.1:${port}/api/projects').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  printf '端口 %s 已有 Pi Task 服务运行。请先停止该服务再执行测试。\n' "$port" >&2
  exit 2
fi

"$repo_dir/scripts/ensure-platform-native-deps.sh"

printf '%s\n' 'Pi Task Gate D：真实模型纵向验收（隔离虚构数据）'
printf '%s\n' '将验证：自由对话转任务 → request_task_input → 同 Session 恢复 → Review 人工验收 → 真实运行中取消。'
printf '%s\n' '仅输入虚构测试文字；不要输入公司资料、密码或 API Key 以外的敏感信息。'
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

read -r -s -p '请粘贴 MiniMax API Key（输入不会显示，也不会写入磁盘）：' api_key
printf '\n'
if [[ -z "$api_key" ]]; then
  printf '%s\n' 'API Key 为空，测试未启动。' >&2
  exit 2
fi

umask 077
runtime_name="external-gate-d-$(date +%Y%m%d-%H%M%S)"
platform_name="$(uname -s)-$(uname -m)"
runtime_dir="$repo_dir/.runtime/$runtime_name"
mkdir -p "$runtime_dir/home" "$runtime_dir/tmp" "$runtime_dir/pi" "$runtime_dir/task-data" "$runtime_dir/fictional-project"
printf '{\n  "defaultProvider": "%s",\n  "defaultModel": "MiniMax-M3"\n}\n' "$provider" > "$runtime_dir/pi/settings.json"

export HOME="$runtime_dir/home"
export TMPDIR="$runtime_dir/tmp"
export PI_CODING_AGENT_DIR="$runtime_dir/pi"
export PI_TASK_DATA_DIR="$runtime_dir/task-data"
export PI_TASK_GATE_D_EXTERNAL_RUNTIME="$runtime_dir"
export PI_TASK_GATE_D_EXTERNAL_PROVIDER="$provider"
export PI_TASK_GATE_D_EXTERNAL_BASE_URL="http://127.0.0.1:${port}"
export PI_TASK_NEXT_DIST_DIR=".runtime/next-build-${platform_name}-native-v1"
export NPM_CONFIG_USERCONFIG="$repo_dir/.npmrc"
export NODE_ENV=development
export NEXT_TELEMETRY_DISABLED=1
unset PI_PROVIDER PI_MODEL PI_REASONING_LEVEL PI_SESSION_FILE PI_SESSION_ID
unset ANTHROPIC_API_KEY OPENAI_API_KEY MINIMAX_CN_API_KEY MINIMAX_API_KEY || true
if [[ "$key_var" == 'MINIMAX_CN_API_KEY' ]]; then
  export MINIMAX_CN_API_KEY="$api_key"
else
  export MINIMAX_API_KEY="$api_key"
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
node_modules/.bin/next dev -H 127.0.0.1 -p "$port" >"$runtime_dir/server.log" 2>&1 </dev/null &
server_pid=$!
unset MINIMAX_CN_API_KEY MINIMAX_API_KEY
ready='false'
for _ in $(seq 1 120); do
  if node -e "fetch('http://127.0.0.1:${port}/api/projects').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready='true'
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf '%s\n' 'Pi Task 服务启动失败。查看隔离日志：' "$runtime_dir/server.log" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != 'true' ]]; then
  printf 'Pi Task 服务在 120 秒内未就绪。查看隔离日志：%s\n' "$runtime_dir/server.log" >&2
  exit 1
fi

printf '%s\n' '服务已就绪。模型会先提出一个虚构业务问题；请在终端输入虚构回答，随后输入 y 验收 Review。'
test_status=0
node scripts/gate-d-external.mjs || test_status=$?
cleanup
trap - EXIT INT TERM
printf '测试结束。API Key 已随服务进程退出清除，未写入测试结果；隔离运行目录：%s\n' "$runtime_dir"
exit "$test_status"
