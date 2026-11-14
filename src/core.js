import { createHash } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAssistant } from './assistant.js';
import { normalizePhone, normalizeUsername } from './config.js';
import { MEDIA_ERROR_CODES, OUTSIDE_WINDOW, toPayload, toTemplatePayload } from './whatsapp.js';

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const REPORT_RETRY_MS = 5 * 60_000;
const REPORT_GIVE_UP_MS = 24 * 60 * 60_000;
const MEDIA_CACHE_MS = 25 * 24 * 60 * 60_000;
// WhatsApp's limits for uploaded media.
const MEDIA_LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 };
// How a message's media is sent: by link, uploaded to WhatsApp first, or left out.
const MEDIA_LINK = 0;
const MEDIA_UPLOAD = 1;
const MEDIA_NONE = 2;
// Forwarding to the assistant: a chat should not wait hours, so it gives up after about 20 minutes.
const ASSISTANT_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];
const ASSISTANT_TEXTS = {
    retrying: 'Asistana şu an ulaşamıyorum; mesajını kaydettim, ulaşınca ileteceğim.',
    gaveUp: 'Asistan şu an yanıt veremiyor. Lütfen biraz sonra tekrar yaz.',
};
// Media bridge: what people send the assistant is uploaded to TryPost first.
const BRIDGE_KINDS = new Set(['image', 'video', 'document']);
// Tries before a media is forwarded without its upload (with a note saying so), and the wait before each retry.
const BRIDGE_ATTEMPTS = 3;
const BRIDGE_BACKOFF_MS = [15_000, 60_000];
// Upload jobs run beside the worker (never inside it): at most this many at once.
const BRIDGE_JOBS = 2;
// How long a message waiting for its running upload is put back for (the job wakes it when it ends).
const BRIDGE_POLL_MS = 30_000;
// Time limits of one try: the Graph lookup, the download (in all, and without a byte arriving) and the upload.
const BRIDGE_TIMEOUTS_MS = { lookup: 20_000, download: 180_000, idle: 30_000, upload: 180_000 };
// TryPost keeps an upload 24 hours: an older one is uploaded again before a (late) forward.
const BRIDGE_FRESH_MS = 20 * 60 * 60_000;
// What TryPost accepts (PostMediaRequestRules::file), with a file extension for each.
const BRIDGE_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
};
// TryPost's default ceilings (MEDIA_*_MAX_SIZE_MB); a project may lower or raise them with mediaLimitsMb.
const BRIDGE_LIMITS_MB = { image: 10, video: 100, document: 100 };
// Echo's own buttons are "<action>:<outbox id>"; anything else (e.g. Hermes' "appr:<id>:approve") is the assistant's.
const ECHO_BUTTON = /^[a-z_]+:\d+$/i;
const CANCEL = /^\s*(iptal|vazgeç|vazgec)\s*$/i;

/**
 * Echo's heart: projects turn their events into outbox messages, the worker
 * delivers them, and WhatsApp replies are routed back to the project that sent
 * the message they answer.
 *
 * A project adapter implements:
 *   handleEvent(event)            -> Promise<void>   (calls echo.enqueue / echo.notify)
 *   handleAction(ctx)             -> Promise<void>   (a button was tapped)
 *   handleText(ctx)               -> Promise<void>   (a typed note for a session or a reply)
 *   onDeliveryFailed(ctx)         -> Promise<void>   (a request could not be delivered)
 *   periodic?(echo)               -> Promise<void>   (called on every worker pass: reminders, digests)
 *   mediaHeaders?(url)            -> object          (headers for downloading the project's media)
 *   texts?: { retrying, gaveUp }                     (what to tell people while the project is down)
 *
 * A message may carry `media: { type: 'image'|'video', url, mime?, size? }`.
 * Echo sends it by link; when Meta cannot fetch it (131052/131053, at once or
 * in a failed status), Echo downloads it, uploads it to WhatsApp and sends the
 * media id (cached per URL for 25 days); when that fails too, the message goes
 * without media: `message.withoutMedia` (text) and `template.withoutMedia`
 * (another template) say how.
 *
 * handleAction / handleText throw when they could not finish. An error with
 * `retryable = true` (the project is down, 5xx, 429) keeps the inbound message
 * queued and it is processed again later; any other error ends it, and the
 * person is told `error.userMessage`. They must reply to the person only after
 * the work succeeded, and may record steps already done in `ctx.progress`
 * (kept across retries) so a retry does not repeat them.
 *
 * Media bridge: with an assistant and `config.mediaBridge` (a TryPost
 * project), an image, video or PDF a person sends is downloaded from WhatsApp
 * and uploaded to that TryPost workspace before it is forwarded; the forwarded
 * caption then ends with "[TryPost medya: upload_token=…, tür=…]" so the
 * assistant can attach it to a post it creates (it cannot fetch WhatsApp media
 * into TryPost itself). The upload is kept per inbound message, media,
 * project and target, so a retried forward never uploads twice and a new
 * message always gets a fresh (unspent) token. The upload runs as a background
 * job with time limits; meanwhile the message waits (the person's later
 * messages behind it), and the worker goes on with approvals and deliveries.
 * When the upload keeps failing (3 tries), the message is forwarded anyway
 * with "[TryPost medya yüklenemedi: …]".
 *
 * With `config.assistant`, a message from a known person that no project
 * handles (no Echo button, no open session, no quote-reply to a request, not
 * "iptal") is forwarded to the assistant (see assistant.js) from the same
 * inbox: in order per person, retried on network errors and 5xx, and the
 * person is told when it finally fails. Delivery statuses of messages Echo
 * did not send are the assistant's too, and are forwarded from `forwards`.
 */
