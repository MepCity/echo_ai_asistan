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
| `inbox.item_received`      | project members (social inbox, see below)             | Cevapla (+text → Gönder/Düzenle/İptal) · Hermes'e bırak · Okundu |
| `inbox.reply_sent`         | the others who got that item, only inside the 24h window | –                                            |

Every answer becomes a note on the post. A reply to a message whose content has
changed since is not applied; Echo sends the new version instead. A failed
delivery is noted on the post.

A typed message goes to the request it quotes (a quote-reply to the request, or
to Echo's "Yorumunu yaz…" prompt about it). Without a quote it goes to the open
note session ("Yorum yaz" / "Düzeltme iste"); a new tap replaces the session, and
the prompt names the content it is for. With neither, Echo asks the person to
quote-reply; it never guesses.

### Social inbox

`inbox.item_received` (same signing) carries `data.item` = `{id, platform, kind:
"comment"|"message", author:{name, handle}, text, permalink, post:{id, excerpt}|null,
received_at, can_reply, reply_window_ends_at|null}`. Echo notifies the project's
members (or `inbox.recipients`) once per item id: an interactive message inside
the 24h window, the `yeni_etkilesim` template outside it, with **Cevapla ·
Hermes'e bırak · Okundu**.

- More than `digestThreshold` (5) items within `digestWindowSec` (120 s): the
  first ones go alone, the rest are held and sent as one digest ("7 yeni
  etkileşim var", template `etkilesim_ozeti`) at the end of the window, with
  **Hermes'e bırak · Hepsi okundu**. `quietHours` holds everything until it ends.
- Who may reply is separate from who is notified: `inbox.repliers` (person
  ids; default: members with the `approver` role, who may publish). Others get
  "Okundu" only (templates `yeni_etkilesim_bilgi` / `etkilesim_ozeti_bilgi`),
  and Echo refuses their reply buttons and typed replies on every press ("Bu
  etkileşime cevap verme yetkin yok"). "Hermes'e bırak" is a replier button too,
  since Hermes replies with the same TryPost token.
- **Cevapla** (or a quote-reply to the notification) → the typed text is shown
  back with **Gönder · Düzenle · İptal**. **Gönder** calls
  `POST /api/inbox/items/{id}/replies {text, request_id}`; `request_id` is
  `echo-ib-<sha256(project, WhatsApp id of the typed draft)>`, so retries and
  double taps send one reply (a decision row per draft, as for approvals).
  Only `status: "sent"` is told as sent. `sending`/`pending` → "⏳ Gönderiliyor…";
  the decision stays open and the worker replays the POST with the same
  request_id (30 s, 1, 2, 5, 10, 15, 30 min; then "durumunu doğrulayamadım",
  and a new Gönder checks again) until `sent` or `failed`. `failed` → the
  error, with Düzenle / Okundu. 409 → reply window closed (offers Okundu);
  422 → the reason, edit and try again. `can_reply: false` → said, with Okundu.
- Someone else replied: TryPost checks under a lock at send time. "Yine de
  gönder" (an earlier reply was shown) sends that reply's id as
  `acknowledged_reply_id`; a plain "Gönder" sends none. 409 `already_replied`
  closes the draft and asks "⚠️ Bu arada X cevap verdi: “…”" with
  **Yine de gönder · İptal** (the reply in `reply` acknowledged, a new
  request_id derived from that message); 409 `reply_in_progress` → "⏳ X şu an
  cevap gönderiyor; birkaç saniye sonra tekrar dene" with **Tekrar dene** (same
  request_id). X is the person who sent the same text through Echo, else
  TryPost's `author.name`.
- **Hermes'e bırak** forwards "[Echo · Gelen kutusu] Bu yoruma cevap taslağı
  hazırla…" with the item summary and `inbox_item_id` to Hermes, which drafts and
  confirms with the TryPost MCP inbox tools. Like every forwarded text it ends
  with the presser's "[TryPost kullanıcı: <uuid>]" note, which Hermes passes as
  `on_behalf_of_user_id` to `reply-to-inbox-item-tool`, so TryPost credits the
  reply to that member.
- A reply that went out is told once to the others who got the item ("✅ Ayşe,
  @ali’nin Instagram yorumunu cevapladı: “…”", as a reply to their notification,
  only inside their 24h window). Through Echo, right after `sent`; from Hermes or
  the panel, on TryPost's `inbox.reply_sent` (`data` = `{workspace, item, reply:
  {id, text, sent_at, request_id}, sent_by: {id, name}|null, via:
  echo|agent|panel|api}`). `sent_by.id` is matched to a person by
  `members[].userId` (that person is left out and named as in the config), else
  TryPost's name is used and nobody is left out; `via: agent` reads "Ayşe (Hermes
  ile)". Both paths key the message by the reply's `request_id`, so it is sent
  once whichever comes first; for a reply Echo made (`echo-ib-` request id) the
  webhook names the person whose draft it was (TryPost only knows Echo's API key
  user), and does nothing if Echo has no such draft. The item is marked as
  answered by that person, so a later "Cevapla" shows the note even when TryPost
  cannot be reached. In TryPost (Settings > Webhooks) Echo's webhook must
  subscribe to `inbox.reply_sent` as well as `inbox.item_received`.
- **Okundu** → `POST /api/inbox/items/{id}/read`.

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

### WhatsApp şablonları v2 (Marketing'e alınanların yerine)

Meta `onay_bekliyor`, `yeni_etkilesim`, `yeni_etkilesim_bilgi` ve
`etkilesim_ozeti_bilgi`'yi MARKETING olarak onayladı; onaylı bir şablonun
kategorisi değiştirilemiyor. `create-templates.sh` bu yüzden aynı değişkenler ve
aynı buton sırasıyla, bildirim gibi yazılmış yeni şablonlar da oluşturur:
`onay_talebi`, `etkilesim_bildirimi`, `etkilesim_bildirimi_bilgi`,
`etkilesim_sayisi_bilgi` (hepsi UTILITY olarak gönderilir).

1. Oluştur: `bash /opt/echo/app/deploy/oracle/create-templates.sh` (var olanları atlar).
2. Onayı bekle, durumu kontrol et: `bash /opt/echo/app/deploy/oracle/create-templates.sh --status`.
3. Yalnızca `APPROVED UTILITY` olanlar için `/opt/echo/config.json`'da ilgili projenin
   `templates` anahtarını değiştir, sonra `update.sh` çalıştır. Dördü de UTILITY onaylanırsa:

```json
"templates": {
  "language": "tr",
  "approval": "onay_talebi",
  "approvalImage": "onay_bekliyor_gorsel",
  "approvalVideo": "onay_bekliyor_video",
  "feedback": "gorus_istegi",
  "inbox": "etkilesim_bildirimi",
  "inboxDigest": "etkilesim_ozeti",
  "inboxReadOnly": "etkilesim_bildirimi_bilgi",
  "inboxDigestReadOnly": "etkilesim_sayisi_bilgi"
}
```

`approvalImage` / `approvalVideo`, `approval` değişince varsayılan adların
`onay_talebi_gorsel` / `onay_talebi_video` olmaması için yazıldı (eskiden de bu
adlara bakılıyordu). Bu medya şablonları yoksa (`--status` "yok" der) ikisini
`null` yap; Echo görselli gönderilerde de metin şablonunu kullanır.

Eski şablonlar silinmez, yedek olarak kalır: geri dönmek için ilgili anahtarı eski
adına (`onay_bekliyor`, `yeni_etkilesim`, `yeni_etkilesim_bilgi`,
`etkilesim_ozeti_bilgi`) çevirmek yeter. Koddaki varsayılan adlar değişmedi.

### Hermes asistanı (aynı numarada sohbet eden yapay zeka)

**Nasıl çalışır:** Meta yine yalnızca Echo'yu çağırır. Echo onay/görüş isteklerini ve
onlara verilen cevapları (butonlar, "Yorum yaz"/"Düzeltme iste" notları, bir isteği
yanıtlayan mesajlar, "iptal") kendisi işler. Bunların dışındaki her mesajı (soru,
sohbet, sesli mesaj, fotoğraf) aynı VM'de çalışan Hermes Agent'a iletir; Hermes aynı
numaradan cevap verir. Hermes `hermes` adlı docker compose servisidir, dışarıya port
açmaz; Echo ona `http://hermes:8090/whatsapp/webhook` adresinden, Meta gibi imzalı
istekle ulaşır. Model: ChatGPT aboneliğinle OpenAI Codex; modeli Codex girişinden sonra
`bash /opt/echo/app/deploy/oracle/hermes/hermes.sh model` ile sen seçersin (kurulum
scripti seçimini değiştirmez). TryPost'a MCP ile bağlanır
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
   Sonra hesabının kullanabildiği modeli seç: `bash /opt/echo/app/deploy/oracle/hermes/hermes.sh model`.
2. **TryPost (OAuth):** TryPost'un MCP sunucusu API anahtarını kabul etmez, tek seferlik
   OAuth onayı ister. Ekrandaki "authorize" adresini aç, sosyal.marmaraai.com'a giriş
   yap, izin ver. Tarayıcı `http://127.0.0.1:.../callback?code=...` adresinde "bağlantı
   kurulamadı" der: bu normal. O adresin tamamını kopyalayıp terminale yapıştır.

En sonda Echo'nun `config.json`'una `assistant` ayarını ekler ve Echo'yu yeniden başlatır.
Tekrar çalıştırmak güvenlidir; `--skip-login` ile girişleri atlar, sadece ayarları
yeniler. `update.sh` Hermes kuruluysa onu da günceller (yeni imaj, WhatsApp
token'ları yeniden kopyalanır).

**Sesli mesajlar:** Hermes WhatsApp sesli mesajlarını VM'de, ücretsiz olarak yazıya çevirir
(faster-whisper; `config.yaml` → `stt`: `provider: local`, model `small`, `int8`, dil `tr`).
Resmi Hermes imajında faster-whisper yok; bu yüzden `hermes` servisi resmi imajın üstüne onu
ekleyen küçük bir imajdır (`deploy/oracle/hermes/Dockerfile`, sürümler Hermes'in kendi
`uv.lock`'undan). `setup-hermes.sh` (ve onu çağıran `update.sh`) her seferinde resmi imajın
yenisini çekip (`docker compose build --pull hermes`) bu eki yeniden kurar; imaj
değişmediyse saniyeler sürer, ilk seferde birkaç dakika. Whisper modeli (yaklaşık 500 MB) bir kez
`/opt/hermes/data/cache/huggingface` klasörüne iner (`HF_HOME`); konteyner ya da imaj
yenilense de tekrar inmez. Script sonunda durumu yazar: `Sesli mesaj: ACIK.` ya da
`Sesli mesaj: KAPALI.` (nedeniyle). Yeni imaj oluşturulamazsa (Docker Hub/PyPI'ya
ulaşılamadı) önceki imajla devam eder. Elle kontrol:
`docker compose -f /opt/echo/app/deploy/oracle/docker-compose.yml --env-file /opt/echo/.env --profile hermes exec hermes /opt/hermes/.venv/bin/python -c "import faster_whisper; print(faster_whisper.__version__)"`.
Denemek için izinli numaradan kısa bir Türkçe sesli mesaj gönder: Hermes önce çevrilmiş metni
yazar (`stt.echo_transcripts`), sonra ona göre cevap verir. İlk mesajda model belleğe yüklenir
(birkaç saniye fazladan), 15 saniyelik bir mesaj yaklaşık 10-15 saniyede çevrilir.
`bash /opt/echo/app/deploy/oracle/hermes/hermes.sh logs --follow` içinde
`Transcribing user voice` satırı görünür; hata olursa `transcription failed` satırı nedenini söyler.

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
bilinmeyen numaraları Hermes'e hiç iletmez). Hermes kişiye WhatsApp profil adıyla değil,
Echo'nun ilettiği adla hitap eder: isteğe bağlı `"hitap": "Ad"`, yoksa `name`'in ilk kelimesi
(`"Yasir Arslan"` → Yasir). İsteğe bağlı: `"whatsappUsername": "kullaniciadi"`
(WhatsApp kullanıcı adı, büyük/küçük harf ve `@` fark etmez) ve `"whatsappUserId": "TR.…"`
(Meta'nın BSUID'si). Kullanıcı adı olan biri Meta'nın webhook'unda numarasız (yalnızca
`from_user_id` / `contacts[].user_id` ile) gelebilir; Echo onu bu alanlarla ya da daha önce
numarasıyla birlikte gördüğü BSUID ile (SQLite `user_ids`) tanır ve Hermes'e iletirken
numarasını `from` ve `wa_id` alanlarına koyar. Numarası olmayan kişiye BSUID'ye
(`recipient` alanı) yazılır. (2) Asistan izni: Hermes tek bir TryPost hesabıyla kulüp
adına iş yapar (gönderi, cevap) ve kimseyi ayırt etmez; bu yüzden kapı Echo'dadır. Echo
yalnızca `assistant.allowedPeople` listesindeki kişilerin mesajlarını (metin, medya ve
medya köprüsü, "Hermes'e bırak") Hermes'e iletir. Liste verilmezse varsayılan, herhangi
bir projede gelen kutusuna cevap verebilenlerdir (`inbox.repliers`, varsayılanı `approver`
rolü). Diğerleri onay/görüş butonlarını ve notları kullanmaya devam eder; asistana
yazdıklarında saatte en fazla bir kez "Asistanı kullanma yetkin yok; onay/görüş mesajları
çalışmaya devam ediyor." cevabını alır. Echo açılışta izinli kişi id'lerini loglar
(`assistant access: …`, numarasız). (3) Hermes: `/opt/hermes/data/.env` içindeki
`WHATSAPP_CLOUD_ALLOWED_USERS` aynı kişileri listelemeli; `setup-hermes.sh` (ve onu çağıran
`update.sh`) bu satırı Echo'nun kendi hesapladığı listeden yazar
(`src/assistant-users.js`). Echo bunu hesaplayamazsa satır olduğu gibi kalır; o zaman elle
yaz: `WHATSAPP_CLOUD_ALLOWED_USERS=905418557902,905xxxxxxxxx` (ülke kodu, `+` ve boşluk
yok). Sonra `bash /opt/echo/app/deploy/oracle/update.sh`.

**Güvenlik:** TryPost aracı `trust: untrusted` ile tanımlı: salt okunur olmayan her
TryPost aracı (gönderi oluşturma/düzenleme/silme, hemen yayınlama, onaylama/reddetme,
not ekleme...) çalışmadan önce WhatsApp'ta onay/ret butonlu bir mesaj çıkar; 5 dakika
içinde onaylanmazsa işlem yapılmaz. API anahtarı ve webhook araçları Hermes'e hiç verilmez (Echo'nun TryPost
webhook'u bozulmasın diye). Hermes'te kabuk, dosya, tarayıcı ve kod çalıştırma araçları
kapalıdır (`config.yaml` → `agent.disabled_toolsets`). Hermes'in kendi butonları
(`appr:...`, `cl:...`) Echo'dan geçip Hermes'e gider.

### Stüdyo: Higgsfield ile görsel ve ses (Hermes için)

**Nasıl çalışır:** Hermes, Higgsfield'e doğrudan bağlanmaz. Aynı VM'de `studio` adlı küçük bir
MCP sunucusu (Echo imajı, `src/studio/`) çalışır; Higgsfield girişini o tutar ve Hermes'e
yalnızca şu araçları verir:

| Araç | Ne yapar | Onay |
| --- | --- | --- |
| `get_brand_kit` | `/opt/echo/brand-kit.md` (marka kiti) | yok (salt okunur) |
| `studio_usage` | bugünkü/aylık kullanım, kalan sınırlar, bekleme | yok |
| `get_generation` | başlamış bir üretimin sonucu (yeni kredi harcamaz) | yok |
| `get_original_file` | asıl dosyayı WhatsApp'a belge olarak göndermek için yol | yok |
| `generate_image` | tek görsel, varsayılan **1k** (2k yalnızca `yuksek_cozunurluk: true` / `resolution: "2k"`, 4k yalnızca açıkça ve sadece Nano Banana): `gpt_image_2_6` (varsayılan, high), `nano_banana_2_1`, `recraft_v4_1` (vektör/tipografi, marka renkleri) | WhatsApp'ta onay |
| `edit_image` | `gpt_image_2_6` ile görselden görsele düzenleme: önceki üretim (`generation_id`) ya da kullanıcının gönderdiği görsel (`kaynak_gorsel`) + `talimat`; aynı sınırlar, 1k | onay |
| `add_logo` | gerçek kulüp logosunu (PNG) ImageMagick ile birebir ekler; asıl dosya değişmez, "final" PNG ayrı saklanır; **kredi harcamaz** | onay |
| `generate_audio` | `speech` (`elevenlabs_v4`, ≤1500 karakter) ya da `music` (`elevenlabs_music_v2_5`, ≤60 sn) | onay |
| `attach_to_trypost` | üretilen görselin **asıl dosyasını** (logolu "final" varsa onu; `logosuz: true` ile asıl hali) TryPost'a yükler; `post_id` varsa ekler, yoksa `social_account_id` için yeni taslak | onay |

`generate_image`, `edit_image`, `add_logo`, `generate_audio` ve `attach_to_trypost` isteğe bağlı bir
`ozet` alır: Hermes'in yazdığı tek satırlık Türkçe özet; yalnızca onay mesajında ve "hazır"
bildiriminde görünür.

**Yayına hazır afiş:** Hermes prompt'u bir sanat yönetmeni brifi gibi yazar (konsept, duygu, stil);
yerleşim modele kalır. `generate_image` `baslik` (ve isteğe bağlı `alt_metin`) alır; geçit prompt'a
yalnızca şunları ekler: aynen yazılacak metin ve Türkçe karakter uyarısı, küçük "Marmara Yapay Zeka
Kulübü" yazısı, logonun olduğu gibi ve net görünür konması, marka renklerinin yumuşak bir ipucu
("palette inspired by …"). `logo: true` (varsayılan, referans alan modellerde) gerçek logo PNG'sini
(`deploy/oracle/brand/logo.png` lacivert yazılı, `logo-dark.png` beyaz yazılı; imaja kopyalanır)
`image_references` olarak verir; yerini model seçer, `logo_konum` (alt-sag, alt-sol, ust-sag,
ust-sol) yalnızca verilirse köşe ister; `logo_zemin` (koyu/acik) hangi dosyanın verileceğini seçer.
`secenek: 2` aynı brifi iki farklı stil yönüyle (`stiller`, yoksa geçit seçer) iki ayrı iş olarak
gönderir; ikisi birlikte tüm sınırlara sayılır ve onay kartı "2 görsel · yaklaşık 3 kredi" der. Logo Higgsfield'e bir
kez `media_upload` ile yüklenir, media id `studio.db` → `assets` tablosunda saklanır (dosya değişince
ya da `studio.logoMediaMaxDays`, varsayılan 7 gün sonra yeniden yüklenir). Modelin logosu bozuk
çıkarsa `add_logo` gerçek logoyu görsel genişliğinin ~%12'si kadar, kenarlardan %5 içeride ekler;
o köşenin ortalama parlaklığına göre koyu zeminde beyaz yazılı, açık zeminde lacivert logoyu seçer.
Sunucudaki `/opt/echo/brand-kit.md` güncellemelerde değişmez; dağıtılan kitin
`brand-kit-version` satırı daha yeniyse `studio-prepare.sh` (update.sh) bunu bir NOT ile söyler.

**Türkçe onay mesajı:** Hermes'in onay kartının ortası normalde sabit İngilizce ("MCP tool … on
UNTRUSTED server … Arguments: {json}") ve WhatsApp'ın 1024 karakter sınırını aşınca uzun metni önce
ayrı bir mesaj olarak, sonra kesik kartı gönderiyor. Hermes'te bu metni değiştiren bir ayar, dil
anahtarı ya da kanca yok; bu yüzden `deploy/oracle/hermes/plugins/echo_onay_tr` adlı küçük bir Hermes
eklentisi (`setup-hermes.sh` → `/opt/hermes/data/plugins/`, `configure.py` → `plugins.enabled`)
yalnızca TryPost ve studio araçlarının kart metnini kısa Türkçe bir özetle değiştirir (≤600 karakter,
tek mesaj): ör. "🎨 Görsel üretilecek · Instagram (4:5) · yaklaşık 1.5 kredi / Konu: …", "📝 TryPost'ta
taslak oluşturulacak · Instagram / Metin: “…”", "💬 Yorum ya da mesaja cevap gidecek". Onay kapısı
aynen kalır (aynı Onayla/Vazgeç, aynı süre); yazma araçları asla kendiliğinden onaylanmaz. Kredi tahmini
studio'nun `POST /approval-hint` ucundan gelir (aynı modelin son gerçek tahmini, yoksa
`studio.approxCredits` tablosu: GPT 1k 1,5 / 2k 2,75; Nano 1k 1,5 / 2k 2; Recraft 8). Hermes
güncellemesi eklentinin sardığı kodu değiştirirse eklenti hiçbir şey yapmaz, Hermes'in kendi kartı
çıkar; `setup-hermes.sh` (ve `update.sh`) sonunda durumu yazar (`/opt/hermes/data/plugins/echo_onay_tr/status.json`).

**Geç biten üretim:** Üretim çağrısı "hâlâ hazırlanıyor" dediyse ve iş sonra arka plan kontrolünde
biterse, studio isteyen kişiye (`requested_by` → `config.json` `people[].phone`, yalnızca asistanı
kullanabilen kişiler) WhatsApp'tan kısa bir "🎨 … hazır." mesajı ve önizlemeyi kendisi gönderir
(Echo'nun WhatsApp anahtarıyla). `requested_by` bilinmiyorsa, sonuç zaten `get_generation` ile
gösterildiyse ya da üretim 23 saatten eskiyse gönderilmez. Tek deneme: gönderilemezse (ör. 24 saat
penceresi dışında) loglanır, tekrar denenmez.

Model listesi sunucuda sabittir (allowlist); video modelleri, preset'ler, GPU, web sitesi, reklam,
TikTok vb. hiçbir Higgsfield aracı Hermes'e açılmaz, geçit de bunları çağıramaz. `count`/`batch_size`
her zaman 1, `use_unlim` false (config `allowUnlim` açmadıkça), `use_free_gens` gönderilmez.
Her üretimden önce Higgsfield'in `estimate_*_cost` aracıyla fiyat sorulur. Sınırlar
(`config.json` → `studio.limits`, varsayılanlar): tek istekte ≤10 kredi; üretimler arası 60 sn;
aynı anda tek üretim (Higgsfield'e gönderilmiş ama bitmemiş bir iş, `submitting`/`submitted`,
veritabanında durdukça yeni üretim reddedilir; `get_generation`, bir sonraki üretim denemesi ve
dakikada bir arka plan kontrolü biten işi `completed`/`failed` yapar; `studio.pendingStaleMin`
(15 dk) geçince işe son bir kez bakılır: bitmişse saklanır, hâlâ çalışıyorsa "late" olur (yeni
üretimi engellemez, sınırlara sayılır, `get_generation` ve arka plan kontrolü `studio.lateMaxHours`
(24 sa) boyunca bakmaya devam eder, sonra "unknown"); job id'si olmayan iş doğrudan "unknown" olur); İstanbul gününe göre
günde ≤40 kredi, ≤15 görsel, ≤5 müzik, ≤20 seslendirme; ayda ≤400 kredi; kişi başı günde ≤20
kredi. **Kişi başı sınır en iyi çabadır:** `requested_by`'ı model yazar; Hermes MCP sunucusuna
çağrıyı kimin (hangi WhatsApp numarasının) yaptığını iletmez (MCP istemcisi yalnızca araç
argümanlarını gönderir, başlıklar bağlantı başına sabittir). `requested_by` boş ya da bilinmeyen
bir anahtarsa üretim ortak `bilinmiyor` kovasına, aynı sınırla yazılır (boş bırakmak sınırı
atlatmaz), ama model başka bir kişinin adını yazabilir. Asıl koruma tek istek, günlük ve aylık
genel sınırlardır. Başarısız ya da cevabı kaybolan üretim asla tekrar gönderilmez (cevabı
kaybolan "unknown" sayılır ve sınırlara dahildir). Her
deneme (reddedilenler dahil) `/data/studio/studio.db` → `generations` tablosunda.

**Dosyalar:** Higgsfield'in verdiği dosya **olduğu gibi** (aynı bayt, biçim, çözünürlük; sha256
kaydı) `echo-data` biriminde `/data/studio/media/` altında saklanır. WhatsApp'a yalnızca bir
önizleme kopyası gider (`/opt/hermes/data/cache/generated/echo-studio/`, Hermes `MEDIA:` satırıyla
gönderir; WhatsApp görseli sıkıştırır). TryPost'a dosya WhatsApp'tan geçmez: `attach_to_trypost`
asıl baytları sunucudan sunucuya, medya köprüsüyle aynı yoldan (`POST /api/uploads`, aynı
`MARMARA_TRYPOST_TOKEN`, sadece `studio.project` çalışma alanı) yükler ve `upload_token`'ı
gönderiye bağlar. Ses dosyaları gönderiye eklenmez (saklanır, ileride video için). Not: TryPost
PNG/WebP'yi yüklerken JPEG'e (kalite 100, aynı boyut) çevirir; bayt bayt aynı kalsın istersen
`studio.imageFormat: "jpeg"` (yalnızca `gpt_image_2_6`).

**Kurulum** (VM'de, `setup-hermes.sh` bunu yapar; `update.sh` her seferinde tekrarlar):
`/opt/echo/brand-kit.md` yoksa oluşturulur (düzenlemelerin korunur), paylaşılan klasörler açılır,
`/opt/echo/.env`'e rastgele `ECHO_STUDIO_TOKEN` yazılır ve Hermes'in `.env`'ine kopyalanır;
`configure.py` Hermes'e `mcp_servers.studio` (`http://studio:8091/mcp`, `Authorization: Bearer
${ECHO_STUDIO_TOKEN}`, `trust: untrusted`) ekler. Higgsfield girişi bir kerelik:

```sh
bash /opt/echo/app/deploy/oracle/update.sh                    # yeni kod, studio servisi
bash /opt/echo/app/deploy/oracle/hermes/setup-hermes.sh       # 3/3 adımı: Higgsfield girişi
# ya da sadece giriş:
bash /opt/echo/app/deploy/oracle/hermes/studio.sh login       # adresi aç, izin ver, dönen adresi yapıştır
bash /opt/echo/app/deploy/oracle/hermes/studio.sh status      # bağlı mı, kredi
bash /opt/echo/app/deploy/oracle/hermes/studio.sh logs --follow
```

Giriş: Higgsfield MCP'si OAuth ister (Clerk, `https://higgsfield.ai/_clerk`; dinamik istemci
kaydı, PKCE, `offline_access` ile yenileme anahtarı). `login.js` istemciyi kaydeder, authorize
adresini yazar; tarayıcı `http://127.0.0.1:8976/callback?code=…` adresinde "bağlantı
kurulamadı" der, o adresi yapıştırırsın. Anahtarlar `/data/studio/higgsfield-auth.json` (0600)
dosyasında, süresi dolmadan kendiliğinden yenilenir, loglara yazılmaz. `HIGGSFIELD_API_KEY`
`.env`'de tanımlıysa OAuth yerine bearer olarak o gönderilir (Higgsfield böyle bir anahtar
belgelemiyor; yalnızca destek verirlerse işe yarar). Yenileme anahtarı geçersizleşirse araçlar
"Higgsfield bağlantısı kurulmamış" der: `studio.sh login` ile yeniden giriş yap.

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
