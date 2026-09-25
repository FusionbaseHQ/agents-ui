#!/bin/sh
# End-to-end test of the SSH file browser backend against a real sshd in
# Docker (tcsh login shell, noisy .bashrc, ssh://host:port target, scp, and
# recovery of a wedged shared connection via `docker pause`).
#
# Usage: scripts/ssh-e2e/run.sh        (needs Docker; uses 127.0.0.1:2222)
#
# Nothing touches your real ~/.ssh: the test runs with HOME pointed at a
# throwaway directory whose .ssh/config supplies the key and known_hosts.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/agents-ui-ssh-e2e.XXXXXX")
container=agentsui-sshd
image=agentsui-sshd-test

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

mkdir -p "$work/home/.ssh" "$work/build"
ssh-keygen -q -t ed25519 -N "" -f "$work/home/.ssh/id_test"
cp "$here/Dockerfile" "$work/home/.ssh/id_test.pub" "$work/build/"

docker build -q -t "$image" "$work/build" >/dev/null
docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --name "$container" -p 127.0.0.1:2222:22 "$image" >/dev/null

attempt=0
until ssh-keyscan -p 2222 127.0.0.1 >"$work/home/.ssh/known_hosts" 2>/dev/null \
  && [ -s "$work/home/.ssh/known_hosts" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "sshd did not come up" >&2; exit 1; }
  sleep 0.5
done

cat >"$work/home/.ssh/config" <<EOF
Host *
  IdentityFile $work/home/.ssh/id_test
  IdentitiesOnly yes
  UserKnownHostsFile $work/home/.ssh/known_hosts
EOF

cd "$repo/src-tauri"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
HOME="$work/home" \
AGENTS_UI_SSH_E2E=1 \
  cargo test e2e_file_browser_against_real_sshd -- --ignored --nocapture
