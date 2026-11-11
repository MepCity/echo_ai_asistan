# Echo

Echo is a small WhatsApp assistant service. Projects send it events over signed
webhooks; Echo asks the right people on WhatsApp, and writes their answers back
to the project through its API. One WhatsApp number serves every project.

```
TryPost ──(signed webhook)──▶ Echo ──▶ WhatsApp Cloud API ──▶ people
   ▲                           │
   └──(API: approve/reject/notes)◀── button taps and typed replies
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
- `POST /api/posts/{id}/approve` and `/reject` get `{"expected_version": "<content_version>"}`.
  TryPost checks it in the same locked transaction as the decision and answers
  **409** `{"message": ..., "content_version": "<current>"}` when the content
  changed. Echo then applies nothing, tells the person and sends the current version.
- Older TryPost without `content_version`: Echo compares its own hash of the
  post (re-read just before acting) and sends no `expected_version`.
- 5xx, 429 and network errors are temporary (retried); other 4xx are final.

## Reliability

- Outbox in SQLite: messages survive restarts and are retried with backoff
  (30 s, 2 min, 10 min, 30 min, 2 h).
- Dedupe keys per event and person: a retried project webhook sends nothing twice.
- Inbox in SQLite: the WhatsApp webhook only stores each message (keyed by its
  id, so a retried Meta webhook acts once); a worker processes them in order per
  person. While TryPost is unreachable a message stays queued and is retried
  with the same backoff (6 attempts); the person gets one "cevabını kaydettim"
  message, then the normal answer when it goes through, or a "use the panel"
  message if it finally fails. A later message of the same person waits for
  the earlier one, so "Düzeltme iste" and the typed note keep their order. A
  message left half-done by a crash is picked up again after 5 minutes.
- One decision per person per message: a double tap acts once.
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

## Endpoints

- `GET /whatsapp`: Meta webhook verification
- `POST /whatsapp`: Meta webhook (checked against `X-Hub-Signature-256`)
- `POST /projects/<id>/webhook`: project webhook (checked against `X-Webhook-Signature`)
- `GET /health`: liveness, outbox and inbox counts

## Adding a project

Write an adapter in `src/projects/` with `handleEvent`, `handleAction`,
`handleText` and `onDeliveryFailed` (see `trypost.js`), and register its type in
`src/index.js`. `handleAction`/`handleText` throw an error with
`retryable = true` when the project is temporarily unreachable (Echo retries),
or with a `userMessage` when the answer cannot be applied; they reply only after
the work succeeded, and pass the request's outbox id as `about` to `echo.reply`.
