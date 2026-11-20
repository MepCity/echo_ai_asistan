#!/usr/bin/env bash
# Studio gateway (Higgsfield) commands on the VM, as ubuntu:
#   bash /opt/echo/app/deploy/oracle/hermes/studio.sh login     # Higgsfield'e bir kerelik giris
#   bash /opt/echo/app/deploy/oracle/hermes/studio.sh status    # bagli mi, kredi
#   bash /opt/echo/app/deploy/oracle/hermes/studio.sh logs      # studio loglari
set -euo pipefail

COMPOSE_FILE=/opt/echo/app/deploy/oracle/docker-compose.yml
ENV_FILE=/opt/echo/.env
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
# Bir dizi (fonksiyon degil): exec yalnizca gercek komutlari calistirabilir.
COMPOSE=("${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile hermes)
TTY=()
[ -t 0 ] && [ -t 1 ] || TTY=(-T)

case "${1:-}" in
  login) shift; exec "${COMPOSE[@]}" exec "${TTY[@]}" studio node --no-warnings src/studio/login.js "$@" ;;
  status) exec "${COMPOSE[@]}" exec -T studio node --no-warnings src/studio/login.js --status ;;
  logs) shift; exec "${COMPOSE[@]}" logs "${@:---tail=100}" studio ;;
  *) echo "Kullanim: studio.sh login [--reregister] | status | logs [--follow]" >&2; exit 2 ;;
esac
