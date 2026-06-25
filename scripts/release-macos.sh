#!/usr/bin/env bash
#
# release-macos.sh — produce a fully signed, notarized & stapled macOS release.
#
# Why this exists: `tauri build` signs the .app, notarizes + staples it, and
# signs the .dmg — but it does NOT notarize or staple the .dmg itself. A
# downloaded dmg gets its own Gatekeeper check, so without this it shows users
# an "Apple cannot check it for malicious software" warning. This script runs
# the build and then performs the missing dmg notarization + staple, and
# verifies the whole bundle.
#
# Credentials are read from the environment, or from a git-ignored .env at the
# repo root (see .env.example). Provide ONE notarization route:
#   * App Store Connect API key: APPLE_API_KEY_PATH, APPLE_API_KEY, APPLE_API_ISSUER
#   * Apple ID + app password:   APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
# Plus APPLE_SIGNING_IDENTITY for the build's own code-signing.
#
# Usage:
#   bash scripts/release-macos.sh                # build + notarize dmg + verify
#   bash scripts/release-macos.sh --skip-build   # notarize/staple an existing dmg only
#
set -euo pipefail

# Put the system tools first so the real /usr/bin/xattr is used during bundling.
# A conda/anaconda `xattr` earlier on PATH lacks -r and makes `tauri build` fail
# with "failed to remove extra attributes from app bundle: failed to run xattr".
export PATH="/usr/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- load .env (git-ignored) if present -------------------------------------
if [ -f "$ROOT/.env" ]; then
  echo "> loading credentials from .env"
  set -a; . "$ROOT/.env"; set +a
fi

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

VERSION="$(node -p "require('./package.json').version")"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

# --- 1) build (Tauri signs + notarizes + staples the app, signs the dmg) -----
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "> npm run tauri build  (v$VERSION)"
  npm run tauri build
else
  echo "> --skip-build: notarizing the existing dmg"
fi

# --- locate this version's dmg ----------------------------------------------
shopt -s nullglob
DMGS=( "$DMG_DIR/Agents UI_${VERSION}_"*.dmg )
shopt -u nullglob
if [ "${#DMGS[@]}" -eq 0 ]; then
  echo "x no dmg matching 'Agents UI_${VERSION}_*.dmg' in $DMG_DIR" >&2
  exit 1
fi
DMG="${DMGS[0]}"
echo "> dmg: $DMG"

# --- 2) pick notarization credentials ---------------------------------------
NOTARY_ARGS=()
if [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  echo "> notarizing via App Store Connect API key"
  NOTARY_ARGS=( --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" )
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "> notarizing via Apple ID + app-specific password"
  NOTARY_ARGS=( --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" )
else
  echo "x no notarization credentials found (set them in the environment or .env)." >&2
  echo "  route A: APPLE_API_KEY_PATH + APPLE_API_KEY + APPLE_API_ISSUER" >&2
  echo "  route B: APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID" >&2
  exit 1
fi

# --- 3) submit + wait, fail loudly if not Accepted --------------------------
echo "> submitting dmg to Apple notary service (waiting for result)..."
SUBMIT_OUT="$(xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait 2>&1)"
echo "$SUBMIT_OUT"
if ! grep -q "status: Accepted" <<<"$SUBMIT_OUT"; then
  echo "x notarization did not reach 'Accepted'." >&2
  SID="$(grep -m1 -Eo '[0-9a-f]{8}-[0-9a-f-]{27}' <<<"$SUBMIT_OUT" || true)"
  if [ -n "$SID" ]; then
    echo "-- notary log for $SID --" >&2
    xcrun notarytool log "$SID" "${NOTARY_ARGS[@]}" >&2 || true
  fi
  exit 1
fi

# --- 4) staple + verify ------------------------------------------------------
echo "> stapling ticket to dmg..."
xcrun stapler staple "$DMG"

echo "> verifying..."
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"

echo
echo "OK  Release ready — notarized + stapled:"
echo "    $DMG"
