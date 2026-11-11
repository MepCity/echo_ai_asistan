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

## Reliability

- Outbox in SQLite: messages survive restarts and are retried with backoff
  (30 s, 2 min, 10 min, 30 min, 2 h).
- Dedupe keys per event and person: a retried project webhook sends nothing twice.
- Inbound WhatsApp message ids are remembered: a retried Meta webhook acts once.
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
- `GET /health`: liveness and outbox counts

## Adding a project

Write an adapter in `src/projects/` with `handleEvent`, `handleAction`,
`handleText` and `onDeliveryFailed` (see `trypost.js`), and register its type in
`src/index.js`.
