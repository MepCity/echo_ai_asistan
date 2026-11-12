#!/usr/bin/env bash
# Installs Echo on the VM. Run as ubuntu:  bash install.sh
# Safe to run again: existing key, clone and .env values are kept.
set -euo pipefail

REPO="git@github.com:MepCity/echo_ai_asistan.git"
BASE=/opt/echo
APP=$BASE/app
ENV_FILE=$BASE/.env
CONFIG=$BASE/config.json
DEPLOY_KEY="$HOME/.ssh/echo_deploy"
SSH_CMD="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"
GITHUB_ED25519_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nHATA / ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -un)" = root ] && fail "Run as ubuntu, not root (no sudo)."

# --- Wait for first-boot setup ---------------------------------------------------
if command -v cloud-init >/dev/null; then
  say "Waiting for first-boot setup (Docker, firewall) to finish..."
  sudo cloud-init status --wait >/dev/null || true
fi
command -v docker >/dev/null || fail "Docker is not installed yet. Wait 2 minutes and run again."
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
[ -d "$BASE" ] || sudo mkdir -p "$BASE"
[ -w "$BASE" ] || sudo chown "$(id -un):$(id -gn)" "$BASE"

# --- Deploy key + GitHub host key -------------------------------------------------
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$DEPLOY_KEY" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "echo-vm-deploy" -f "$DEPLOY_KEY"
fi
if ! ssh-keygen -F github.com -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then
  KEYS=$(ssh-keyscan -t ed25519 github.com 2>/dev/null)
  FP=$(ssh-keygen -lf - <<<"$KEYS" | awk '{print $2}')
  [ "$FP" = "$GITHUB_ED25519_FP" ] || fail "GitHub host key fingerprint does not match ($FP)."
  echo "$KEYS" >> "$HOME/.ssh/known_hosts"
fi

# --- Clone -------------------------------------------------------------------------
if [ ! -d "$APP/.git" ]; then
  say "Deploy key (add it to the GitHub repo as a READ-ONLY deploy key):"
  echo
  cat "$DEPLOY_KEY.pub"
  echo
  echo "Waiting until GitHub accepts this key (checks every 10 s, Ctrl+C to stop)..."
  until GIT_SSH_COMMAND="$SSH_CMD" git ls-remote "$REPO" >/dev/null 2>&1; do sleep 10; done
  GIT_SSH_COMMAND="$SSH_CMD" git clone "$REPO" "$APP"
fi
git -C "$APP" config core.sshCommand "$SSH_CMD"

# --- .env ----------------------------------------------------------------------------
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/"; }
env_set() {
  case $2 in *"'"*|*$'\n'*) fail "$1 must not contain a quote or a newline." ;; esac
  printf "%s='%s'\n" "$1" "$2" >> "$ENV_FILE"
}
ask_secret() {
  local value=""
  [ -n "$(env_get "$1")" ] && return 0
  while [ -z "$value" ]; do
    read -rsp "$1 (gizli, ekranda gorunmez): " value </dev/tty; echo
  done
  env_set "$1" "$value"
}
ask_plain() {   # name default
  local value=""
  [ -n "$(env_get "$1")" ] && return 0
  read -rp "$1 [$2]: " value </dev/tty
  env_set "$1" "${value:-$2}"
}

say "Settings (saved in $ENV_FILE; asked only once)"
ask_secret WA_ACCESS_TOKEN
ask_secret WA_APP_SECRET
ask_secret MARMARA_TRYPOST_TOKEN
ask_secret MARMARA_TRYPOST_WEBHOOK_SECRET
ask_plain WA_PHONE_NUMBER_ID 1442742612259733
while [ -z "$(env_get YASIR_TRYPOST_USER_ID)" ]; do
  read -rp "YASIR_TRYPOST_USER_ID (production TryPost user UUID): " value </dev/tty
  [ -n "$value" ] && env_set YASIR_TRYPOST_USER_ID "$value"
done
[ -n "$(env_get WA_VERIFY_TOKEN)" ] || env_set WA_VERIFY_TOKEN "$(openssl rand -hex 16)"
if [ -z "$(env_get ECHO_HOST)" ]; then
  IP=$(curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
  [[ $IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Could not find the public IP. Add ECHO_HOST=... to $ENV_FILE and run again."
  ask_plain ECHO_HOST "echo-${IP//./-}.sslip.io"
fi
chmod 600 "$ENV_FILE"
ECHO_HOST=$(env_get ECHO_HOST)

# --- config.json ---------------------------------------------------------------------
if [ ! -f "$CONFIG" ]; then
  cp "$APP/deploy/oracle/config.template.json" "$CONFIG"
  say "$CONFIG created from deploy/oracle/config.template.json"
  echo "To add people later: edit it, then run: bash $APP/deploy/oracle/update.sh"
fi

# --- Start ---------------------------------------------------------------------------
say "Building and starting Echo + Caddy (first build takes a few minutes)"
"${DOCKER[@]}" compose -f "$APP/deploy/oracle/docker-compose.yml" --env-file "$ENV_FILE" up -d --build

say "Waiting for https://$ECHO_HOST/health (HTTPS certificate can take 1-2 minutes)"
ok=""
for _ in $(seq 1 60); do
  if curl -fsS --max-time 10 "https://$ECHO_HOST/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [ -z "$ok" ]; then
  echo "Health check did not pass yet. Logs:"
  "${DOCKER[@]}" compose -f "$APP/deploy/oracle/docker-compose.yml" --env-file "$ENV_FILE" logs --tail 30
  fail "https://$ECHO_HOST/health is not answering."
fi

cat <<EOF

================================================================
 Echo is running:  https://$ECHO_HOST/health

 Meta (WhatsApp > Configuration > Webhook):
   Callback URL : https://$ECHO_HOST/whatsapp
   Verify token : $(env_get WA_VERIFY_TOKEN)
   Subscribe to : messages

 TryPost webhook URL:
   https://$ECHO_HOST/projects/marmara/webhook
================================================================
EOF
