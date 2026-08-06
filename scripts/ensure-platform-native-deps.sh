#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ "$(uname -s)" != 'Darwin' ]]; then
  exit 0
fi

case "$(uname -m)" in
  arm64) native_arch='arm64' ;;
  x86_64) native_arch='x64' ;;
  *)
    printf '不支持的 Mac 架构：%s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

pack_dir="$repo_dir/.runtime/native-packages"
mkdir -p "$pack_dir"

install_native_package() {
  local package_name="$1"
  local package_version="$2"
  local target_dir="$3"
  if [[ -f "$target_dir/package.json" ]]; then
    return
  fi

  printf '正在补齐 Mac 原生依赖：%s@%s\n' "$package_name" "$package_version"
  local archive_name
  archive_name="$(npm pack "$package_name@$package_version" --pack-destination "$pack_dir" --silent | tail -n 1)"
  if [[ -z "$archive_name" || ! -f "$pack_dir/$archive_name" ]]; then
    printf '原生依赖下载失败：%s@%s\n' "$package_name" "$package_version" >&2
    exit 1
  fi
  mkdir -p "$target_dir"
  tar -xzf "$pack_dir/$archive_name" -C "$target_dir" --strip-components=1
}

lightning_version="$(node -p "require('./node_modules/lightningcss/package.json').version")"
oxide_version="$(node -p "require('./node_modules/@tailwindcss/oxide/package.json').version")"
install_native_package \
  "lightningcss-darwin-$native_arch" \
  "$lightning_version" \
  "$repo_dir/node_modules/lightningcss-darwin-$native_arch"
install_native_package \
  "@tailwindcss/oxide-darwin-$native_arch" \
  "$oxide_version" \
  "$repo_dir/node_modules/@tailwindcss/oxide-darwin-$native_arch"

node -e "require('lightningcss'); require('@tailwindcss/oxide')" >/dev/null
