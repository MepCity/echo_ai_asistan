#!/usr/bin/env bash
# Sets up Hermes Agent (Nous Research) as the conversational assistant behind Echo's
# WhatsApp number. Run on the VM as ubuntu, after install.sh:
#   bash /opt/echo/app/deploy/oracle/hermes/setup-hermes.sh               # kurulum + girisler
#   bash /opt/echo/app/deploy/oracle/hermes/setup-hermes.sh --skip-login  # sadece ayarlari yenile
# Safe to run again: it re-syncs the WhatsApp secrets from /opt/echo/.env, keeps the
# allowed numbers, logins and your own config.yaml settings.
#
# How it fits: Meta calls only Echo (/whatsapp). Echo forwards what it does not handle
# itself to Hermes at http://hermes:8090/whatsapp/webhook (compose network only, never
# public), signed with the app secret like Meta does. Hermes answers through the
# WhatsApp Cloud API with the same number.
set -euo pipefail

APP=/opt/echo/app
ECHO_ENV=/opt/echo/.env
ECHO_CONFIG=/opt/echo/config.json
COMPOSE_FILE=$APP/deploy/oracle/docker-compose.yml
HERE=$APP/deploy/oracle/hermes
DATA=/opt/hermes/data
HENV=$DATA/.env
ASSISTANT_URL="http://hermes:8090/whatsapp/webhook"
DEFAULT_ALLOWED="905418557902"

SKIP_LOGIN=""
[ "${1:-}" = "--skip-login" ] && SKIP_LOGIN=1

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nHATA: %s\n' "$*" >&2; exit 1; }
ask_yes() {   # question default(E|h) -> 0 for yes
  local answer
  read -rp "$1 [$( [ "$2" = E ] && echo 'E/h' || echo 'e/H' )]: " answer </dev/tty || answer=""
  answer=${answer:-$2}
  [[ $answer =~ ^[EeYy] ]]
}

[ "$(id -un)" = root ] && fail "ubuntu kullanicisiyla calistir (sudo olmadan)."
[ -d "$APP/.git" ] || fail "$APP yok. Once install.sh calistir."
[ -f "$ECHO_ENV" ] || fail "$ECHO_ENV yok. Once install.sh calistir."
[ -f "$ECHO_CONFIG" ] || fail "$ECHO_CONFIG yok. Once install.sh calistir."
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
compose() { "${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ECHO_ENV" --profile hermes "$@"; }
hermes() { compose exec hermes hermes "$@"; }

# --- Tools on the VM -------------------------------------------------------------------
command -v jq >/dev/null || sudo apt-get install -y jq >/dev/null
python3 -c 'import yaml' 2>/dev/null || sudo apt-get install -y python3-yaml >/dev/null

# --- Values from Echo's .env (never printed) -------------------------------------------
echo_get() { sed -n "s/^$1=//p" "$ECHO_ENV" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/"; }
echo_set() { printf "%s='%s'\n" "$1" "$2" >> "$ECHO_ENV"; }
for key in WA_ACCESS_TOKEN WA_APP_SECRET WA_PHONE_NUMBER_ID; do
  [ -n "$(echo_get "$key")" ] || fail "$key $ECHO_ENV icinde yok."
done
# The container's hermes user takes the VM user's ids, so both can use /opt/hermes/data.
[ -n "$(echo_get HERMES_UID)" ] || echo_set HERMES_UID "$(id -u)"
[ -n "$(echo_get HERMES_GID)" ] || echo_set HERMES_GID "$(id -g)"

# --- Hermes home: /opt/hermes/data ------------------------------------------------------
say "Hermes klasoru: $DATA"
[ -d "$DATA" ] || sudo mkdir -p "$DATA"
sudo chown "$(id -u):$(id -g)" /opt/hermes "$DATA"
touch "$HENV" && chmod 600 "$HENV"

henv_get() { sed -n "s/^$1=//p" "$HENV" | tail -n 1; }
henv_set() {   # KEY VALUE: replaces the key, keeps every other line
  case $2 in *$'\n'*|*' '*) fail "$1 bosluk ya da satir sonu iceremez." ;; esac
  local tmp; tmp=$(mktemp "$DATA/.env.XXXXXX")
  grep -v "^$1=" "$HENV" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$HENV"
}

