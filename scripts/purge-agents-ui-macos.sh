#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Agents UI"
BUNDLE_ID="com.agents-ui.desktop"
KEYCHAIN_ACCOUNT="agents-ui-data-key-v1"

DRY_RUN=0
YES=0
DELETE_APP=0
DELETE_KEYCHAIN=0
INCLUDE_NAME_PATHS=0

usage() {
  cat <<'EOF'
Purge Agents UI (macOS) user data.

Deletes per-user app data for the bundle id `com.agents-ui.desktop`:
- ~/Library/Application Support/…
- ~/Library/Caches/…
- ~/Library/WebKit/…
- ~/Library/HTTPStorages/…
- ~/Library/Logs/…
- ~/Library/Saved Application State/…
- ~/Library/Preferences/…
- /tmp/agents-ui-zellij

Usage:
  scripts/purge-agents-ui-macos.sh [options]

Options:
  -n, --dry-run              Print what would be deleted
  -y, --yes                  Skip the DELETE confirmation prompt
  --delete-app               Also delete /Applications/Agents UI.app (may require sudo)
  --delete-keychain          Also delete the Keychain item used for encrypted data
  --include-name-paths       Also delete name-based paths (e.g. "Agents UI") if present
  --bundle-id <id>           Override bundle id (default: com.agents-ui.desktop)
  --app-name <name>          Override app name (default: Agents UI)
  -h, --help                 Show this help
EOF
}

log() { printf '%s\n' "$*"; }

rm_target() {
  local target="$1"
  if [[ -z "${target}" ]]; then
    return 0
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log "+ rm -rf \"$target\""
  else
    rm -rf "$target"
  fi
}

run_quiet() {
  local cmd=( "$@" )
  if [[ $DRY_RUN -eq 1 ]]; then
    log "+ ${cmd[*]}"
    return 0
  fi
  "${cmd[@]}" >/dev/null 2>&1 || true
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  log "This script is intended for macOS (Darwin)."
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    -y|--yes) YES=1; shift ;;
    --delete-app) DELETE_APP=1; shift ;;
    --delete-keychain) DELETE_KEYCHAIN=1; shift ;;
    --include-name-paths) INCLUDE_NAME_PATHS=1; shift ;;
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    --app-name) APP_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) log "Unknown option: $1"; usage; exit 2 ;;
  esac
done

if [[ -z "$BUNDLE_ID" ]]; then
  log "Missing bundle id."
  exit 2
fi

HOME_DIR="${HOME:-}"
if [[ -z "$HOME_DIR" ]]; then
  log "HOME is not set; cannot safely determine user Library paths."
  exit 2
fi

shopt -s nullglob

targets=(
  "$HOME_DIR/Library/Application Support/$BUNDLE_ID"
  "$HOME_DIR/Library/Caches/$BUNDLE_ID"
  "$HOME_DIR/Library/WebKit/$BUNDLE_ID"
  "$HOME_DIR/Library/HTTPStorages/$BUNDLE_ID"
  "$HOME_DIR/Library/HTTPStorages/$BUNDLE_ID.binarycookies"
  "$HOME_DIR/Library/Logs/$BUNDLE_ID"
  "$HOME_DIR/Library/Saved Application State/$BUNDLE_ID.savedState"
  "$HOME_DIR/Library/Preferences/$BUNDLE_ID.plist"
)

for f in "$HOME_DIR/Library/Preferences/ByHost/$BUNDLE_ID."*.plist; do
  targets+=( "$f" )
done

targets+=( "/tmp/agents-ui-zellij" )

if [[ $INCLUDE_NAME_PATHS -eq 1 ]]; then
  targets+=(
    "$HOME_DIR/Library/Application Support/$APP_NAME"
    "$HOME_DIR/Library/Caches/$APP_NAME"
    "$HOME_DIR/Library/Logs/$APP_NAME"
    "$HOME_DIR/Library/WebKit/$APP_NAME"
    "$HOME_DIR/Library/HTTPStorages/$APP_NAME"
    "$HOME_DIR/Library/Preferences/$APP_NAME.plist"
  )
fi

log "This will permanently delete:"
for t in "${targets[@]}"; do
  log "  - $t"
done
if [[ $DELETE_KEYCHAIN -eq 1 ]]; then
  log "  - Keychain generic password (service: $BUNDLE_ID, account: $KEYCHAIN_ACCOUNT)"
fi
if [[ $DELETE_APP -eq 1 ]]; then
  log "  - /Applications/$APP_NAME.app"
fi
log ""

if [[ $YES -ne 1 ]]; then
  read -r -p "Type DELETE to proceed: " confirm
  if [[ "$confirm" != "DELETE" ]]; then
    log "Aborted."
    exit 1
  fi
fi

# Best-effort quit/kill.
if command -v osascript >/dev/null 2>&1; then
  run_quiet osascript -e "tell application \"$APP_NAME\" to quit"
fi
run_quiet pkill -x "$APP_NAME"

for t in "${targets[@]}"; do
  rm_target "$t"
done

if [[ $DELETE_KEYCHAIN -eq 1 ]]; then
  if command -v security >/dev/null 2>&1; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log "+ security delete-generic-password -a \"$KEYCHAIN_ACCOUNT\" -s \"$BUNDLE_ID\""
    else
      security delete-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$BUNDLE_ID" >/dev/null 2>&1 || true
    fi
  else
    log "warning: `security` not found; skipping Keychain deletion"
  fi
fi

if [[ $DELETE_APP -eq 1 ]]; then
  app_path="/Applications/$APP_NAME.app"
  rm_target "$app_path"
fi

log "Done."

