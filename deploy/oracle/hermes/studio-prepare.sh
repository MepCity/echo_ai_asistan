#!/usr/bin/env bash
# Prepares the studio gateway (Higgsfield image/audio for Hermes) before docker compose starts it.
# Run by setup-hermes.sh and update.sh as ubuntu; safe to run again:
#   - /opt/echo/brand-kit.md from deploy/oracle/brand-kit.md, only if it does not exist yet
#     (your edits are kept);
#   - the folders the studio shares with Hermes (previews it sends, images people sent:
#     platforms/whatsapp_cloud/media and cache/images);
#   - /data/studio in the echo-data volume, owned by HERMES_UID:HERMES_GID (studio's user);
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
# The VM's copy is never overwritten. When the shipped kit has a newer "brand-kit-version" line
# (top of deploy/oracle/brand-kit.md), say so; a kit without the line counts as version 1.
kit_version() { sed -n 's/.*brand-kit-version: *\([0-9][0-9]*\).*/\1/p' "$1" | head -n 1; }
SHIPPED_KIT_VERSION=$(kit_version "$APP/deploy/oracle/brand-kit.md")
VM_KIT_VERSION=$(kit_version "$BRAND_KIT")
if [ "${SHIPPED_KIT_VERSION:-1}" -gt "${VM_KIT_VERSION:-1}" ]; then
  cat <<NOTE
NOT: Marka kitinin yeni surumu var (sunucudaki surum ${VM_KIT_VERSION:-1}, yeni surum $SHIPPED_KIT_VERSION).
     $BRAND_KIT kendiliginden degistirilmez. Farklara bak:
       diff $BRAND_KIT $APP/deploy/oracle/brand-kit.md
     Kendi duzenlemen yoksa yenisini al (eskisi .bak olarak kalir):
       cp $BRAND_KIT $BRAND_KIT.bak && cp $APP/deploy/oracle/brand-kit.md $BRAND_KIT
NOTE
fi
# Made by install.sh before Echo first starts; checked here since studio mounts it too.
[ -f "$ECHO_DIR/config.json" ] || fail "$ECHO_DIR/config.json dosya olarak yok (klasor ya da eksik). install.sh ile olustur, sonra tekrar calistir."

# Folders the studio shares with Hermes. Made by the VM user before compose mounts them; if
# Docker already made any of them (as root), they are given back to the owner of $HDATA (a
# root-owned media folder would stop Hermes saving the pictures people send). Only these folders
# are touched, never their files or any mode: Hermes keeps them owner-only (cache/images 0700) and
# the studio reads them as the same user (HERMES_UID), so nothing becomes readable by others.
# platforms/whatsapp_cloud/media: where the whatsapp_cloud adapter saves inbound photos and voice
# notes (<media id>.jpg / .ogg), the path Hermes gives the model and the studio opens.
# Parents first, so mkdir works inside a folder Docker made.
for dir in "$HDATA/cache" "$HDATA/cache/generated" "$HDATA/cache/generated/echo-studio" "$HDATA/cache/images" \
           "$HDATA/platforms" "$HDATA/platforms/whatsapp_cloud" "$HDATA/platforms/whatsapp_cloud/media"; do
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

# The studio runs as HERMES_UID and reads Hermes' owner-only media folders: they must be that uid's.
H_UID=$(env_get HERMES_UID "$ECHO_ENV" 2>/dev/null || true); H_UID=${H_UID:-$(id -u)}
for dir in "$HDATA/platforms/whatsapp_cloud/media" "$HDATA/cache/images"; do
  if [ "$(stat -c %u "$dir")" != "$H_UID" ]; then
    echo "UYARI: $dir sahibi uid $(stat -c %u "$dir"), studio uid $H_UID (HERMES_UID, $ECHO_ENV) olarak calisiyor; gonderilen gorselleri okuyamaz (izin yok). HERMES_UID'yi $HDATA sahibinin uid'si yap." >&2
  fi
done
# Hermes uses a legacy whatsapp_cloud/media folder instead when it already has files; it is not mounted.
if [ -n "$(ls -A "$HDATA/whatsapp_cloud/media" 2>/dev/null)" ]; then
  echo "UYARI: $HDATA/whatsapp_cloud/media dolu: Hermes gonderilen gorselleri oraya yaziyor olabilir, studio ise $HDATA/platforms/whatsapp_cloud/media klasorunu okuyor." >&2
fi

# /data/studio in the echo-data volume (studio.db, originals, Higgsfield tokens). The volume is
# shared with the echo service, which runs as the image's node user (uid 1000) and owns /data,
# while studio runs as HERMES_UID:HERMES_GID (the VM user, e.g. 1001). Unless /data/studio is
# made and given to that user, studio crashes with EACCES mkdir '/data/studio'. Only that folder
# is touched (never echo.db*), with a one-off root container, and only when it is not right yet.
# STUDIO_PREPARE_SKIP_DATA=1 skips this (testing without Docker).
if [ -z "${STUDIO_PREPARE_SKIP_DATA:-}" ]; then
  S_UID=$(env_get HERMES_UID "$ECHO_ENV"); S_UID=${S_UID:-$(id -u)}
  S_GID=$(env_get HERMES_GID "$ECHO_ENV"); S_GID=${S_GID:-$(id -g)}
  [[ $S_UID =~ ^[0-9]+$ && $S_GID =~ ^[0-9]+$ ]] || fail "HERMES_UID/HERMES_GID ($ECHO_ENV) sayi olmali."
  if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
  COMPOSE_FILE=$APP/deploy/oracle/docker-compose.yml
  compose() { "${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ECHO_ENV" --profile hermes "$@"; }
  # Project "echo" (name: in the compose file), volume "echo-data".
  mp=$("${DOCKER[@]}" volume inspect echo_echo-data --format '{{.Mountpoint}}' 2>/dev/null || true)
  ok=""
  if [ -n "$mp" ] && as_root test -d "$mp/studio" \
     && [ -z "$(as_root find "$mp/studio" \( ! -uid "$S_UID" -o ! -gid "$S_GID" \) -print -quit)" ]; then
    ok=1
  fi
  if [ -z "$ok" ]; then
    # studio uses echo:local without a build section; build it first if it is missing.
    "${DOCKER[@]}" image inspect echo:local >/dev/null 2>&1 || compose build echo
    compose run --rm --no-deps --user root --entrypoint sh studio -c \
      'mkdir -p /data/studio && chown -R "$0:$1" /data/studio' "$S_UID" "$S_GID" \
      || fail "/data/studio (echo-data) hazirlanamadi."
    echo "/data/studio (echo-data) hazir, sahibi $S_UID:$S_GID."
  fi
fi

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
