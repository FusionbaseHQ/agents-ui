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
agsh_dir="$(cd "$agsh_dir" && pwd -P)"

# Rust can embed absolute dependency/source locations in panic diagnostics.
# Remap the checkout and build user's home so committed sidecars do not expose
# machine-local paths and are reproducible across developer accounts.
cargo_build_release() {
  local triple="$1"
  local -a remap_flags=("--remap-path-prefix=$agsh_dir=/src/agsh")
  local cargo_home="${CARGO_HOME:-}"
  local rustup_home="${RUSTUP_HOME:-}"
  local build_user_home="${HOME:-}"
  if [[ -n "$cargo_home" && "$cargo_home" != "/" ]]; then
    remap_flags+=("--remap-path-prefix=$cargo_home=/cargo-home")
  fi
  if [[ -n "$rustup_home" && "$rustup_home" != "/" ]]; then
    remap_flags+=("--remap-path-prefix=$rustup_home=/rustup-home")
  fi
  if [[ -n "$build_user_home" && "$build_user_home" != "/" ]]; then
    remap_flags+=("--remap-path-prefix=$build_user_home=/build-home")
  fi

  if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
    local encoded="$CARGO_ENCODED_RUSTFLAGS"
    local flag
    for flag in "${remap_flags[@]}"; do
      [[ -z "$encoded" ]] || encoded+=$'\x1f'
      encoded+="$flag"
    done
    (cd "$agsh_dir" && CARGO_ENCODED_RUSTFLAGS="$encoded" cargo build --release -p agsh --target "$triple")
  else
    local rustflags="${RUSTFLAGS:-}"
    local flag
    for flag in "${remap_flags[@]}"; do
      rustflags+="${rustflags:+ }$flag"
    done
    (cd "$agsh_dir" && RUSTFLAGS="$rustflags" cargo build --release -p agsh --target "$triple")
  fi
}

assert_no_machine_paths() {
  local binary="$1"
  local -a machine_roots=(
    "$agsh_dir"
    "${CARGO_HOME:-}"
    "${RUSTUP_HOME:-}"
    "${HOME:-}"
  )
  local root
  for root in "${machine_roots[@]}"; do
    [[ -n "$root" && "$root" != "/" ]] || continue
    if LC_ALL=C grep -aFq -- "$root" "$binary"; then
      echo "Refusing to bundle $binary: embedded machine-local path $root" >&2
      return 1
    fi
  done
}

build_for_triple() {
  local triple="$1"
  # agsh pins its toolchain via rust-toolchain.toml; add the target to it.
  (cd "$agsh_dir" && rustup target add "$triple")
  cargo_build_release "$triple"

  local built="$agsh_dir/target/$triple/release/agsh"
  if [[ ! -f "$built" ]]; then
    echo "Build succeeded but binary not found at $built"
    exit 1
  fi
  assert_no_machine_paths "$built"
  mkdir -p "$bin_dir"
  cp -f "$built" "$bin_dir/agsh-$triple"
  chmod +x "$bin_dir/agsh-$triple"
  echo "Wrote $bin_dir/agsh-$triple"
}

build_for_triple "aarch64-apple-darwin"
build_for_triple "x86_64-apple-darwin"