export function createEcho({ config, store, whatsapp, log = () => {}, fetchImpl = globalThis.fetch, mediaTimeouts = {} }) {
    const timeouts = { ...BRIDGE_TIMEOUTS_MS, ...mediaTimeouts };
    // Running upload jobs, by bridge key.
    const jobs = new Map();
    const adapters = new Map();
    const people = new Map(config.people.map((person) => [person.phone, person]));
    const peopleByUserId = new Map(config.people.filter((person) => person.whatsappUserId).map((person) => [person.whatsappUserId, person]));
    const peopleByUsername = new Map(config.people.filter((person) => person.whatsappUsername).map((person) => [person.whatsappUsername, person]));
    const assistant = config.assistant
        ? createAssistant(config.assistant, { phoneNumberId: config.whatsapp.phoneNumberId, fetchImpl })
        : null;
    let ticking = null;
    let again = false;

    const echo = {
        config,
        store,
        log,

        register(projectId, adapter) {
            adapters.set(projectId, adapter);
        },

        personByPhone: (phone) => people.get(normalizePhone(phone)) ?? null,

        /**
         * Queues a message. `message.buttons` hold { action, title }; the button
         * ids become "<action>:<outbox id>" when sent, so a tap leads back to the
         * exact message (and content version) it answers.
         */
        enqueue({ project, itemId = null, kind, person, message, template = null, fingerprint = null, dedupeKey = null }) {
            return store.enqueue({
                project,
                itemId,
                kind,
                recipient: person.phone,
                message,
                template,
                fingerprint,
                dedupeKey,
            });
        },

        /**
         * A plain reply to someone who just wrote to us (their window is open).
         * `about` is the outbox id of the request the reply concerns: quote-replying
         * to this reply then counts as replying to that request.
         */
        reply(person, text, replyTo = null, project = '_echo', about = null, dedupeKey = null) {
            return store.enqueue({ project, kind: 'reply', recipient: person.phone, message: { text, replyTo, ...(about ? { about } : {}) }, dedupeKey });
        },

        async tick() {
            // One pass at a time; a call during a pass asks for another one after it.
            if (ticking) {
                again = true;
                return ticking;
            }
            ticking = (async () => {
                do {
                    again = false;
                    await processInbox();
                    await forwardStatuses();
                    await runPeriodic();
                    await deliverDue();
                    await reportFailures();
                } while (again);
            })().finally(() => {
                ticking = null;
            });
            return ticking;
        },

        /** Lets the project queue what an event asks for (stored in the outbox); delivery is left to the worker. */
        async acceptProjectEvent(projectId, event) {
            const adapter = adapters.get(projectId);
            if (!adapter) throw new Error(`Unknown project ${projectId}`);
            await adapter.handleEvent(event, echo);
        },

        async handleProjectEvent(projectId, event) {
            await echo.acceptProjectEvent(projectId, event);
            await echo.tick();
        },

        /**
         * Stores what a WhatsApp webhook brought, synchronously and in one
         * transaction: inbound messages (keyed by their id), the senders' windows
         * and delivery statuses. Throws when it could not; the webhook is then
         * answered with an error so Meta sends it again, which is safe because
         * all of it is idempotent. Nothing here calls a project or WhatsApp: the
         * worker (tick) does that, after Meta got its answer.
         */
        ingest({ messages = [], statuses = [] }) {
            store.transaction(() => {
                for (const status of statuses) onStatus(status);
                for (const message of messages) {
                    const phone = normalizePhone(message.from);
                    const keys = `keys=${Object.keys(message.raw ?? message).join(',')}`;
                    if (!phone) log('info', 'message without a phone number', `user=${maskUserId(message.userId)}`, keys);
                    const person = findSender(phone, message);
                    if (!person) {
                        log('warn', 'message from an unknown number ignored', maskPhone(phone) || '-', `user=${maskUserId(message.userId)}`, `username=${message.username ? 'yes' : 'no'}`, keys);
                        continue;
                    }
                    // Seen together with a known number: a later message with only this BSUID finds the person too.
                    if (phone && message.userId && people.get(phone) === person && store.learnUserId(String(message.userId), phone)) {
                        log('info', 'learned the WhatsApp user id of', person.id);
                    }
                    // A retried Meta webhook finds the id already stored and adds nothing.
                    if (store.receive(message, person.phone)) store.touchWindow(person.phone);
                }
            });
        },

        async handleWebhook(parsed) {
            echo.ingest(parsed);
            await echo.tick();
        },

        /** Waits until no media upload job is running and the worker has passed after them (tests, shutdown). */
        async settled() {
            while (jobs.size) await Promise.allSettled([...jobs.values()]);
            await echo.tick();
        },
    };

    /**
     * The person a message is from: by phone number; without a known one (a
     * user with a username may come with only a BSUID) by the configured
     * user id, the user id seen earlier with their number, or the username.
     */
    function findSender(phone, message) {
        if (phone && people.has(phone)) return people.get(phone);
        const userId = message.userId ? String(message.userId) : null;
        if (userId) {
            const person = peopleByUserId.get(userId) ?? people.get(store.phoneForUserId(userId) ?? '');
            if (person) return person;
        }
        const username = normalizeUsername(message.username);
        return (username && peopleByUsername.get(username)) || null;
    }

    async function processInbox() {
        store.recoverInbox(5 * 60_000);
        // Each person's messages in order: a message waiting for a retry holds back that person's later ones.
        for (let count = 0; count < 500; count++) {
            const item = store.inboxNext();
            if (!item || !store.claimInbox(item.wa_message_id)) return;
            await processInbound(store.inbox(item.wa_message_id));
        }
    }

    async function processInbound(item) {
        const message = item.message;
        const person = people.get(item.phone);
        const progress = item.route?.progress ?? {};
        const saveProgress = () => store.setRoute(message.id, { ...(store.inbox(message.id).route ?? {}), progress });
        try {
            if (!person) throw new Error('unknown person');
            const route = await onMessage(message, person, item, progress);
            finishRoute(person, route);
            store.inboxDone(message.id);
        } catch (error) {
            const route = store.inbox(message.id).route;
            const attempts = item.attempts;
            const forAssistant = Boolean(route?.assistant);
            const adapter = route?.project ? adapters.get(route.project) : null;
            const texts = forAssistant ? ASSISTANT_TEXTS : (adapter?.texts ?? {});
            const backoff = forAssistant ? ASSISTANT_BACKOFF_MS : BACKOFF_MS;
            const about = route?.outboxId ?? null;
            const project = route?.project ?? '_echo';
            if (error.deferMs !== undefined) {
                // Waiting for its media upload (a background job): not a failed try, and nothing to tell the person.
                saveProgress();
                store.inboxDefer(message.id, error.deferMs);
                // The job may have finished meanwhile: then the message is due at once.
                if (!error.waiting()) store.inboxDue(message.id);
                return;
            }
            if (error.retryable && attempts < backoff.length + 1) {
                saveProgress();
                store.inboxRetry(message.id, backoff[attempts - 1], error.message);
                log('warn', 'inbound retrying', message.id, error.message);
                if (person && store.inboxNotified(message.id)) {
                    echo.reply(person, texts.retrying ?? 'Şu an işleyemiyorum, cevabını kaydettim; bağlantı gelince işleyeceğim.', message.id, project, about);
                }
                return;
            }
            store.inboxFail(message.id, error.message);
            finishRoute(person, route);
            log('error', 'inbound failed', message.id, error.message);
            if (!person) return;
            const text = forAssistant
                ? ASSISTANT_TEXTS.gaveUp
                : error.retryable
                  ? (texts.gaveUp ?? 'Uzun süre bağlantı kuramadım; cevabın uygulanamadı. Lütfen paneli kullan.')
                  : (error.userMessage ?? 'Cevabın uygulanamadı; lütfen paneli kullan.');
            echo.reply(person, text, message.id, project, about);
        }
    }

    /** A note typed for an open session ends that session once it is finished, either way. */
    function finishRoute(person, route) {
        if (!person || !route?.usedSession) return;
        const session = store.session(person.phone);
        if (session && session.outbox_id === route.outboxId && session.mode === route.mode) store.clearSession(person.phone);
    }

    /** The request a typed message is about: the quoted message wins over an open session. */
    function resolveText(person, message) {
        const session = store.session(person.phone);
        let quoted = message.contextId ? store.outboxByWaId(message.contextId) : null;
        // Quoting one of our replies ("Yorumunu yaz…") means quoting the request it was about.
        if (quoted?.kind === 'reply' && quoted.message.about) quoted = store.outbox(quoted.message.about);
        if (quoted && quoted.recipient === person.phone && quoted.kind !== 'reply' && quoted.item_id && adapters.has(quoted.project)) {
            if (session?.outbox_id === quoted.id) return { outboxId: quoted.id, project: quoted.project, mode: session.mode, usedSession: true };
            // An open session for another request stays: its prompt named that request, and the person may still write it.
            return { outboxId: quoted.id, project: quoted.project, mode: 'comment', usedSession: false };
        }
        if (session) {
            const row = store.outbox(session.outbox_id);
            if (row && adapters.has(row.project)) return { outboxId: row.id, project: row.project, mode: session.mode, usedSession: true };
        }
        return null;
    }

    async function deliverDue() {
        store.recoverStuck(5 * 60_000);
        for (const row of store.due(50)) {
            if (!store.claim(row.id)) continue;
            await deliver(row);
        }
    }

    function materialize(row) {
        const buttons = (row.message.buttons ?? []).map((button) => ({ id: `${button.action}:${row.id}`, title: button.title }));
        return { ...row.message, buttons };
    }

    /** Projects' scheduled work (reminders, digests). A failing project never stops delivery. */
    async function runPeriodic() {
        for (const [projectId, adapter] of adapters) {
            if (!adapter.periodic) continue;
            try {
                await adapter.periodic(echo);
            } catch (error) {
                log('warn', `periodic work of ${projectId} failed`, error.message);
            }
        }
    }

    const mediaError = (message) => Object.assign(new Error(message), { media: true, retryable: false });

    /** Downloads a message's media and uploads it to WhatsApp; returns the media id (cached per URL). */
    async function uploadMedia(row, media) {
        const cached = store.cachedMedia(media.url, MEDIA_CACHE_MS);
        if (cached) return cached;
        if (!whatsapp.uploadMedia) throw mediaError('media upload is not available');
        const headers = adapters.get(row.project)?.mediaHeaders?.(media.url) ?? {};
        let response;
        try {
            response = await fetchImpl(media.url, { headers });
        } catch (error) {
            throw Object.assign(new Error(`media download: ${error.message}`), { retryable: true });
        }
        if (!response.ok) {
            if (response.status >= 500 || response.status === 429) {
                throw Object.assign(new Error(`media download: HTTP ${response.status}`), { retryable: true });
            }
            throw mediaError(`media download: HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > (MEDIA_LIMITS[media.type] ?? MEDIA_LIMITS.image)) throw mediaError(`media too large (${bytes.length} bytes)`);
        const mimeType = media.mime ?? response.headers.get('content-type')?.split(';')[0] ?? (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
        let id;
        try {
            id = await whatsapp.uploadMedia({ bytes, mimeType, filename: media.url.split('?')[0].split('/').pop() || 'media' });
        } catch (error) {
            if (error.retryable) throw error;
            throw mediaError(`media upload: ${error.message}`);
        }
        store.cacheMedia(media.url, id);
        return id;
    }

    /** The media to send for this mode: by link, as an uploaded id, or none. */
    async function resolveMedia(row, mode) {
        const media = row.message.media;
        if (!media?.url || mode >= MEDIA_NONE) return null;
        if (mode === MEDIA_LINK) return { type: media.type, link: media.url };
        return { type: media.type, id: await uploadMedia(row, media) };
    }

    /** Sends one row with its media sent the given way. */
    async function sendRow(row, windowOpen, mode) {
        let message = materialize(row);
        let template = row.template;
        const withMedia = row.message.media?.url && mode < MEDIA_NONE;
        if (row.message.media?.url && !withMedia) {
            // Without its media: the project's fallback text and template (a template with a media header needs one).
            if (row.message.withoutMedia !== undefined) message = { ...message, text: row.message.withoutMedia };
            if (template?.header) template = template.withoutMedia ?? null;
            if (!message.text && !message.buttons?.length) return null;
        }
        const media = await resolveMedia(row, mode);
        const templateMedia = template?.header ? media : null;
        if (template && !windowOpen) return whatsapp.send(toTemplatePayload(row.recipient, template, message.buttons, templateMedia));
        try {
            return await whatsapp.send(toPayload(row.recipient, message, media));
        } catch (error) {
            if (error.code !== OUTSIDE_WINDOW || !template) throw error;
            return whatsapp.send(toTemplatePayload(row.recipient, template, message.buttons, templateMedia));
        }
    }

    async function deliver(row) {
        const windowOpen = store.windowOpen(row.recipient);

        // Updates and replies are courtesy messages: never pay for or force them.
        if (row.message.onlyInWindow && !windowOpen) {
            store.skip(row.id, 'outside the 24-hour window');
            return;
        }

        let mode = row.media_mode ?? MEDIA_LINK;
        try {
            let waId;
            for (;;) {
                try {
                    waId = await sendRow(row, windowOpen, mode);
                    break;
                } catch (error) {
                    const isMediaError = error.media || MEDIA_ERROR_CODES.has(error.code);
                    if (!isMediaError || !row.message.media?.url || mode >= MEDIA_NONE) throw error;
                    log('warn', 'media not accepted, trying the next way', row.id, error.message);
                    // An uploaded id WhatsApp refused may have expired: upload again next time.
                    if (mode === MEDIA_UPLOAD) store.dropMedia(row.message.media.url);
                    mode += 1;
                    store.setMediaMode(row.id, mode);
                }
            }
            if (waId === null) {
                store.skip(row.id, 'nothing to send without its media');
                return;
            }
            store.markSent(row.id, waId);
            log('info', 'sent', row.kind, row.id);
        } catch (error) {
            const attempts = row.attempts + 1;
            if (error.retryable && attempts < MAX_ATTEMPTS) {
                store.reschedule(row.id, BACKOFF_MS[attempts - 1], error.message);
                log('warn', 'retrying', row.id, error.message);
                return;
            }
            // The failure is reported to the project by reportFailures (in this same pass), from the stored row.
            store.fail(row.id, error.code === OUTSIDE_WINDOW ? 'Kişi son 24 saatte yazmadı ve onaylı şablon yok.' : error.message);
            log('error', 'failed', row.id, error.message);
        }
    }

    /**
     * Tells projects about requests that could not be delivered. Driven by the
     * outbox (status 'failed', failure_reported 0), so a failure stored just
     * before a crash is still reported. While the project is unreachable the
     * report is retried every 5 minutes for a day.
     */
    async function reportFailures() {
        for (const row of store.unreportedFailures(50)) {
            const adapter = adapters.get(row.project);
            if (!adapter?.onDeliveryFailed || !['approval', 'feedback'].includes(row.kind)) {
                store.markReported(row.id);
                continue;
            }
            try {
                await adapter.onDeliveryFailed({ echo, row, person: people.get(row.recipient), reason: row.last_error ?? 'WhatsApp mesajı teslim edemedi.' });
                store.markReported(row.id);
            } catch (error) {
                if (error.retryable && store.now() - row.updated_at < REPORT_GIVE_UP_MS) {
                    store.delayReport(row.id, REPORT_RETRY_MS);
                    log('warn', 'failure report retrying', row.id, error.message);
                } else {
                    store.markReported(row.id);
                    log('error', 'failure report failed', row.id, error.message);
                }
            }
        }
    }

    /** Only database writes: a failed status is reported to the project later, by the worker. */
    function onStatus(status) {
        const row = store.outboxByWaId(status.id);
        if (!row) {
            // Not one of Echo's messages: the assistant sent it (to one of our people).
            const known = people.has(normalizePhone(status.recipient)) || Boolean(status.recipientUserId && findSender('', { userId: status.recipientUserId }));
            if (assistant && known) store.queueForward(status, `status:${status.id}:${status.status}`);
            return;
        }
        // A failure is final; a late "read" does not undo it.
        if (row.status === 'failed') return;
        if (status.status === 'failed' && MEDIA_ERROR_CODES.has(Number(status.code)) && row.message.media?.url && (row.media_mode ?? 0) < MEDIA_NONE) {
            // Meta accepted the message but could not fetch its media: send it again, uploaded (or without media).
            if ((row.media_mode ?? 0) === MEDIA_UPLOAD) store.dropMedia(row.message.media.url);
            store.retryMedia(row.id, (row.media_mode ?? 0) + 1, status.error);
            return;
        }
        if (status.status === 'failed') {
            store.setStatusByWaId(status.id, 'failed', status.error ?? 'WhatsApp mesajı teslim edemedi.');
            return;
        }
        // Statuses can arrive out of order; only move forward.
        const order = ['pending', 'sending', 'sent', 'delivered', 'read'];
        if (order.indexOf(status.status) > order.indexOf(row.status)) store.setStatusByWaId(status.id, status.status);
    }

    /** Passes delivery statuses of the assistant's messages on to it. Best effort: given up silently. */
    async function forwardStatuses() {
        if (!assistant) return;
        for (const row of store.forwardsDue(50)) {
            try {
                await assistant.forwardStatus(row.payload);
                store.forwardDone(row.id);
            } catch (error) {
                const attempts = row.attempts + 1;
                if (error.retryable && attempts < ASSISTANT_BACKOFF_MS.length + 1) {
                    store.forwardRetry(row.id, ASSISTANT_BACKOFF_MS[attempts - 1], error.message);
                } else {
                    store.forwardFail(row.id, error.message);
                    log('warn', 'status not forwarded to the assistant', row.id, error.message);
                }
                // The assistant is down: leave the rest for a later pass.
                if (error.retryable) return;
            }
        }
    }

    const bridgeError = (reason, detail) => Object.assign(new Error(detail), { reason, retryable: false });

    const timedOutError = (what) => Object.assign(new Error(`${what}: timed out`), { retryable: true, timedOut: true });

    /** The TryPost workspace an upload belongs to: the API URL and a fingerprint of the token (never the token). */
    function bridgeTarget(projectId) {
        const project = config.projects.find((item) => item.id === projectId) ?? {};
        const token = createHash('sha256').update(String(project.apiToken ?? '')).digest('hex').slice(0, 12);
        return `${String(project.apiUrl ?? '').replace(/\/+$/, '')}#${token}`;
    }

    /**
     * Returns the message to forward, its caption ending with a note on its
     * media's upload to the media bridge's TryPost project. The upload runs as
     * a background job: until it ended, this throws a "defer" error that puts
     * the message back to wait (no try counted, nothing told to the person).
     */
    async function bridgeMedia(message) {
        const projectId = config.mediaBridge;
        const adapter = projectId ? adapters.get(projectId) : null;
        const raw = message.raw;
        const kind = raw?.type;
        if (!adapter?.uploadMedia || !whatsapp.mediaInfo || !BRIDGE_KINDS.has(kind)) return message;
        const mediaId = raw[kind]?.id ? String(raw[kind].id) : null;
        if (!mediaId) return message;

        const key = { messageId: message.id, mediaId, project: projectId, target: bridgeTarget(projectId) };
        const jobKey = JSON.stringify(key);
        const defer = (ms) => {
            throw Object.assign(new Error('waiting for the media upload'), { deferMs: Math.max(ms, 0), waiting: () => jobs.has(jobKey) });
        };
        const row = store.bridged(key);
        // An upload kept longer than TryPost keeps it (a forward delayed by an outage) is made again.
        const stale = row?.status === 'uploaded' && store.now() - row.updated_at > BRIDGE_FRESH_MS;
        if (row && row.status !== 'pending' && !stale) {
            const note =
                row.status === 'uploaded'
                    ? `[TryPost medya: upload_token=${row.upload_token}, tür=${row.media_type ?? kind}]`
                    : `[TryPost medya yüklenemedi: ${row.last_error ?? 'bilinmeyen hata'}]`;
            const block = raw[kind] ?? {};
            const caption = block.caption ? `${block.caption}\n\n${note}` : note;
            return { ...message, raw: { ...raw, [kind]: { ...block, caption } } };
        }
        if (jobs.has(jobKey)) defer(BRIDGE_POLL_MS);
        if (row?.status === 'pending' && row.next_attempt_at > store.now()) defer(row.next_attempt_at - store.now());
        if (jobs.size >= BRIDGE_JOBS) defer(BRIDGE_POLL_MS);
        const job = runBridgeJob(adapter, key, raw[kind], kind).finally(() => {
            jobs.delete(jobKey);
            store.inboxDue(message.id);
            echo.tick().catch((error) => log('error', 'tick failed', error.message));
        });
        jobs.set(jobKey, job);
        defer(BRIDGE_POLL_MS);
    }

    /** One try of an upload, stored as done, as a retry for later (bounded) or as failed. Never throws. */
    async function runBridgeJob(adapter, key, media, kind) {
        try {
            const upload = await uploadToProject(adapter, key.project, key.mediaId, media);
            store.bridgeDone(key, upload.uploadToken, upload.type ?? kind);
            log('info', 'media uploaded to TryPost', key.messageId, kind);
        } catch (error) {
            const detail = String(error.message ?? error).slice(0, 300);
            if (error.retryable) {
                const attempts = store.bridgeAttempt(key, detail, BRIDGE_BACKOFF_MS[Math.min(store.bridged(key)?.attempts ?? 0, BRIDGE_BACKOFF_MS.length - 1)]);
                if (attempts < BRIDGE_ATTEMPTS) {
                    log('warn', 'media upload to TryPost will be retried', key.messageId, detail);
                    return;
                }
            }
            const reason = error.reason ?? (error.timedOut ? 'zaman aşımı' : error.retryable ? 'bağlantı sorunu' : 'TryPost dosyayı kabul etmedi');
            store.bridgeFailed(key, reason);
            log('warn', 'media not uploaded to TryPost', key.messageId, detail);
        }
    }

    /** Downloads one WhatsApp media to a temporary file (size-capped, checksum-verified) and uploads it to TryPost. */
    async function uploadToProject(adapter, projectId, mediaId, media) {
        let info;
        try {
            info = await whatsapp.mediaInfo(mediaId, { timeoutMs: timeouts.lookup });
        } catch (error) {
            if (error.retryable) throw error;
            throw bridgeError('WhatsApp medyası alınamadı', `media lookup: ${error.message}`);
        }
        const mime = String(info.mimeType ?? media.mime_type ?? '').split(';')[0].trim().toLowerCase();
        const extension = BRIDGE_TYPES[mime];
        if (!extension) throw bridgeError(`desteklenmeyen dosya türü (${mime || 'bilinmiyor'})`, `unsupported type ${mime || '-'}`);
        const group = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document';
        const limitMb = Number(config.projects.find((project) => project.id === projectId)?.mediaLimitsMb?.[group] ?? BRIDGE_LIMITS_MB[group]);
        const limit = limitMb * 1024 * 1024;
        const tooLarge = (size) => bridgeError(`dosya çok büyük (${(size / 1024 / 1024).toFixed(1)} MB, sınır ${limitMb} MB)`, `media too large (${size} bytes)`);
        if (info.size && info.size > limit) throw tooLarge(info.size);

        const dir = await mkdtemp(join(tmpdir(), 'echo-media-'));
        try {
            const file = join(dir, `media.${extension}`);
            // The download is limited in all and per stall: a hung connection is cut, and the try counts as failed.
            const controller = new AbortController();
            let timedOut = false;
            const cut = () => {
                timedOut = true;
                controller.abort();
                body?.destroy(timedOutError('media download'));
            };
            const total = setTimeout(cut, timeouts.download);
            let idle = setTimeout(cut, timeouts.idle);
            let body = null;
            let size = 0;
            const hash = createHash('sha256');
            try {
                let response;
                try {
                    response = await whatsapp.downloadMedia(info.url, { signal: controller.signal });
                } catch (error) {
                    if (timedOut) throw timedOutError('media download');
                    if (error.retryable) throw error;
                    throw bridgeError('WhatsApp medyası indirilemedi', error.message);
                }
                if (!response.body) throw Object.assign(new Error('media download: empty body'), { retryable: true });
                body = Readable.fromWeb(response.body);
                if (timedOut) body.destroy(timedOutError('media download'));
                const count = new Transform({
                    transform(chunk, _encoding, done) {
                        clearTimeout(idle);
                        idle = setTimeout(cut, timeouts.idle);
                        size += chunk.length;
                        if (size > limit) return done(tooLarge(size));
                        hash.update(chunk);
                        done(null, chunk);
                    },
                });
                await pipeline(body, count, createWriteStream(file));
            } catch (error) {
                if (error.reason) throw error;
                if (timedOut) throw timedOutError('media download');
                if (error.retryable) throw error;
                throw Object.assign(new Error(`media download: ${error.message}`), { retryable: true });
            } finally {
                clearTimeout(total);
                clearTimeout(idle);
            }
            if (info.sha256 && hash.digest('hex') !== String(info.sha256).toLowerCase()) {
                throw Object.assign(new Error('media download: checksum mismatch'), { retryable: true });
            }
            const name = String(media.filename ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(-120);
            const filename = name || `whatsapp-${mediaId}.${extension}`;
            try {
                return await adapter.uploadMedia({ file: await openAsBlob(file, { type: mime }), filename, mimeType: mime, timeoutMs: timeouts.upload });
            } catch (error) {
                if (error.retryable) throw error;
                const reason = error.status === 401 || error.status === 403 ? 'TryPost yetkisi yok' : error.status === 422 ? 'TryPost dosyayı kabul etmedi' : 'TryPost hatası';
                throw bridgeError(reason, error.message);
            }
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    /** Forwards a message to the assistant; the route is stored first so a retry (and a failure) knows where it went. */
    async function toAssistant(message, person, progress) {
        store.setRoute(message.id, { assistant: true, progress });
        const forwarded = await bridgeMedia(message);
        await assistant.forwardMessage(forwarded, person);
        log('info', 'forwarded to the assistant', message.id);
        return null;
    }

    /** Handles one stored inbound message; returns its route (for finishing a session). Throws to retry or fail. */
    async function onMessage(message, person, item, progress) {
        // Once forwarded, a retry goes to the assistant again, even if an Echo session opened meanwhile.
        if (item.route?.assistant && assistant) return toAssistant(message, person, progress);

        if (message.buttonId) {
            if (assistant && !ECHO_BUTTON.test(String(message.buttonId))) return toAssistant(message, person, progress);
            const [action, idText] = String(message.buttonId).split(':');
            const row = store.outbox(Number(idText));
            // A button only counts for the person it was sent to.
            if (!row || row.recipient !== person.phone) {
                echo.reply(person, 'Bu buton artık geçerli değil.', message.id);
                return null;
            }
            const adapter = adapters.get(row.project);
            const route = { outboxId: row.id, project: row.project, usedSession: false };
            if (!adapter) return route;
            store.setRoute(message.id, { ...route, progress });
            await adapter.handleAction({ echo, person, row, action, messageId: message.id, progress });
            return route;
        }

        if (message.type === 'text' && message.text) {
            // Resolved once and kept: a retry hours later goes to the same request even if the session expired.
            const route = item.route?.outboxId ? item.route : resolveText(person, message);
            const row = route && store.outbox(route.outboxId);
            const adapter = row && adapters.get(row.project);
            if (adapter) {
                if (!item.route) store.setRoute(message.id, { ...route, progress });
                if (CANCEL.test(message.text)) {
                    echo.reply(person, 'Tamam, vazgeçildi.', message.id, row.project, row.id);
                    return route;
                }
                await adapter.handleText({ echo, person, row, mode: route.mode, text: message.text, messageId: message.id, progress });
                return route;
            }

            if (assistant) {
                // "iptal" is Echo's word; with nothing open there is nothing to cancel.
                if (CANCEL.test(message.text)) {
                    echo.reply(person, 'İptal edilecek açık bir işlem yok.', message.id);
                    return null;
                }
                return toAssistant(message, person, progress);
            }

            // No quoted request and no open session: ask, never guess which content this is about.
            echo.reply(
                person,
                'Merhaba! Görüşünü ya da onayını bekleyen içerikler buraya gelecek. Bir içerik hakkında yazmak için o mesajı yanıtla.',
                message.id,
            );
            return null;
        }

        if (assistant) return toAssistant(message, person, progress);
        echo.reply(person, 'Şimdilik yazılı mesajları ve butonları anlayabiliyorum.', message.id);
        return null;
    }

    return echo;
}

/** Keeps the country prefix and the last 3 characters of a BSUID: TR.123456789 -> TR.******789. */
function maskUserId(userId) {
    if (!userId) return '-';
    const value = String(userId);
    const head = value.indexOf('.') + 1;
    return value.slice(0, head) + '*'.repeat(Math.max(value.length - head - 3, 0)) + value.slice(-3);
}

/** Keeps the country/operator prefix and the last 3 digits: 905326223863 -> 90532****863. */
function maskPhone(phone) {
    const digits = String(phone ?? '');
    if (digits.length > 8) return digits.slice(0, 5) + '*'.repeat(digits.length - 8) + digits.slice(-3);
    return '*'.repeat(Math.max(digits.length - 3, 0)) + digits.slice(-3);
}
