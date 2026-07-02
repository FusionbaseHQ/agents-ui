#!/usr/bin/env bash
set -euo pipefail

# Builds the agsh shell from a local checkout and drops the binaries into
# src-tauri/bin/agsh-<triple>, where Tauri's externalBin picks them up
# (same layout as the fetched nu-*/zellij-* sidecars).
#
# Usage: scripts/build-agsh-macos.sh [path-to-agsh-checkout]
#        AGSH_DIR=/path/to/agsh scripts/build-agsh-macos.sh

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$repo_root/src-tauri/bin"
agsh_dir="${AGSH_DIR:-${1:-$repo_root/../agsh}}"

if [[ ! -f "$agsh_dir/Cargo.toml" ]]; then
  echo "agsh checkout not found at: $agsh_dir"
  echo "Pass the path as an argument or set AGSH_DIR."
  exit 1
fi

build_for_triple() {
  local triple="$1"
  # agsh pins its toolchain via rust-toolchain.toml; add the target to it.
  (cd "$agsh_dir" && rustup target add "$triple")
  (cd "$agsh_dir" && cargo build --release -p agsh --target "$triple")

  local built="$agsh_dir/target/$triple/release/agsh"
  if [[ ! -f "$built" ]]; then
    echo "Build succeeded but binary not found at $built"
    exit 1
  fi
  mkdir -p "$bin_dir"
  cp -f "$built" "$bin_dir/agsh-$triple"
  chmod +x "$bin_dir/agsh-$triple"
  echo "Wrote $bin_dir/agsh-$triple"
}

build_for_triple "aarch64-apple-darwin"
build_for_triple "x86_64-apple-darwin"
