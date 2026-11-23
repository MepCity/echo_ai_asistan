#!/usr/bin/env bash
# Creates Echo's WhatsApp message templates (onay_bekliyor, gorus_istegi,
# yeni_etkilesim, etkilesim_ozeti and their "_bilgi" variants with only the
# read button, for people who may not reply) in the WhatsApp Business Account, skipping
# ones that already exist. Run on the VM:
#   bash /opt/echo/app/deploy/oracle/create-templates.sh            # create missing ones
#   bash /opt/echo/app/deploy/oracle/create-templates.sh --status   # only show approval status
# Body variables match src/projects/trypost.js: {{1}} project, {{2}} requester,
# {{3}} channel, {{4}} time, {{5}} excerpt. Social inbox (src/projects/trypost-inbox.js):
# yeni_etkilesim {{1}} platform, {{2}} kind (yorum/mesaj), {{3}} "@author: text";
# etkilesim_ozeti {{1}} count, {{2}} channels. Button order matches Echo's buttons.
#
# v2 (onay_talebi, etkilesim_bildirimi, etkilesim_bildirimi_bilgi,
# etkilesim_sayisi_bilgi): Meta approved onay_bekliyor, yeni_etkilesim,
# yeni_etkilesim_bilgi and etkilesim_ozeti_bilgi as MARKETING, and an approved
# template's category cannot change. The v2 ones have the same variables and
# buttons, worded as account notifications (who asked for what, why you get
# it, which reply is expected) with neutral examples. The old ones stay as they
# are; switch with config.json "templates" once the new ones are APPROVED UTILITY.
# No allow_category_change: since 9 Apr 2025 Meta ignores it and approves a
# template it sees as marketing as MARKETING instead of rejecting it
# (developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization).
set -euo pipefail

ENV_FILE=/opt/echo/.env
WABA_ID="${WABA_ID:-1114674484636272}"
GRAPH="https://graph.facebook.com/v23.0"

