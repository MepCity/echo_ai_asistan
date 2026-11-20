#!/usr/bin/env bash
# Prepares the studio gateway (Higgsfield image/audio for Hermes) before docker compose starts it.
# Run by setup-hermes.sh and update.sh as ubuntu; safe to run again:
#   - /opt/echo/brand-kit.md from deploy/oracle/brand-kit.md, only if it does not exist yet
#     (your edits are kept);
#   - the folders the studio shares with Hermes (previews it sends, images people sent);
#   - ECHO_STUDIO_TOKEN: a random secret in /opt/echo/.env (made once), copied to Hermes' .env
#     so its mcp_servers.studio entry can send it. Never printed.
set -euo pipefail

# Paths can be overridden (only for testing in a temp folder); the defaults are the VM's.
APP=${STUDIO_PREPARE_APP:-/opt/echo/app}
ECHO_DIR=${STUDIO_PREPARE_ECHO_DIR:-/opt/echo}
HDATA=${STUDIO_PREPARE_HDATA:-/opt/hermes/data}
ECHO_ENV=$ECHO_DIR/.env
BRAND_KIT=$ECHO_DIR/brand-kit.md
HENV=$HDATA/.env

fail() { printf '\nHATA: %s\n' "$*" >&2; exit 1; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# If the studio container ever starts before this script, Docker creates a missing bind-mount
# source as an empty root-owned DIRECTORY. An empty one is removed so the file can be made.
if [ -d "$BRAND_KIT" ]; then
  if [ -n "$(ls -A "$BRAND_KIT")" ]; then
    fail "$BRAND_KIT bir dosya olmali ama dolu bir klasor. Icini kontrol edip klasoru kaldir (or. sudo rm -r $BRAND_KIT), sonra tekrar calistir."
  fi
  rmdir "$BRAND_KIT" 2>/dev/null || as_root rmdir "$BRAND_KIT"
  echo "$BRAND_KIT bos bir klasordu (Docker olusturmus); kaldirildi."
fi
if [ ! -e "$BRAND_KIT" ]; then
  # -T: never copy into a directory, even if one appears at that path.
  if [ -w "$ECHO_DIR" ]; then
    cp -T "$APP/deploy/oracle/brand-kit.md" "$BRAND_KIT"
  else
    as_root cp -T "$APP/deploy/oracle/brand-kit.md" "$BRAND_KIT"
    as_root chown "$(id -u):$(id -g)" "$BRAND_KIT"
  fi
  chmod 644 "$BRAND_KIT"
  echo "Marka kiti olusturuldu: $BRAND_KIT (duzenleyebilirsin; guncellemeler uzerine yazmaz)."
fi
[ -f "$BRAND_KIT" ] || fail "$BRAND_KIT normal bir dosya degil; kaldirip tekrar calistir."
# Made by install.sh before Echo first starts; checked here since studio mounts it too.
[ -f "$ECHO_DIR/config.json" ] || fail "$ECHO_DIR/config.json dosya olarak yok (klasor ya da eksik). install.sh ile olustur, sonra tekrar calistir."

# Folders the studio shares with Hermes. Made by the VM user before compose mounts them; if
# Docker already made any of them (as root), they are given back to the owner of $HDATA.
# Parents first, so mkdir works inside a folder Docker made.
for dir in "$HDATA/cache" "$HDATA/cache/generated" "$HDATA/cache/generated/echo-studio" "$HDATA/cache/images"; do
  if [ -d "$dir" ]; then
    if [ "$(stat -c %u:%g "$dir")" != "$(stat -c %u:%g "$HDATA")" ]; then
      as_root chown --reference="$HDATA" "$dir"
      echo "$dir sahibi duzeltildi ($(stat -c %U:%G "$HDATA"))."
    fi
  else
    mkdir "$dir"
  fi
done

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
