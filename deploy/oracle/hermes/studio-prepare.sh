#!/usr/bin/env bash
# Prepares the studio gateway (Higgsfield image/audio for Hermes) before docker compose starts it.
# Run by setup-hermes.sh and update.sh as ubuntu; safe to run again:
#   - /opt/echo/brand-kit.md from deploy/oracle/brand-kit.md, only if it does not exist yet
#     (your edits are kept);
#   - the folders the studio shares with Hermes (previews it sends, images people sent);
#   - ECHO_STUDIO_TOKEN: a random secret in /opt/echo/.env (made once), copied to Hermes' .env
#     so its mcp_servers.studio entry can send it. Never printed.
set -euo pipefail

APP=/opt/echo/app
ECHO_ENV=/opt/echo/.env
BRAND_KIT=/opt/echo/brand-kit.md
HDATA=/opt/hermes/data
HENV=$HDATA/.env

if [ ! -f "$BRAND_KIT" ]; then
  if [ -w /opt/echo ]; then cp "$APP/deploy/oracle/brand-kit.md" "$BRAND_KIT"; else sudo cp "$APP/deploy/oracle/brand-kit.md" "$BRAND_KIT"; sudo chown "$(id -u):$(id -g)" "$BRAND_KIT"; fi
  chmod 644 "$BRAND_KIT"
  echo "Marka kiti olusturuldu: $BRAND_KIT (duzenleyebilirsin; guncellemeler uzerine yazmaz)."
fi

# Created by the VM user before compose mounts them (otherwise Docker makes them as root).
mkdir -p "$HDATA/cache/generated/echo-studio" "$HDATA/cache/images"

env_get() { sed -n "s/^$1=//p" "$2" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/"; }
TOKEN=$(env_get ECHO_STUDIO_TOKEN "$ECHO_ENV")
if [ -z "$TOKEN" ]; then
  TOKEN=$(openssl rand -hex 32)
  printf "ECHO_STUDIO_TOKEN='%s'\n" "$TOKEN" >> "$ECHO_ENV"
  echo "ECHO_STUDIO_TOKEN olusturuldu ($ECHO_ENV)."
fi
if [ -f "$HENV" ] && [ "$(env_get ECHO_STUDIO_TOKEN "$HENV")" != "$TOKEN" ]; then
  tmp=$(mktemp "$HDATA/.env.XXXXXX")
  grep -v '^ECHO_STUDIO_TOKEN=' "$HENV" > "$tmp" || true
  printf 'ECHO_STUDIO_TOKEN=%s\n' "$TOKEN" >> "$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$HENV"
  echo "ECHO_STUDIO_TOKEN Hermes'e kopyalandi."
fi
