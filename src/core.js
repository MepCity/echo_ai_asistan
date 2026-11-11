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
 */
export function createEcho({ config, store, whatsapp, log = () => {} }) {
    const adapters = new Map();
    const people = new Map(config.people.map((person) => [person.phone, person]));
    let ticking = null;

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

        /** A plain reply to someone who just wrote to us (their window is open). */
        reply(person, text, replyTo = null, project = '_echo') {
            return store.enqueue({ project, kind: 'reply', recipient: person.phone, message: { text, replyTo } });
        },

        async tick() {
            // One delivery pass at a time; callers may ask for one after any change.
            if (ticking) return ticking;
            ticking = deliverDue().finally(() => {
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

        async handleWebhook({ messages, statuses }) {
            for (const status of statuses) await onStatus(status);
            for (const message of messages) {
                await onMessage(message).catch((error) => log('error', 'inbound message failed', error.message));
            }
            await echo.tick();
        },
    };

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

    async function onMessage(message) {
        if (!store.markInbound(message.id)) return; // WhatsApp retried a webhook we already handled
        const person = people.get(normalizePhone(message.from));
        if (!person) {
            log('warn', 'message from an unknown number ignored');
            return;
        }
        store.touchWindow(person.phone);

        if (message.buttonId) {
            const [action, idText] = String(message.buttonId).split(':');
            const row = store.outbox(Number(idText));
            // A button only counts for the person it was sent to.
            if (!row || row.recipient !== person.phone) {
                echo.reply(person, 'Bu buton artık geçerli değil.', message.id);
                return;
            }
            const adapter = adapters.get(row.project);
            if (!adapter) return;
            await adapter.handleAction({ echo, person, row, action, messageId: message.id });
            return;
        }

        if (message.type === 'text' && message.text) {
            const session = store.session(person.phone);
            if (session) {
                store.clearSession(person.phone);
                const row = store.outbox(session.outbox_id);
                const adapter = row && adapters.get(row.project);
                if (adapter) {
                    if (/^\s*(iptal|vazgeç|vazgec)\s*$/i.test(message.text)) {
                        echo.reply(person, 'Tamam, vazgeçildi.', message.id);
                        store.undecide(row.id, person.phone);
                        return;
                    }
                    await adapter.handleText({ echo, person, row, mode: session.mode, text: message.text, messageId: message.id });
                    return;
                }
            }

            const repliedTo = message.contextId ? store.outboxByWaId(message.contextId) : null;
            if (repliedTo && repliedTo.recipient === person.phone && adapters.get(repliedTo.project)) {
                await adapters
                    .get(repliedTo.project)
                    .handleText({ echo, person, row: repliedTo, mode: 'comment', text: message.text, messageId: message.id });
                return;
            }

            echo.reply(
                person,
                'Merhaba! Görüşünü ya da onayını bekleyen içerikler buraya gelecek. Bir içerik hakkında yazmak için o mesajı yanıtla.',
                message.id,
            );
            return;
        }

        echo.reply(person, 'Şimdilik yazılı mesajları ve butonları anlayabiliyorum.', message.id);
    }

    return echo;
}
