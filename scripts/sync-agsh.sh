#!/usr/bin/env bash
set -euo pipefail

# Syncs the bundled agsh sidecars from the local checkout. Wired into
# tauri.conf.json so `tauri dev` and `tauri build` always pick up the latest
# agsh from AGSH_DIR (default: ../agsh):
#
#   sync-agsh.sh dev    — build the native triple only; on failure WARN and
#                         continue with the committed sidecars (a broken agsh
#                         WIP shouldn't block desktop dev).
#   sync-agsh.sh build  — full build of both triples via build-agsh-macos.sh;
#                         failures abort the bundle (a release must not ship
#                         silently-stale sidecars).
#
# Machines without an agsh checkout (CI, other contributors) skip silently and
# use the committed binaries. Cargo's incremental build makes the up-to-date
# case cost ~a second.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$repo_root/src-tauri/bin"
agsh_dir="${AGSH_DIR:-$repo_root/../agsh}"
mode="${1:-dev}"

if [[ ! -f "$agsh_dir/Cargo.toml" ]]; then
  echo "sync-agsh: no agsh checkout at $agsh_dir — using committed sidecars"
  exit 0
fi
agsh_dir="$(cd "$agsh_dir" && pwd -P)"

if [[ "$mode" == "build" ]]; then
  echo "sync-agsh: full sidecar rebuild from $agsh_dir"
  exec "$repo_root/scripts/build-agsh-macos.sh" "$agsh_dir"
fi

# Dev: native triple only, best-effort.
case "$(uname -m)" in
  arm64) triple="aarch64-apple-darwin" ;;
  *) triple="x86_64-apple-darwin" ;;
esac

# Match release builds: keep developer-specific source paths out of the
# sidecar that the dev sync may copy into the repository.
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
      echo "Refusing to sync $binary: embedded machine-local path $root" >&2
      return 1
    fi
  done
}

sync_dev() {
  cargo_build_release "$triple"
  local built="$agsh_dir/target/$triple/release/agsh"
  [[ -f "$built" ]] || return 1
  assert_no_machine_paths "$built"
  local dest="$bin_dir/agsh-$triple"
  if cmp -s "$built" "$dest" 2>/dev/null; then
    echo "sync-agsh: $triple sidecar already up to date"
  else
    mkdir -p "$bin_dir"
    cp -f "$built" "$dest"
    chmod +x "$dest"
    echo "sync-agsh: updated $dest"
  fi
}

if ! sync_dev; then
  echo "sync-agsh: WARNING — agsh build failed; continuing with the committed sidecar" >&2
fi
exit 0
