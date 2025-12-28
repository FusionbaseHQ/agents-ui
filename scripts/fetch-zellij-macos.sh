#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$repo_root/src-tauri/bin"

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "Usage: $0 <zellij-version>"
  echo "Example: $0 0.41.2"
  echo "Example: $0 latest"
  exit 1
fi

tag="$version"
if [[ "$tag" == "latest" ]]; then
  tag="latest"
elif [[ "$tag" != v* ]]; then
  tag="v$tag"
fi

download_and_extract() {
  local triple="$1"

  local candidates=(
    "zellij-${triple}.tar.gz"
    "zellij-${version}-${triple}.tar.gz"
  )

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  local asset=""
  for candidate in "${candidates[@]}"; do
    local url
    if [[ "$tag" == "latest" ]]; then
      url="https://github.com/zellij-org/zellij/releases/latest/download/${candidate}"
    else
      url="https://github.com/zellij-org/zellij/releases/download/${tag}/${candidate}"
    fi
    echo "Downloading $url"
    if curl -fsSL -o "$tmp/$candidate" "$url"; then
      asset="$candidate"
      break
    fi
  done

  if [[ -z "$asset" ]]; then
    echo "Failed to download zellij release asset for $tag ($triple)."
    exit 1
  fi

  tar -xzf "$tmp/$asset" -C "$tmp"

  local zellij_path
  zellij_path="$(find "$tmp" -maxdepth 3 -type f -name zellij -perm -u+x | head -n 1 || true)"
  if [[ -z "$zellij_path" ]]; then
    zellij_path="$(find "$tmp" -maxdepth 4 -type f -name zellij | head -n 1 || true)"
  fi
  if [[ -z "$zellij_path" ]]; then
    echo "Could not find extracted zellij binary in archive."
    exit 1
  fi

  mkdir -p "$bin_dir"
  cp -f "$zellij_path" "$bin_dir/zellij-${triple}"
  chmod +x "$bin_dir/zellij-${triple}"
  echo "Wrote $bin_dir/zellij-${triple}"
}

download_and_extract "aarch64-apple-darwin"
download_and_extract "x86_64-apple-darwin"
