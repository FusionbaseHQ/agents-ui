#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$repo_root/src-tauri/bin"

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "Usage: $0 <nu-version-tag>"
  echo "Example: $0 0.104.0"
  exit 1
fi

download_and_extract() {
  local triple="$1"
  local asset="nu-${version}-${triple}.tar.gz"
  local url="https://github.com/nushell/nushell/releases/download/${version}/${asset}"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "Downloading $url"
  curl -fsSL -o "$tmp/$asset" "$url"
  tar -xzf "$tmp/$asset" -C "$tmp"

  local nu_path
  nu_path="$(find "$tmp" -maxdepth 2 -type f -name nu -perm -u+x | head -n 1 || true)"
  if [[ -z "$nu_path" ]]; then
    nu_path="$(find "$tmp" -maxdepth 3 -type f -name nu | head -n 1 || true)"
  fi
  if [[ -z "$nu_path" ]]; then
    echo "Could not find extracted nu binary in archive."
    exit 1
  fi

  mkdir -p "$bin_dir"
  cp -f "$nu_path" "$bin_dir/nu-${triple}"
  chmod +x "$bin_dir/nu-${triple}"
  echo "Wrote $bin_dir/nu-${triple}"
}

download_and_extract "aarch64-apple-darwin"
download_and_extract "x86_64-apple-darwin"
