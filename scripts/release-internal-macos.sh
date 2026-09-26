#!/usr/bin/env bash
#
# release-internal-macos.sh — publish a signed + notarized internal test build
# to the PRIVATE builds repo (only people with access to that repo can see or
# download it). The public repo's releases, and the in-app update checker that
# reads them, are untouched.
#
# Each build of a version gets the next build number: v0.12.0-build.1, -build.2…
# The number is also stamped into the app (About panel: "Version 0.12.0 (2)").
#
# Usage:
#   bash scripts/release-internal-macos.sh             # next build number
#   bash scripts/release-internal-macos.sh 7           # explicit build number
#   BUILDS_REPO=owner/repo bash scripts/release-internal-macos.sh
#
# Needs the same Apple credentials as release-macos.sh, and `gh` logged in with
# write access to the builds repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

REPO="${BUILDS_REPO:-FusionbaseHQ/agents-ui-builds}"
VERSION="$(node -p "require('./package.json').version")"

if [ -n "$(git status --porcelain)" ]; then
  echo "x working tree has uncommitted changes; commit first so the build is traceable" >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ -n "${1:-}" ]; then
  BUILD="$1"
else
  LAST="$(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName' \
    | sed -n "s/^v${VERSION//./\\.}-build\\.\\([0-9][0-9]*\\)$/\\1/p" | sort -n | tail -1)"
  BUILD=$(( ${LAST:-0} + 1 ))
fi
TAG="v${VERSION}-build.${BUILD}"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "x $TAG already exists in $REPO" >&2
  exit 1
fi
echo "> internal build $TAG from $BRANCH @ ${COMMIT:0:10} -> $REPO"

BUILD_NUMBER="$BUILD" bash "$SCRIPT_DIR/release-macos.sh"

shopt -s nullglob
DMGS=( "$ROOT/src-tauri/target/release/bundle/dmg/Agents UI_${VERSION}_"*.dmg )
shopt -u nullglob
DMG="${DMGS[0]}"
ARCH="$(basename "$DMG" .dmg)"; ARCH="${ARCH##*_}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ASSET="$STAGE/Agents-UI_${VERSION}-build.${BUILD}_${ARCH}.dmg"
cp "$DMG" "$ASSET"
SHA256="$(shasum -a 256 "$ASSET" | cut -d' ' -f1)"

NOTES="$STAGE/notes.md"
{
  echo "Internal test build — **Agents UI ${VERSION} (build ${BUILD})**, signed and notarized."
  echo
  echo "- Source: \`FusionbaseHQ/agents-ui\` branch \`${BRANCH}\` @ \`${COMMIT}\`"
  echo "- SHA-256 (${ARCH}.dmg): \`${SHA256}\`"
  echo
  # The changelog section for this version, if present.
  awk -v v="## ${VERSION}" '$0==v{p=1;next} /^## /{if(p)exit} p' CHANGELOG.md
} >"$NOTES"

gh release create "$TAG" "$ASSET" --repo "$REPO" \
  --title "Agents UI ${VERSION} (build ${BUILD})" --notes-file "$NOTES"
echo
echo "OK  $(gh release view "$TAG" --repo "$REPO" --json url --jq .url)"
