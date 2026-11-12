#!/usr/bin/env bash
# Creates Echo's WhatsApp message templates (onay_bekliyor, gorus_istegi) in the
# WhatsApp Business Account, skipping ones that already exist. Run on the VM:
#   bash /opt/echo/app/deploy/oracle/create-templates.sh            # create missing ones
#   bash /opt/echo/app/deploy/oracle/create-templates.sh --status   # only show approval status
# Body variables match src/projects/trypost.js: {{1}} project, {{2}} requester,
# {{3}} channel, {{4}} time, {{5}} excerpt. Button order matches Echo's buttons.
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
  local args=(-sS -X "$1" -w '\n%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN"))
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' --data-binary "$3")
  curl "${args[@]}" "$GRAPH/$2"
}

status() {   # name -> "STATUS" or empty
  local response
  response=$(graph GET "$WABA_ID/message_templates?name=$1&fields=name,status,language,category,rejected_reason")
  [ "$(tail -n 1 <<<"$response")" = 200 ] || fail "Could not read templates: $(sed '$d' <<<"$response")"
  sed '$d' <<<"$response" | jq -r --arg n "$1" '[.data[] | select(.name == $n and .language == "tr")][0] // empty
    | "\(.status) \(.category)\(if .rejected_reason and .rejected_reason != "NONE" then " rejected_reason=\(.rejected_reason)" else "" end)"'
}

EXAMPLES='["Marmara AI Sosyal","Yasir","Instagram · marmaraai","20 Kas 2026 18:00","Yapay zeka atölyemiz cuma 18:00’de!"]'

create() {   # name body button1 button2 button3
  local name=$1 body=$2 current payload response
  current=$(status "$name")
  if [ -n "$current" ]; then echo "$name: exists ($current), skipped"; return; fi
  payload=$(jq -n --arg name "$name" --arg body "$body" --argjson ex "$EXAMPLES" \
            --arg b1 "$3" --arg b2 "$4" --arg b3 "$5" '{
    name: $name, language: "tr", category: "UTILITY",
    components: [
      { type: "BODY", text: $body, example: { body_text: [ $ex ] } },
      { type: "BUTTONS", buttons: [ {type:"QUICK_REPLY",text:$b1}, {type:"QUICK_REPLY",text:$b2}, {type:"QUICK_REPLY",text:$b3} ] }
    ] }')
  response=$(graph POST "$WABA_ID/message_templates" "$payload")
  echo "$name: HTTP $(tail -n 1 <<<"$response") $(sed '$d' <<<"$response")"
}

if [ "${1:-}" != "--status" ]; then
  create onay_bekliyor $'📝 {{1}} için onayını bekleyen bir gönderi var.\nOnay isteyen: {{2}}\nKanal: {{3}}\nYayın: {{4}}\n\n"{{5}}"' \
    "Onayla" "Düzeltme iste" "Yorum yaz"
  create gorus_istegi $'👀 {{2}}, {{1}} için görüşünü soruyor.\nKanal: {{3}}\nYayın: {{4}}\n\n"{{5}}"' \
    "Uygun" "Revize gerekli" "Yorum yaz"
  echo
fi
echo "Status (APPROVED = ready to use; review usually takes minutes to a few hours):"
for name in onay_bekliyor gorus_istegi; do
  echo "  $name: $(status "$name" || true)"
done
