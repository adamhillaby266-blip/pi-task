#!/usr/bin/env bash
# Double-clickable upgrade entry point for an already installed Pi Task service.
set -euo pipefail

if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf 'Pi Task 的本机升级器仅适用于 macOS。\n' >&2
  exit 1
fi

printf '此操作会先隔离构建，再短暂重启 Pi Task 后台服务；不会复制或删除 Pi 对话、认证或 Task 数据。\n'
read -r -p '确认当前没有活动 Run 后，输入 UPGRADE 继续：' confirmation
if [[ "$confirmation" != 'UPGRADE' ]]; then
  printf '已取消，未修改服务。\n'
  exit 0
fi

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$package_dir/scripts/upgrade-macos-background-service.sh" --confirm-idle