fail() { printf '\nHATA / ERROR: %s\n' "$*" >&2; exit 1; }
command -v jq >/dev/null || sudo apt-get install -y jq >/dev/null
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found. Run install.sh first."
TOKEN=$(sed -n "s/^WA_ACCESS_TOKEN=//p" "$ENV_FILE" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/")
[ -n "$TOKEN" ] || fail "WA_ACCESS_TOKEN missing in $ENV_FILE."

# graph METHOD PATH [JSON_BODY] -> prints body, then the HTTP status on the last line
graph() {
  # The token header is read from a process substitution opened by curl's own command line,
  # so it never shows in `ps` and the descriptor is still open when curl reads it.
  local args=(-sS -X "$1" -w '\n%{http_code}')
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' --data-binary "$3")
  curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$GRAPH/$2"
}

status() {   # name -> "STATUS" or empty
  local response
  response=$(graph GET "$WABA_ID/message_templates?name=$1&fields=name,status,language,category,rejected_reason")
  [ "$(tail -n 1 <<<"$response")" = 200 ] || fail "Could not read templates: $(sed '$d' <<<"$response")"
  sed '$d' <<<"$response" | jq -r --arg n "$1" '[.data[] | select(.name == $n and .language == "tr")][0] // empty
    | "\(.status) \(.category)\(if .rejected_reason and .rejected_reason != "NONE" then " rejected_reason=\(.rejected_reason)" else "" end)"'
}

EXAMPLES='["Marmara AI Sosyal","Yasir","Instagram · marmaraai","20 Kas 2026 18:00","Yapay zeka atölyemiz cuma 18:00’de!"]'
INBOX_EXAMPLES='["Instagram","yorum","@ali: Etkinlik ne zaman?"]'
DIGEST_EXAMPLES='["7","Instagram (4), X (3)"]'
# Neutral examples for the v2 templates (no event or promotional wording).
EXAMPLES_V2='["Marmara AI Sosyal","Yasir","Instagram · marmaraai","25 Kas 2026 18:00","Haftalık toplantı notlarının özeti"]'
INBOX_EXAMPLES_V2='["Instagram","yorum","@ali: Toplantı saati değişti mi?"]'

create() {   # name body examples_json button...
  local name=$1 body=$2 examples=$3 current payload response buttons
  shift 3
  current=$(status "$name")
  if [ -n "$current" ]; then echo "$name: exists ($current), skipped"; return; fi
  buttons=$(printf '%s\n' "$@" | jq -R '{type: "QUICK_REPLY", text: .}' | jq -s .)
  payload=$(jq -n --arg name "$name" --arg body "$body" --argjson ex "$examples" --argjson buttons "$buttons" '{
    name: $name, language: "tr", category: "UTILITY",
    components: [
      { type: "BODY", text: $body, example: { body_text: [ $ex ] } },
      { type: "BUTTONS", buttons: $buttons }
    ] }')
  response=$(graph POST "$WABA_ID/message_templates" "$payload")
  echo "$name: HTTP $(tail -n 1 <<<"$response") $(sed '$d' <<<"$response")"
}

if [ "${1:-}" != "--status" ]; then
  create onay_bekliyor $'📝 {{1}} için onayını bekleyen bir gönderi var.\nOnay isteyen: {{2}}\nKanal: {{3}}\nYayın: {{4}}\n\n"{{5}}"' \
    "$EXAMPLES" "Onayla" "Düzeltme iste" "Yorum yaz"
  create gorus_istegi $'👀 {{2}}, {{1}} projesindeki bir gönderi için senin görüşünü soruyor.\nKanal: {{3}}\nPlanlanan yayın zamanı: {{4}}\n\nGönderi metni:\n"{{5}}"\n\nGörüşünü aşağıdaki butonlarla ya da bu mesaja yanıt yazarak iletebilirsin.' \
    "$EXAMPLES" "Uygun" "Revize gerekli" "Yorum yaz"
  create yeni_etkilesim $'📥 {{1}} üzerinde yeni bir {{2}} var:\n"{{3}}"\n\nCevaplamak ya da okundu olarak işaretlemek için aşağıdaki butonları kullanabilirsin.' \
    "$INBOX_EXAMPLES" "Cevapla" "Hermes'e bırak" "Okundu"
  create etkilesim_ozeti $'📥 Sosyal medya hesaplarında {{1}} yeni etkileşim var.\nKanallar: {{2}}\n\nHermes\'e bırakabilir ya da hepsini okundu olarak işaretleyebilirsin.' \
    "$DIGEST_EXAMPLES" "Hermes'e bırak" "Hepsi okundu"
  create yeni_etkilesim_bilgi $'📥 {{1}} üzerinde yeni bir {{2}} var:\n"{{3}}"\n\nAyrıntılar TryPost panelinde.' \
    "$INBOX_EXAMPLES" "Okundu"
  create etkilesim_ozeti_bilgi $'📥 Sosyal medya hesaplarında {{1}} yeni etkileşim var.\nKanallar: {{2}}\n\nAyrıntılar TryPost panelinde.' \
    "$DIGEST_EXAMPLES" "Hepsi okundu"
  # v2: same variables and button order as onay_bekliyor, yeni_etkilesim, yeni_etkilesim_bilgi, etkilesim_ozeti_bilgi.
  create onay_talebi $'📝 {{2}}, {{1}} projesinde hazırladığı bir gönderi için senin yayın onayını istiyor.\nKanal: {{3}}\nPlanlanan yayın zamanı: {{4}}\n\nGönderi metni:\n"{{5}}"\n\nBu isteği gönderinin onaylayıcısı olduğun için alıyorsun. Onaylamak, düzeltme istemek ya da yorum yazmak için aşağıdaki butonları kullanabilir veya bu mesaja yanıt yazabilirsin.' \
    "$EXAMPLES_V2" "Onayla" "Düzeltme iste" "Yorum yaz"
  create etkilesim_bildirimi $'📥 Ekibinin yönettiği {{1}} hesabına yeni bir {{2}} geldi.\n\nGelen içerik:\n"{{3}}"\n\nBu bildirimi hesabın gelen kutusunu yöneten ekipte olduğun için alıyorsun. Cevaplamak, cevabı Hermes\'e bırakmak ya da okundu olarak işaretlemek için aşağıdaki butonları kullanabilirsin.' \
    "$INBOX_EXAMPLES_V2" "Cevapla" "Hermes'e bırak" "Okundu"
  create etkilesim_bildirimi_bilgi $'📥 Ekibinin yönettiği {{1}} hesabına yeni bir {{2}} geldi.\n\nGelen içerik:\n"{{3}}"\n\nBu bilgilendirmeyi hesabın gelen kutusunu takip eden ekipte olduğun için alıyorsun. İnceledikten sonra okundu olarak işaretlemek için aşağıdaki butonu kullanabilirsin.' \
    "$INBOX_EXAMPLES_V2" "Okundu"
  create etkilesim_sayisi_bilgi $'📥 Ekibinin yönettiği sosyal medya hesaplarına {{1}} yeni yorum ve mesaj geldi.\nHesaplara göre dağılım: {{2}}\n\nBu bilgilendirmeyi hesapların gelen kutusunu takip eden ekipte olduğun için alıyorsun. İnceledikten sonra hepsini okundu olarak işaretlemek için aşağıdaki butonu kullanabilirsin.' \
    "$DIGEST_EXAMPLES" "Hepsi okundu"
  echo
fi
echo "Status (APPROVED = ready to use; review usually takes minutes to a few hours):"
show() { local s; s=$(status "$1" || true); echo "  $1: ${s:-yok / not found}"; }
echo " v1:"; for name in onay_bekliyor gorus_istegi yeni_etkilesim etkilesim_ozeti yeni_etkilesim_bilgi etkilesim_ozeti_bilgi; do show "$name"; done
echo " v2 (switch in config.json only to the ones APPROVED UTILITY):"
for name in onay_talebi etkilesim_bildirimi etkilesim_bildirimi_bilgi etkilesim_sayisi_bilgi; do show "$name"; done
# Echo uses "<approval>_gorsel" / "_video" (and the same for feedback) for posts with media unless
# config.json sets approvalImage / approvalVideo / feedbackImage / feedbackVideo; this script does not create them.
echo " media variants Echo looks up by default:"
for name in onay_bekliyor_gorsel onay_bekliyor_video gorus_istegi_gorsel gorus_istegi_video; do show "$name"; done
