#!/usr/bin/env bash
# Pulls the latest code and restarts Echo (and Hermes, once setup-hermes.sh has set it up).
# Run on the VM as ubuntu:  bash /opt/echo/app/deploy/oracle/update.sh
# Also picks up edits to /opt/echo/config.json and /opt/echo/.env (WhatsApp tokens are
# copied to Hermes too).
set -euo pipefail

APP=/opt/echo/app
ENV_FILE=/opt/echo/.env
COMPOSE_FILE=$APP/deploy/oracle/docker-compose.yml
HERMES_ENV=/opt/hermes/data/.env

fail() { printf '\nHATA / ERROR: %s\n' "$*" >&2; exit 1; }
[ -d "$APP/.git" ] || fail "$APP not found. Run install.sh first."
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found. Run install.sh first."
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
PROFILES=()
[ -f "$HERMES_ENV" ] && PROFILES=(--profile hermes)
compose() { "${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "${PROFILES[@]}" "$@"; }

echo "==> git pull"
git -C "$APP" pull --ff-only
echo "==> build and start"
compose up -d --build
compose restart echo   # re-reads config.json

if [ -f "$HERMES_ENV" ]; then
  echo "==> Hermes: new image, settings synced from $ENV_FILE"
  bash "$APP/deploy/oracle/hermes/setup-hermes.sh" --skip-login
fi

ECHO_HOST=$(sed -n "s/^ECHO_HOST=//p" "$ENV_FILE" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/")
echo "==> health: https://$ECHO_HOST/health"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "https://$ECHO_HOST/health"; then echo; echo "OK"; exit 0; fi
  sleep 3
done
compose logs --tail 30
fail "https://$ECHO_HOST/health is not answering."
