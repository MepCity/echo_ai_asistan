# Echo

Echo is a small WhatsApp assistant service. Projects send it events over signed
webhooks; Echo asks the right people on WhatsApp, and writes their answers back
to the project through its API. One WhatsApp number serves every project.

```
TryPost ──(signed webhook)──▶ Echo ──▶ WhatsApp Cloud API ──▶ people
   ▲                           │
   └──(API: approve/reject/notes)◀── button taps and typed replies
```

## Assistant behind Echo (optional)

With `"assistant": { "url": "http://hermes:8090/whatsapp/webhook", "enabled": true }`
in the config, a message from a known person that Echo does not handle (no Echo
button, no open note session, no quote-reply to a request or its prompt, not
"iptal") goes to a conversational assistant ([Hermes Agent](https://hermes-agent.nousresearch.com)'s
WhatsApp Cloud adapter) instead of the help reply. Echo forwards it as a WhatsApp
webhook holding just that message (Meta's own `entry/changes/value`, with
`metadata` and `contacts`), signed `X-Hub-Signature-256` with the app secret, so
the assistant's signature check passes. The assistant answers through the Cloud
API with the same number. Delivery statuses of messages Echo did not send are
forwarded too. Unknown numbers are never forwarded.

Forwarding uses the inbox: in order per person, retried on network errors, 429
and 5xx (15 s, 1 min, 5 min, 15 min); the person gets one "Asistana şu an
ulaşamıyorum" message while it waits and "Asistan şu an yanıt veremiyor" if it
finally fails (or the assistant refuses it, e.g. a bad signature). Statuses wait
in the `forwards` table with the same backoff and are dropped silently after it.
Without `assistant` (or with `"enabled": false`) Echo keeps its help reply.

```
Meta ──▶ Echo /whatsapp ──▶ Echo's own flows (TryPost approvals, notes)
                    └──────▶ Hermes (http://hermes:8090, private) ──▶ WhatsApp Cloud API
```

## What it does for TryPost

| TryPost event              | Echo sends                                            | Answers                                        |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `post.approval_requested`  | every approver except the requester                   | Onayla · Düzeltme iste (+note → reject) · Yorum |
| `post.feedback_requested`  | the people chosen in "Görüş iste"                     | Uygun · Revize gerekli (+note) · Yorum          |
| `post.approved` / `rejected` | the requester and other approvers, only inside the 24h window | –                                   |

Every answer becomes a note on the post. A reply to a message whose content has
changed since is not applied; Echo sends the new version instead. A failed
delivery is noted on the post.

A typed message goes to the request it quotes (a quote-reply to the request, or
to Echo's "Yorumunu yaz…" prompt about it). Without a quote it goes to the open
note session ("Yorum yaz" / "Düzeltme iste"); a new tap replaces the session, and
the prompt names the content it is for. With neither, Echo asks the person to
quote-reply; it never guesses.

## Contract with TryPost

- Webhook payload and API post resource carry `data.content_version`, TryPost's
  hash of content, media and schedule. Echo stores the version it showed.
- `POST /api/posts/{id}/approve` and `/reject` get
  `{"request_id": "<id>", "expected_version": "<content_version>"}`.
  - `request_id` (≤100 chars, `^[A-Za-z0-9:._-]+$`) is the idempotency key of
    one decision: `echo-<project>-<outbox id>-<person id>-<approve|reject>-<start time base36><4 hex>`,
    e.g. `echo-marmara-12-yasir-approve-mhu5l4w0a3f9`. Echo makes it when the
    decision starts, stores it on the decision row and sends the same id on
    every retry. TryPost records it in the transaction that applies the
    decision, and only then.
  - **200** `{"data": ..., "replayed": false}`: applied now. **200** with
    `"replayed": true`: this request_id was already applied with this action
    (even if the post is no longer pending or its version moved since).
  - **409** `{"error": "request_id_conflict"}`: the id was used for the other
    action. Echo logs it, drops the decision and points the person to the panel.
  - **409** `{"error": "version_mismatch", "content_version": "<current>"}`: the
    content changed. Echo applies nothing; it sends the current version, or, if
    the post was decided meanwhile, says someone else decided.
  - **422** `{"error": "not_pending"}`: someone else decided. Echo says so
    ("başka biri karar vermiş") and adds no note.
  - Older TryPost: a 409 without `error` is a version mismatch, any 422 is
    not pending, and a 200 has no `replayed`.
- Older TryPost without `content_version`: Echo compares its own hash of the
  post (re-read just before acting) and sends no `expected_version`.
- 5xx, 429 and network errors are temporary (retried); other 4xx are final.

## Reliability

- Outbox in SQLite: messages survive restarts and are retried with backoff
  (30 s, 2 min, 10 min, 30 min, 2 h).
- Dedupe keys per event and person: a retried project webhook sends nothing twice.
- Inbox in SQLite: the WhatsApp webhook stores each message (keyed by its id,
  so a retried Meta webhook acts once), the sender's window and delivery
  statuses in one transaction, and answers Meta 200 only after that commit. If
  storing fails it answers 500 and Meta sends the webhook again. Nothing that
  calls TryPost or WhatsApp runs before the answer; the worker is started right
  after it. Bad JSON gets 400. A worker processes messages in order per
  person. While TryPost is unreachable a message stays queued and is retried
  with the same backoff (6 attempts); the person gets one "cevabını kaydettim"
  message, then the normal answer when it goes through, or a "use the panel"
  message if it finally fails. A later message of the same person waits for
  the earlier one, so "Düzeltme iste" and the typed note keep their order. A
  message left half-done by a crash is picked up again after 5 minutes.
- A failed delivery (a send error or a `failed` status from Meta) is stored on
  the outbox row first; the worker reports it to the project afterwards
  (`failure_reported`), so a crash right after the 200 loses nothing. While
  TryPost is down the report is retried every 5 minutes for a day.
- The project webhook queues its messages in the outbox before answering 200;
  delivery happens after the answer.
- One decision per person per message: a double tap acts once. A decision is
  `started` (owned by the inbound message that made it, with its
  `request_id`) until TryPost confirms it, then `applied`; a final error
  removes it. If Echo crashes in between, or TryPost's answer is lost, the
  same message is retried and simply sends the approve/reject again with the
  same `request_id` and `expected_version`. Only a 200 for that request_id
  (fresh or `replayed`) counts as the person's decision: then they get
  "Onaylandı" / "geri gönderildi" and the post gets the "onayladı (WhatsApp)" /
  "düzeltme istedi" note. A 422 means someone else decided (for example
  approved in the panel while Echo's call was lost on the way): the person is
  told so and nothing is claimed in their name. Echo no longer guesses from the
  post's status or `approved_at`.
- A resumed decision that cannot be verified is not claimed: when an older
  TryPost (no request_id support, a 422 without `error`) or a decision started
  by an Echo version without request ids gets "not pending" on the retry, the
  person is told "Onayının uygulanıp uygulanmadığını doğrulayamadım; lütfen
  panelden kontrol et." A first attempt that gets a 200 is applied either way.
- A typed "Düzeltme iste" note whose reject is refused (someone else decided,
  the content changed, a request_id conflict, or it could not be verified) is
  not lost: it is added as a plain comment (`💬 <Ad> (WhatsApp): <text>`) and
  the person is told it was saved as a comment. A failed note POST is retried
  without explaining the refusal again.
- Another message finding an `applied` decision gets "zaten aldım"; one finding
  a `started` decision whose message is still queued gets "zaten aldım,
  işleniyor"; a `started` decision left by a message that failed or gave up is
  taken over by the new message (with the same `request_id`).
- Notes are at-least-once: a crash between a successful note POST and marking
  the decision applied (for "Uygun", or the note after a reject) adds the note
  again on the retry. A duplicate note is harmless, a lost one is not. The
  final answer to the person is keyed by the inbound message, so it is not sent
  twice.
- Outside the 24-hour window, requests go as approved templates; courtesy
  updates are skipped.

## Run

Requires Node 22.5+ (uses the built-in `node:sqlite`). No dependencies.

```sh
cp config.example.json config.json     # fill in people and projects
export ECHO_CONFIG=config.json WA_PHONE_NUMBER_ID=... WA_ACCESS_TOKEN=... \
       WA_APP_SECRET=... WA_VERIFY_TOKEN=... MARMARA_TRYPOST_TOKEN=... MARMARA_TRYPOST_WEBHOOK_SECRET=...
npm start
npm test
```

Docker: `docker build -t echo . && docker run -p 8080:8080 -v echo-data:/data -e ECHO_CONFIG_JSON="$(cat config.json)" ... echo`

## Oracle Cloud'a kurulum (Always Free)

Dosyalar `deploy/oracle/` altında. Her şey Always Free içinde kalır (A1.Flex 1 OCPU/6 GB,
yer yoksa E2.1.Micro; varsayılan boot disk; load balancer yok). HTTPS, Caddy ve
`echo-<ip>.sslip.io` adıyla otomatik gelir.

1. **VM'yi oluştur** (OCI Cloud Shell): `provision.sh` içeriğini Cloud Shell'de bir
   dosyaya yapıştır, `bash provision.sh` çalıştır. VCN, internet gateway, 22/80/443
   kuralları, alt ağ ve VM'yi oluşturur (tekrar çalıştırılabilir; yer yoksa birkaç
   dakika sonra yeniden dene). Sonda IP, SSH komutu ve HTTPS adı yazılır.
2. **Echo'yu kur** (VM'de, `ssh -i ~/.ssh/echo_vm ubuntu@<IP>`): `install.sh`
   içeriğini bir dosyaya yapıştır, `bash install.sh` çalıştır. Yazdığı deploy
   key'in GitHub repoya read-only olarak eklenmesini bekler, repoyu
   `/opt/echo/app`'e klonlar, gizli değerleri sorar (`/opt/echo/.env`, bir kez),
   `config.template.json`'u `/opt/echo/config.json`'a kopyalar, Docker ile başlatır
   ve Meta callback URL'sini, verify token'ı ve TryPost webhook URL'sini yazar.
   WhatsApp şablonları için: `bash /opt/echo/app/deploy/oracle/create-templates.sh`
   (durum: `... create-templates.sh --status`).
3. **Güncelle**: `bash /opt/echo/app/deploy/oracle/update.sh` (git pull, yeniden
   build, `config.json`/`.env` değişikliklerini de alır, health kontrolü).

Loglar: `cd /opt/echo/app/deploy/oracle && docker compose --env-file /opt/echo/.env logs -f echo`

### Hermes asistanı (aynı numarada sohbet eden yapay zeka)

**Nasıl çalışır:** Meta yine yalnızca Echo'yu çağırır. Echo onay/görüş isteklerini ve
onlara verilen cevapları (butonlar, "Yorum yaz"/"Düzeltme iste" notları, bir isteği
yanıtlayan mesajlar, "iptal") kendisi işler. Bunların dışındaki her mesajı (soru,
sohbet, sesli mesaj, fotoğraf) aynı VM'de çalışan Hermes Agent'a iletir; Hermes aynı
numaradan cevap verir. Hermes `hermes` adlı docker compose servisidir, dışarıya port
açmaz; Echo ona `http://hermes:8090/whatsapp/webhook` adresinden, Meta gibi imzalı
istekle ulaşır. Model: ChatGPT aboneliğinle OpenAI Codex. TryPost'a MCP ile bağlanır
(https://sosyal.marmaraai.com/mcp/trypost). Kimliği (Türkçe, kısa, "Echo AI Asistan")
`/opt/hermes/data/SOUL.md` dosyasındadır.

**Kurulum** (VM'de, ubuntu kullanıcısıyla, install.sh'tan sonra):

```sh
bash /opt/echo/app/deploy/oracle/update.sh                 # yeni kodu al
bash /opt/echo/app/deploy/oracle/hermes/setup-hermes.sh    # Hermes'i kur, giriş yap
```

`setup-hermes.sh` şunları yapar: WhatsApp değerlerini `/opt/echo/.env`'den
`/opt/hermes/data/.env`'e kopyalar (ekrana yazmaz), izinli numarayı (905418557902)
yazar, `SOUL.md` ve `config.yaml`'ı hazırlar, Hermes imajını indirip başlatır, sonra iki
girişi senin onayınla yaptırır:

1. **OpenAI Codex (cihaz kodu):** ekranda bir adres ve kod çıkar. Adresi tarayıcıda aç,
   ChatGPT hesabınla giriş yap, kodu gir, onayla. Pencere kendiliğinden devam eder.
2. **TryPost (OAuth):** TryPost'un MCP sunucusu API anahtarını kabul etmez, tek seferlik
   OAuth onayı ister. Ekrandaki "authorize" adresini aç, sosyal.marmaraai.com'a giriş
   yap, izin ver. Tarayıcı `http://127.0.0.1:.../callback?code=...` adresinde "bağlantı
   kurulamadı" der: bu normal. O adresin tamamını kopyalayıp terminale yapıştır.

En sonda Echo'nun `config.json`'una `assistant` ayarını ekler ve Echo'yu yeniden başlatır.
Tekrar çalıştırmak güvenlidir; `--skip-login` ile girişleri atlar, sadece ayarları
yeniler. `update.sh` Hermes kuruluysa onu da günceller (yeni imaj, WhatsApp
token'ları yeniden kopyalanır).

**Komutlar** (`H=/opt/echo/app/deploy/oracle/hermes`):

| Ne | Komut |
| --- | --- |
| Hermes logları | `bash $H/hermes.sh logs --follow` (ya da `docker compose ... logs -f hermes`) |
| Codex'e yeniden giriş | `bash $H/hermes.sh auth add openai-codex`, sonra `bash $H/setup-hermes.sh --skip-login` |
| Codex giriş durumu | `bash $H/hermes.sh auth status openai-codex` |
| Model değiştir | `bash $H/hermes.sh model` |
| TryPost'a yeniden bağlan | `bash $H/hermes.sh mcp login trypost`, sonra `bash $H/setup-hermes.sh --skip-login` |
| TryPost bağlantı testi | `bash $H/hermes.sh mcp test trypost` |
| Sorun teşhisi | `bash $H/hermes.sh doctor` |
| Hermes'i kapat (Echo yardım mesajına döner) | `config.json`'da `"assistant": {..., "enabled": false}`, sonra `update.sh` |

**İzinli numara eklemek:** iki yerde olmalı. (1) Echo: `/opt/echo/config.json` içindeki
`people` listesine `{ "id": "ad", "name": "Ad", "phone": "905xxxxxxxxx" }` ekle (Echo
bilinmeyen numaraları Hermes'e hiç iletmez). (2) Hermes: `/opt/hermes/data/.env`
içindeki satırı virgülle genişlet: `WHATSAPP_CLOUD_ALLOWED_USERS=905418557902,905xxxxxxxxx`
(ülke kodu, `+` ve boşluk yok). Sonra `bash /opt/echo/app/deploy/oracle/update.sh`.

**Güvenlik:** TryPost aracı `trust: untrusted` ile tanımlı: salt okunur olmayan her
TryPost aracı (gönderi oluşturma/düzenleme/silme, hemen yayınlama, onaylama/reddetme,
not ekleme...) çalışmadan önce WhatsApp'ta onay/ret butonlu bir mesaj çıkar; 5 dakika
içinde onaylanmazsa işlem yapılmaz. API anahtarı ve webhook araçları Hermes'e hiç verilmez (Echo'nun TryPost
webhook'u bozulmasın diye). Hermes'te kabuk, dosya, tarayıcı ve kod çalıştırma araçları
kapalıdır (`config.yaml` → `agent.disabled_toolsets`). Hermes'in kendi butonları
(`appr:...`, `cl:...`) Echo'dan geçip Hermes'e gider.

## Endpoints

- `GET /whatsapp`: Meta webhook verification
- `POST /whatsapp`: Meta webhook (checked against `X-Hub-Signature-256`)
- `POST /projects/<id>/webhook`: project webhook (checked against `X-Webhook-Signature`)
- `GET /health`: liveness, outbox, inbox and forwards counts

## Adding a project

Write an adapter in `src/projects/` with `handleEvent`, `handleAction`,
`handleText` and `onDeliveryFailed` (see `trypost.js`), and register its type in
`src/index.js`. `handleAction`/`handleText` throw an error with
`retryable = true` when the project is temporarily unreachable (Echo retries),
or with a `userMessage` when the answer cannot be applied; they reply only after
the work succeeded, and pass the request's outbox id as `about` to `echo.reply`.
A step that must happen once should be recorded as started before it and
applied after it (see `decisions`), so a retry after a crash can tell the two
apart.
