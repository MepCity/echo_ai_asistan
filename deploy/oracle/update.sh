#!/usr/bin/env bash
# Pulls the latest code and restarts Echo (and Hermes with the studio gateway, once
# setup-hermes.sh has set them up).
# Run on the VM as ubuntu:  bash /opt/echo/app/deploy/oracle/update.sh
# Also picks up edits to /opt/echo/config.json and /opt/echo/.env (WhatsApp tokens are
# copied to Hermes too).
set -euo pipefail

# In a function, so bash reads the whole file before git pull can change it.
main() {

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

if [ -z "${ECHO_UPDATE_PULLED:-}" ]; then
  echo "==> git pull"
  git -C "$APP" pull --ff-only
  # The pull may have changed this script; run the new copy so its steps (and their order) apply.
  ECHO_UPDATE_PULLED=1 exec bash "$APP/deploy/oracle/update.sh" "$@"
fi
# Before any compose up: with the hermes profile, compose starts studio, and Docker would make
# its missing bind-mount sources (brand-kit.md, shared folders) as root-owned directories.
# Without $HERMES_ENV the profile is off and studio is not started.
if [ -f "$HERMES_ENV" ]; then
  echo "==> studio (Higgsfield) hazirligi"
  bash "$APP/deploy/oracle/hermes/studio-prepare.sh"
fi
echo "==> build and start"
# Hermes is left to setup-hermes.sh below: it pulls the new official image, builds Echo's
# addition on top (faster-whisper, hermes/Dockerfile) and keeps the running Hermes if that fails.
SERVICES=(echo caddy)
[ -f "$HERMES_ENV" ] && SERVICES+=(studio)
compose up -d --build "${SERVICES[@]}"
compose restart echo   # re-reads config.json
if [ -f "$HERMES_ENV" ]; then compose restart studio; fi   # re-reads config.json (studio limits)

if [ -f "$HERMES_ENV" ]; then
  echo "==> Hermes: new image (+ faster-whisper), settings synced from $ENV_FILE"
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
}
main "$@"
