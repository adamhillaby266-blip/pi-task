#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if node -e "fetch('http://127.0.0.1:30142/api/projects').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  printf '%s\n' '端口 30142 已有 Pi Task 服务运行。请先停止该服务。' >&2
  exit 2
fi

shopt -s nullglob
runtimes=("$repo_dir"/.runtime/external-gate-c-*)
shopt -u nullglob
if [[ ${#runtimes[@]} -eq 0 ]]; then
  printf '%s\n' '没有找到 Gate C 测试数据。' >&2
  exit 2
fi
runtime_dir="$(ls -td "${runtimes[@]}" | head -n 1)"
result_file="$runtime_dir/result.json"
if [[ ! -f "$result_file" ]]; then
  printf '最新测试目录没有 result.json：%s\n' "$runtime_dir" >&2
  exit 2
fi
session_id="$(node -e "const r=require(process.argv[1]);if(!r.sessionId)process.exit(1);process.stdout.write(r.sessionId)" "$result_file")"

mkdir -p "$runtime_dir/home" "$runtime_dir/tmp"
export HOME="$runtime_dir/home"
export TMPDIR="$runtime_dir/tmp"
export PI_CODING_AGENT_DIR="$runtime_dir/pi"
export PI_TASK_DATA_DIR="$runtime_dir/task-data"
export PI_TASK_NEXT_DIST_DIR=".runtime/next-build-$(uname -s)-$(uname -m)-native-v1"
export NPM_CONFIG_USERCONFIG="$repo_dir/.npmrc"
export NODE_ENV=development
export NEXT_TELEMETRY_DISABLED=1
unset MINIMAX_CN_API_KEY MINIMAX_API_KEY PI_PROVIDER PI_MODEL PI_REASONING_LEVEL PI_SESSION_FILE PI_SESSION_ID
"$repo_dir/scripts/ensure-platform-native-deps.sh"

server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

node_modules/.bin/next dev -H 127.0.0.1 -p 30142 >"$runtime_dir/view-server.log" 2>&1 </dev/null &
server_pid=$!
ready='false'
for _ in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:30142/api/tasks?sessionId=$session_id').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready='true'
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    tail -80 "$runtime_dir/view-server.log" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != 'true' ]]; then
  printf '%s\n' 'Pi Task 在 90 秒内未就绪。' >&2
  tail -80 "$runtime_dir/view-server.log" >&2
  exit 1
fi

SESSION_ID="$session_id" node --input-type=module - <<'NODE'
const base = "http://127.0.0.1:30142";
const sessionId = process.env.SESSION_ID;
try {
  const taskResponse = await fetch(`${base}/api/tasks?sessionId=${encodeURIComponent(sessionId)}`);
  const { task } = await taskResponse.json();
  if (task?.title) {
    await fetch(`${base}/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "set_session_name", name: task.title }),
    });
  }
} catch {
  // Naming is cosmetic; do not block visual inspection if it fails.
}
NODE

url="http://127.0.0.1:30142/?session=$session_id"
printf '正在打开：%s\n' "$url"
if [[ "$(uname -s)" == 'Darwin' ]]; then
  open "$url"
else
  printf '%s\n' '请在浏览器中打开以上地址。'
fi
printf '%s\n' '这是只读视觉检查：无需 API Key。检查完成后回到终端按 Ctrl+C 停止服务。'
wait "$server_pid"
