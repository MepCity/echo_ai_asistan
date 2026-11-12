#!/usr/bin/env bash
# Runs a Hermes CLI command inside the running hermes container. On the VM, as ubuntu:
#   bash /opt/echo/app/deploy/oracle/hermes/hermes.sh auth add openai-codex   # Codex girisi
#   bash /opt/echo/app/deploy/oracle/hermes/hermes.sh mcp login trypost       # TryPost baglantisi
#   bash /opt/echo/app/deploy/oracle/hermes/hermes.sh logs --follow            # Hermes loglari
#   bash /opt/echo/app/deploy/oracle/hermes/hermes.sh doctor
set -euo pipefail

COMPOSE_FILE=/opt/echo/app/deploy/oracle/docker-compose.yml
ENV_FILE=/opt/echo/.env
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
TTY=()
[ -t 0 ] && [ -t 1 ] || TTY=(-T)
exec "${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile hermes exec "${TTY[@]}" hermes hermes "$@"
