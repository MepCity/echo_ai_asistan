#!/usr/bin/env bash
# Prepares the render service (videos for the studio) before docker compose starts it.
# Run by setup-hermes.sh and update.sh as ubuntu; safe to run again:
#   - ECHO_RENDER_TOKEN: a random bearer in /opt/echo/.env (made once, never printed). The studio
#     (env_file) sends it; the render container gets only this one variable (docker-compose.yml).
set -euo pipefail

ECHO_DIR=${RENDER_PREPARE_ECHO_DIR:-/opt/echo}
ECHO_ENV=$ECHO_DIR/.env
[ -f "$ECHO_ENV" ] || { printf '\nHATA: %s yok. Once install.sh calistir.\n' "$ECHO_ENV" >&2; exit 1; }

current=$(sed -n "s/^ECHO_RENDER_TOKEN=//p" "$ECHO_ENV" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/")
if [ -z "$current" ]; then
  printf "ECHO_RENDER_TOKEN='%s'\n" "$(openssl rand -hex 32)" >> "$ECHO_ENV"
  echo "ECHO_RENDER_TOKEN olusturuldu ($ECHO_ENV)."
fi
