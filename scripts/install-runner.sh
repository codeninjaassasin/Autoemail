#!/usr/bin/env bash
# Install a GitHub Actions self-hosted runner for this repo on this VM, as a
# systemd USER service (no sudo; starts at boot because linger is on).
#
#   scripts/install-runner.sh <registration-token>
#
# Get the token (a repo admin only): GitHub → repo Settings → Actions →
# Runners → New self-hosted runner → copy the value after "--token".
# Tokens expire after one hour.
set -euo pipefail

TOKEN="${1:?usage: $0 <registration-token>}"
REPO_URL="${REPO_URL:-https://github.com/codeninjaassasin/Autoemail}"
VERSION="${RUNNER_VERSION:-2.338.2}"
DIR="${RUNNER_DIR:-$HOME/actions-runner-autoemail}"
UNIT="$HOME/.config/systemd/user/actions-runner-autoemail.service"

if [ -f "$DIR/.runner" ]; then
  echo "A runner is already configured in $DIR. Remove it first: cd $DIR && ./config.sh remove --token <token>" >&2
  exit 1
fi

mkdir -p "$DIR"
cd "$DIR"
if [ ! -x ./config.sh ]; then
  echo "Downloading actions runner v$VERSION…"
  curl -fsSL "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz" | tar xz
fi

./config.sh --unattended --replace \
  --url "$REPO_URL" \
  --token "$TOKEN" \
  --name "$(hostname)-autoemail" \
  --labels autoemail \
  --work _work

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=GitHub Actions runner for Autoemail deploys
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=PATH=$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$DIR/run.sh
Restart=always
RestartSec=10
KillMode=process
KillSignal=SIGINT
TimeoutStopSec=5min

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now actions-runner-autoemail.service
systemctl --user --no-pager status actions-runner-autoemail.service | head -5
echo
echo "Runner installed. It shows as Idle under GitHub → Settings → Actions → Runners."
