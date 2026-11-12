import { normalizePhone } from './config.js';
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
 */
export function createEcho({ config, store, whatsapp, log = () => {}, fetchImpl = globalThis.fetch }) {
    const adapters = new Map();
    const people = new Map(config.people.map((person) => [person.phone, person]));
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
                    const person = people.get(normalizePhone(message.from));
                    if (!person) {
                        log('warn', 'message from an unknown number ignored');
                        continue;
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
    };

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
            const adapter = route?.project ? adapters.get(route.project) : null;
            const texts = adapter?.texts ?? {};
            const about = route?.outboxId ?? null;
            const project = route?.project ?? '_echo';
            if (error.retryable && attempts < MAX_ATTEMPTS) {
                saveProgress();
                store.inboxRetry(message.id, BACKOFF_MS[attempts - 1], error.message);
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
            const text = error.retryable
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
        // A failure is final; a late "read" does not undo it.
        if (!row || row.status === 'failed') return;
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

    /** Handles one stored inbound message; returns its route (for finishing a session). Throws to retry or fail. */
    async function onMessage(message, person, item, progress) {
        if (message.buttonId) {
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
                if (/^\s*(iptal|vazgeç|vazgec)\s*$/i.test(message.text)) {
                    echo.reply(person, 'Tamam, vazgeçildi.', message.id, row.project, row.id);
                    return route;
                }
                await adapter.handleText({ echo, person, row, mode: route.mode, text: message.text, messageId: message.id, progress });
                return route;
            }

            // No quoted request and no open session: ask, never guess which content this is about.
            echo.reply(
                person,
                'Merhaba! Görüşünü ya da onayını bekleyen içerikler buraya gelecek. Bir içerik hakkında yazmak için o mesajı yanıtla.',
                message.id,
            );
            return null;
        }

        echo.reply(person, 'Şimdilik yazılı mesajları ve butonları anlayabiliyorum.', message.id);
        return null;
    }

    return echo;
}