# Synced on every run, so a rotated WhatsApp token reaches Hermes too.
henv_set WHATSAPP_CLOUD_PHONE_NUMBER_ID "$(echo_get WA_PHONE_NUMBER_ID)"
henv_set WHATSAPP_CLOUD_ACCESS_TOKEN "$(echo_get WA_ACCESS_TOKEN)"
henv_set WHATSAPP_CLOUD_APP_SECRET "$(echo_get WA_APP_SECRET)"
henv_set WHATSAPP_CLOUD_API_VERSION v23.0
henv_set WHATSAPP_CLOUD_WEBHOOK_PORT 8090
henv_set WHATSAPP_CLOUD_WEBHOOK_PATH /whatsapp/webhook
# Meta never calls Hermes (Echo does), but the adapter wants a verify token.
[ -n "$(henv_get WHATSAPP_CLOUD_VERIFY_TOKEN)" ] || henv_set WHATSAPP_CLOUD_VERIFY_TOKEN "$(openssl rand -hex 16)"
# Kept once set: add numbers by editing this line (see README).
[ -n "$(henv_get WHATSAPP_CLOUD_ALLOWED_USERS)" ] || henv_set WHATSAPP_CLOUD_ALLOWED_USERS "$DEFAULT_ALLOWED"
[ -n "$(henv_get WHATSAPP_CLOUD_HOME_CHANNEL)" ] || henv_set WHATSAPP_CLOUD_HOME_CHANNEL "$DEFAULT_ALLOWED"
[ -n "$(henv_get HERMES_TIMEZONE)" ] || henv_set HERMES_TIMEZONE Europe/Istanbul
if grep -Eq '^(WHATSAPP_CLOUD_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=(true|1|yes)' "$HENV"; then
  fail "$HENV icinde ALLOW_ALL_USERS acik; kapat (sadece izinli numaralar yazabilmeli)."
fi
echo "WhatsApp ayarlari yazildi (degerler gosterilmez). Izinli numaralar: $(henv_get WHATSAPP_CLOUD_ALLOWED_USERS)"

# --- Persona and config.yaml ---------------------------------------------------------------
if [ ! -f "$DATA/SOUL.md" ] || grep -q 'echo-managed' "$DATA/SOUL.md"; then
  cp "$HERE/SOUL.md" "$DATA/SOUL.md"
  echo "SOUL.md (Echo AI Asistan kimligi) yazildi."
else
  echo "SOUL.md senin duzenledigin haliyle birakildi."
fi
python3 -I "$HERE/configure.py" "$DATA/config.yaml"
echo "config.yaml: saglayici openai-codex (secilen model korunur), TryPost MCP (OAuth, yazma araclari onayli), riskli araclar kapali."

# --- Start Hermes -----------------------------------------------------------------------------
say "Hermes imaji indiriliyor ve baslatiliyor (ilk sefer birkac dakika surebilir)"
compose pull hermes
compose up -d hermes
for _ in $(seq 1 60); do
  if compose exec -T echo wget -qO- http://hermes:8090/health >/dev/null 2>&1; then break; fi
  sleep 3
done
if compose exec -T echo wget -qO- http://hermes:8090/health >/dev/null 2>&1; then
  echo "Hermes WhatsApp adaptoru calisiyor (sadece Echo'nun agindan erisilebilir)."
else
  echo "UYARI: http://hermes:8090/health henuz cevap vermiyor. Son loglar:"
  compose logs --tail 40 hermes || true
fi

