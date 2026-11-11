import { normalizePhone } from './config.js';
import { OUTSIDE_WINDOW, toPayload, toTemplatePayload } from './whatsapp.js';

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

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
 *   texts?: { retrying, gaveUp }                     (what to tell people while the project is down)
 *
 * handleAction / handleText throw when they could not finish. An error with
 * `retryable = true` (the project is down, 5xx, 429) keeps the inbound message
 * queued and it is processed again later; any other error ends it, and the
 * person is told `error.userMessage`. They must reply to the person only after
 * the work succeeded, and may record steps already done in `ctx.progress`
 * (kept across retries) so a retry does not repeat them.
 */
export function createEcho({ config, store, whatsapp, log = () => {} }) {
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
        reply(person, text, replyTo = null, project = '_echo', about = null) {
            return store.enqueue({ project, kind: 'reply', recipient: person.phone, message: { text, replyTo, ...(about ? { about } : {}) } });
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
                    await deliverDue();
                } while (again);
            })().finally(() => {
                ticking = null;
            });
            return ticking;
        },

        async handleProjectEvent(projectId, event) {
            const adapter = adapters.get(projectId);
            if (!adapter) throw new Error(`Unknown project ${projectId}`);
            await adapter.handleEvent(event, echo);
            await echo.tick();
        },

        /** Statuses are applied at once; messages are only stored, the worker processes them. */
        async handleWebhook({ messages, statuses }) {
            for (const status of statuses) await onStatus(status);
            for (const message of messages) {
                const person = people.get(normalizePhone(message.from));
                if (!person) {
                    log('warn', 'message from an unknown number ignored');
                    continue;
                }
                // A retried Meta webhook finds the id already stored and adds nothing.
                if (store.receive(message, person.phone)) store.touchWindow(person.phone);
            }
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

    async function deliver(row) {
        const message = materialize(row);
        const windowOpen = store.windowOpen(row.recipient);

        // Updates and replies are courtesy messages: never pay for or force them.
        if (row.message.onlyInWindow && !windowOpen) {
            store.skip(row.id, 'outside the 24-hour window');
            return;
        }

        try {
            let waId;
            if (row.template && !windowOpen) {
                waId = await whatsapp.send(toTemplatePayload(row.recipient, row.template, message.buttons));
            } else {
                try {
                    waId = await whatsapp.send(toPayload(row.recipient, message));
                } catch (error) {
                    if (error.code !== OUTSIDE_WINDOW || !row.template) throw error;
                    waId = await whatsapp.send(toTemplatePayload(row.recipient, row.template, message.buttons));
                }
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
            store.fail(row.id, error.message);
            log('error', 'failed', row.id, error.message);
            await reportFailure(store.outbox(row.id), error.code === OUTSIDE_WINDOW ? 'Kişi son 24 saatte yazmadı ve onaylı şablon yok.' : error.message);
        }
    }

    async function reportFailure(row, reason) {
        const adapter = adapters.get(row.project);
        if (!adapter?.onDeliveryFailed || !['approval', 'feedback'].includes(row.kind)) return;
        const person = people.get(row.recipient);
        await adapter.onDeliveryFailed({ echo, row, person, reason }).catch((error) => log('error', 'failure report failed', error.message));
    }

    async function onStatus(status) {
        const row = store.outboxByWaId(status.id);
        if (!row) return;
        const order = ['pending', 'sending', 'sent', 'delivered', 'read'];
        if (status.status === 'failed') {
            if (row.status === 'failed') return;
            store.setStatusByWaId(status.id, 'failed', status.error);
            await reportFailure(store.outbox(row.id), status.error ?? 'WhatsApp mesajı teslim edemedi.');
            return;
        }
        // Statuses can arrive out of order; only move forward.
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
                    if (route.usedSession) store.undecide(row.id, person.phone);
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
