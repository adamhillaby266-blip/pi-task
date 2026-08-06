#!/usr/bin/env bash
# Promote one verified isolated macOS build, then launch it against shared Pi data.
set -euo pipefail

usage() {
  printf '用法：%s --confirm-idle <E2-runtime-directory>\n' "$(basename "$0")" >&2
  printf '示例：%s --confirm-idle .runtime/macos-local-build-20260805-232410\n' "$(basename "$0")" >&2
}

if [[ "${1:-}" != "--confirm-idle" || $# -ne 2 ]]; then
  usage
  exit 1
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '此 E3 runner 只能在 macOS 执行；当前平台为 %s。\n' "$(uname -s)" >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
runtime_arg="$2"
case "$(uname -m)" in
  arm64) expected_arch='arm64' ;;
  x86_64) expected_arch='x64' ;;
  *)
    printf '不支持的 Mac 架构：%s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

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
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Git 工作树不干净；为保证构建与源码对应，E3 不会提升产物。请先提交或暂存当前改动。\n' >&2
  exit 1
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:30142 -sTCP:LISTEN >/dev/null 2>&1; then
  printf '端口 30142 已有服务监听。请先停止现有 Pi Task，再提升构建，避免覆盖运行中的生成目录。\n' >&2
  exit 1
fi

runtime_dir="$(node - "$repo_dir" "$runtime_arg" <<'NODE'
const { resolve, sep } = require("node:path");
const [root, value] = process.argv.slice(2);
const runtime = resolve(root, value);
const allowed = `${resolve(root, ".runtime")}${sep}`;
if (!runtime.startsWith(allowed)) {
  console.error("E2 runtime 必须位于项目 .runtime 目录内。");
  process.exit(1);
}
process.stdout.write(runtime);
NODE
)"
result_file="$runtime_dir/result.json"
if [[ ! -f "$result_file" ]]; then
  printf '找不到 E2 结果文件：%s\n' "$result_file" >&2
  exit 1
fi

candidate_dir="$(node - "$repo_dir" "$runtime_dir" "$result_file" "$expected_arch" <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const { resolve, sep } = require("node:path");
const [root, runtime, resultFile, expectedArch] = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
let result;
try { result = JSON.parse(readFileSync(resultFile, "utf8")); } catch { fail("E2 result.json 不是有效 JSON。"); }
if (result.platform !== "darwin") fail(`E2 不是 macOS 构建：${String(result.platform)}`);
if (result.arch !== expectedArch) fail(`E2 架构与当前 Mac 不一致：${String(result.arch)} != ${expectedArch}`);
if (result.pageStatus !== 200) fail(`E2 页面冒烟未通过：${String(result.pageStatus)}`);
if (result.auth !== "absent" && result.auth !== "{}") fail("E2 隔离认证状态不符合预期。");
if (result.promotedToDefaultDist !== false) fail("此 E2 产物已被提升，拒绝重复使用。");
if (typeof result.distDir !== "string" || !result.distDir) fail("E2 result.json 缺少 distDir。");
if (resolve(result.runtime || "") !== resolve(runtime)) fail("E2 runtime 与 result.json 不一致。");
const candidate = resolve(root, result.distDir);
const allowed = `${resolve(root, ".runtime")}${sep}`;
if (!candidate.startsWith(allowed) || !existsSync(candidate)) fail("E2 构建产物不在允许的 .runtime 目录内。");
process.stdout.write(candidate);
NODE
)"

for required in "$candidate_dir/BUILD_ID" "$candidate_dir/server" "$candidate_dir/static"; do
  if [[ ! -e "$required" ]]; then
    printf 'E2 构建产物不完整：%s\n' "$required" >&2
    exit 1
  fi
done

# The caller has confirmed that no Pi Task Run is active. This script does not
# inspect or back up ~/.pi/agent or ~/.pi-task; it only changes generated code.
stamp="$(date +%Y%m%d-%H%M%S)"
previous_dist="$repo_dir/.runtime/macos-local-previous-next-$stamp"
default_dist="$repo_dir/.next"
previous_moved=0
promoted=0
previous_reference=""
restore_previous_dist() {
  if [[ "$promoted" == 0 && "$previous_moved" == 1 && ! -e "$default_dist" && -e "$previous_dist" ]]; then
    mv "$previous_dist" "$default_dist"
  fi
}
trap restore_previous_dist EXIT
trap 'restore_previous_dist; exit 130' INT TERM

if [[ -e "$default_dist" ]]; then
  mv "$default_dist" "$previous_dist"
  previous_moved=1
  previous_reference="$previous_dist"
fi
mv "$candidate_dir" "$default_dist"
# E2 deliberately builds below .runtime; Next typegen files embed that staging
# location and are not needed by next start after promotion.
rm -rf "$default_dist/types" "$default_dist/dev/types"
promoted=1
trap - EXIT INT TERM

build_id="$(tr -d '[:space:]' < "$default_dist/BUILD_ID")"
head_commit="$(git rev-parse HEAD)"
export PI_TASK_MACOS_PROMOTION_RESULT="$runtime_dir/promotion.json"
export PI_TASK_MACOS_PROMOTION_PREVIOUS="$previous_reference"
export PI_TASK_MACOS_PROMOTION_BUILD_ID="$build_id"
export PI_TASK_MACOS_PROMOTION_HEAD="$head_commit"
node - <<'NODE'
const { writeFileSync } = require("node:fs");
const result = {
  sourceHead: process.env.PI_TASK_MACOS_PROMOTION_HEAD,
  previousDist: process.env.PI_TASK_MACOS_PROMOTION_PREVIOUS || null,
  promotedDist: ".next",
  buildId: process.env.PI_TASK_MACOS_PROMOTION_BUILD_ID,
  sharedData: {
    piAgent: "~/.pi/agent",
    taskData: "~/.pi-task",
  },
  launchRequested: true,
};
writeFileSync(process.env.PI_TASK_MACOS_PROMOTION_RESULT, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
NODE

if [[ -n "$previous_reference" ]]; then
  printf '已提升已验证构建。旧 .next 已备份到：%s\n' "$previous_reference"
else
  printf '已提升已验证构建。此前没有 .next 生成目录可备份。\n'
fi
printf '现在将以共享 Pi 数据启动。不会发送模型提示词；关闭此终端或按 Control-C 可停止服务。\n'
exec "$repo_dir/bin/pi-task-macos.command"