# --- Logins (interactive) ---------------------------------------------------------------------
if [ -z "$SKIP_LOGIN" ]; then
  codex_default=E
  grep -q 'openai-codex' "$DATA/auth.json" 2>/dev/null && codex_default=h
  say "1/2 OpenAI Codex girisi (ChatGPT aboneliginle)"
  if [ "$codex_default" = h ]; then echo "Daha once giris yapilmis gorunuyor."; fi
  if ask_yes "Codex girisi simdi yapilsin mi?" "$codex_default"; then
    cat <<'EOF'

  Simdi ekranda bir ADRES ve bir KOD cikacak:
    1. Adresi telefonda ya da bilgisayarda tarayicida ac.
    2. ChatGPT hesabinla giris yap.
    3. Ekrandaki kodu gir ve izni onayla.
  Onaylayinca bu pencere kendiliginden devam eder (en fazla birkac dakika bekler).
  Kod kabul edilmezse: ChatGPT > Ayarlar > Guvenlik altinda Codex icin
  "cihaz kodu ile yetkilendirme" secenegini acip tekrar dene.

EOF
    if hermes auth add openai-codex; then
      cat <<EOF

  Codex girisi tamam. Simdi ChatGPT hesabinin kullanabildigi bir model sec:
    bash $HERE/hermes.sh model
  (Model secilmeden Hermes cevap veremez. Secimin bu kurulum tekrar calistiginda korunur.)

EOF
    else
      echo "UYARI: Codex girisi tamamlanmadi; sonra tekrar: bash $HERE/hermes.sh auth add openai-codex"
    fi
  fi

  mcp_default=E
  [ -f "$DATA/mcp-tokens/trypost.json" ] && mcp_default=h
  say "2/2 TryPost baglantisi (sosyal.marmaraai.com, MCP)"
  if [ "$mcp_default" = h ]; then echo "Daha once baglanmis gorunuyor."; fi
  if ask_yes "TryPost girisi simdi yapilsin mi?" "$mcp_default"; then
    cat <<'EOF'

  TryPost'un MCP sunucusu API anahtari kabul etmiyor; bir kerelik OAuth onayi gerekiyor:
    1. Ekranda cikan uzun "authorize" adresini tarayicida ac.
    2. sosyal.marmaraai.com'a giris yap, Marmara AI calisma alanini sec ve izin ver.
    3. Tarayici sonra "http://127.0.0.1:..../callback?code=..." adresine gidecek ve
       "baglanti kurulamadi" diyecek: bu normal.
    4. O sayfanin adres cubugundaki TAM adresi kopyala, bu pencereye yapistir, Enter'a bas.

EOF
    hermes mcp login trypost || echo "UYARI: TryPost girisi tamamlanmadi; sonra tekrar: bash $HERE/hermes.sh mcp login trypost"
  fi
fi

# --- Config again (Hermes may have migrated it on first start), restart --------------------------
python3 -I "$HERE/configure.py" "$DATA/config.yaml"
compose restart hermes

# --- Echo forwards to Hermes ------------------------------------------------------------------------
say "Echo -> Hermes yonlendirmesi"
if jq -e '.assistant.url' "$ECHO_CONFIG" >/dev/null 2>&1; then
  echo "$ECHO_CONFIG zaten assistant ayari iceriyor: $(jq -c '.assistant' "$ECHO_CONFIG")"
else
  tmp=$(mktemp "$ECHO_CONFIG.XXXXXX")
  jq --arg url "$ASSISTANT_URL" '.assistant = { url: $url, enabled: true }' "$ECHO_CONFIG" > "$tmp"
  chmod --reference="$ECHO_CONFIG" "$tmp" 2>/dev/null || true
  mv "$tmp" "$ECHO_CONFIG"
  echo "$ECHO_CONFIG: assistant -> $ASSISTANT_URL"
fi
compose up -d echo
compose restart echo   # re-reads config.json

cat <<EOF

================================================================
 Hermes hazir. Izinli numaradan WhatsApp'ta numaraya bir mesaj yaz
 (or. "Bu hafta planlanan gonderiler neler?").

 Echo'nun onay/gorus mesajlari ve onlara verilen cevaplar Echo'da kalir;
 geri kalan her sey Hermes'e gider.

 Komutlar:
   Loglar        : bash $HERE/hermes.sh logs --follow
   Codex girisi  : bash $HERE/hermes.sh auth add openai-codex
   TryPost girisi: bash $HERE/hermes.sh mcp login trypost
   Model degistir: bash $HERE/hermes.sh model
   Ayarlari yenile: bash $HERE/setup-hermes.sh --skip-login
================================================================
EOF
