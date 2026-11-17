import { createHash } from 'node:crypto';
import { minutesOf } from '../config.js';

const DIGEST_LINES = 8;
// Interactive message bodies take 1024 characters: a longer draft is shown in a message of its own first.
const CONFIRM_LIMIT = 1000;

/**
 * The idempotency key of one reply, sent as `request_id` to
 * POST /inbox/items/{id}/replies: derived from the WhatsApp message id of the
 * typed draft, so every retry and every tap of "Gönder" on that draft sends
 * the same key, and TryPost answers a repeat with the same result.
 */
export function replyRequestId(projectId, waMessageId) {
    return `echo-ib-${createHash('sha256').update(`${projectId}\u0000${waMessageId}`).digest('hex').slice(0, 32)}`;
}

/**
 * The social inbox of a TryPost project: TryPost's `inbox.item_received`
 * webhooks become WhatsApp notifications with "Cevapla" / "Hermes'e bırak" /
 * "Okundu"; a reply is shown back for confirmation ("Gönder" / "Düzenle" /
 * "İptal") before it is sent through TryPost's replies API.
 *
 * Outbox kinds (all carry the item snapshot in message.item, or message.items
 * for a digest): 'inbox' (notification), 'inbox_digest', 'inbox_confirm' (a
 * draft waiting for "Gönder"), 'inbox_note' (an answer with an "Okundu" button
 * or a long draft's text). The outbox row is the link from a WhatsApp message
 * (button or quote-reply) back to the item, as for approval requests.
 */
export function createInbox({ project, api, names, timeZone, platformName, decisionState, recipients }) {
    const settings = project.inbox ?? { enabled: false };
    const windowMs = (settings.digestWindowSec ?? 120) * 1000;
    const threshold = settings.digestThreshold ?? 5;

    const toTime = (value) => (value ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`) : NaN);
    const excerpt = (text, length) => {
        const value = String(text ?? '').replace(/\s+/g, ' ').trim();
        if (!value) return '(metin yok)';
        return value.length > length ? `${value.slice(0, length - 1)}…` : value;
    };
    const platform = (item) => platformName(item.platform) ?? item.platform ?? 'Sosyal medya';
    const kindWord = (item) => (item.kind === 'message' ? 'mesaj' : item.kind === 'comment' ? 'yorum' : 'etkileşim');
    const label = (item) => `${platform(item)} ${item.kind === 'message' ? 'mesajı' : item.kind === 'comment' ? 'yorumu' : 'etkileşimi'}`;
    const who = (item) => {
        const handle = String(item.author?.handle ?? '').trim().replace(/^@/, '');
        return handle ? `@${handle}` : item.author?.name || 'Biri';
    };
    const when = (value) =>
        new Intl.DateTimeFormat('tr-TR', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(toTime(value)));
    const windowClosed = (item, now) => Boolean(item.reply_window_ends_at) && toTime(item.reply_window_ends_at) <= now;
    const itemPath = (item) => `/inbox/items/${encodeURIComponent(String(item.id))}`;

    function inQuietHours(now) {
        if (!settings.quietHours) return false;
        const minutes = Number(
            new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
                .format(new Date(now))
                .split(':')
                .reduce((hours, mins) => Number(hours) * 60 + Number(mins)),
        );
        const start = minutesOf(settings.quietHours.start);
        const end = minutesOf(settings.quietHours.end);
        return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    }

    const notifyButtons = [
        { action: 'ib_reply', title: 'Cevapla' },
        { action: 'ib_hermes', title: 'Hermes’e bırak' },
        { action: 'ib_read', title: 'Okundu' },
    ];

    /** The notification of one item, inside the window (interactive) and outside it (template). */
    function itemMessage(item) {
        const lines = [`📥 *${label(item)}* — ${who(item)}: “${excerpt(item.text, 500)}”`];
        if (item.post) lines.push(`Gönderi: “${excerpt(item.post.excerpt, 80)}”`);
        if (item.reply_window_ends_at) lines.push(`Cevap süresi: ${when(item.reply_window_ends_at)}’e kadar`);
        if (item.can_reply === false) lines.push('Bu etkileşime buradan cevap verilemiyor.');
        if (item.permalink) lines.push(`🔗 ${item.permalink}`);
        if (item.can_reply !== false) lines.push('', 'Cevap yazmak için bu mesajı yanıtlayabilirsin.');
        // Template body: {{1}} platform, {{2}} kind (yorum / mesaj), {{3}} "@author: text"
        const template = names.inbox
            ? { name: names.inbox, language: names.language, params: [platform(item), kindWord(item), `${who(item)}: ${excerpt(item.text, 200)}`] }
            : null;
        return { message: { text: lines.join('\n'), buttons: notifyButtons, item }, template };
    }

    function digestMessage(items) {
        const lines = [`📥 *${items.length} yeni etkileşim var*`];
        for (const item of items.slice(0, DIGEST_LINES)) lines.push(`• ${label(item)} — ${who(item)}: “${excerpt(item.text, 60)}”`);
        if (items.length > DIGEST_LINES) lines.push(`… ve ${items.length - DIGEST_LINES} tane daha`);
        lines.push('', 'Hermes’e bırakırsan cevap gerekenler için taslak hazırlar; tek tek panelden de bakabilirsin.');
        const counts = new Map();
        for (const item of items) counts.set(platform(item), (counts.get(platform(item)) ?? 0) + 1);
        const channels = [...counts].map(([name, count]) => `${name} (${count})`).join(', ');
        // Template body: {{1}} count, {{2}} channels with counts
        const template = names.inboxDigest ? { name: names.inboxDigest, language: names.language, params: [String(items.length), channels] } : null;
        const buttons = [
            { action: 'ib_all_hermes', title: 'Hermes’e bırak' },
            { action: 'ib_all_read', title: 'Hepsi okundu' },
        ];
        return { message: { text: lines.join('\n'), buttons, items }, template };
    }

    function queueItem(echo, item) {
        const { message, template } = itemMessage(item);
        for (const member of recipients()) {
            echo.enqueue({
                project: project.id,
                itemId: String(item.id),
                kind: 'inbox',
                person: member.person,
                message,
                template,
                dedupeKey: `${project.id}:inbox:${item.id}:${member.person.id}`,
            });
        }
    }

    function queueDigest(echo, items) {
        const key = createHash('sha256').update(items.map((item) => String(item.id)).join('\u0000')).digest('hex').slice(0, 16);
        const { message, template } = digestMessage(items);
        for (const member of recipients()) {
            echo.enqueue({
                project: project.id,
                itemId: `digest:${key}`,
                kind: 'inbox_digest',
                person: member.person,
                message,
                template,
                dedupeKey: `${project.id}:inbox-digest:${key}:${member.person.id}`,
            });
        }
    }

    /** An answer about an item with an "Okundu" button (it cannot be replied to, the window closed, ...). */
    function offerRead(echo, person, item, text, messageId) {
        echo.enqueue({
            project: project.id,
            itemId: String(item.id),
            kind: 'inbox_note',
            person,
            message: { text, buttons: [{ action: 'ib_read', title: 'Okundu' }], item, replyTo: messageId, onlyInWindow: true },
            dedupeKey: `${project.id}:inbox-note:${messageId}`,
        });
    }

    const explain = (error) => {
        if (error.status === 403) return 'Bu işlem için TryPost yetkim yok, yöneticiye haber ver.';
        if (error.status === 404) return 'Bu etkileşim TryPost’ta bulunamadı, silinmiş olabilir.';
        return 'İşlem TryPost’a iletilemedi; lütfen paneli kullan.';
    };
    const giveUp = (error) => {
        error.retryable = Boolean(error.retryable);
        error.userMessage ??= explain(error);
        return error;
    };

    /** POST .../read for each item not yet done (kept in progress, so a retry skips them). */
    async function markRead(items, progress) {
        progress.read ??= [];
        for (const item of items) {
            if (progress.read.includes(String(item.id))) continue;
            try {
                await api('POST', `${itemPath(item)}/read`, {});
            } catch (error) {
                // Gone: nothing left to mark.
                if (error.status !== 404 || items.length === 1) throw giveUp(error);
            }
            progress.read.push(String(item.id));
        }
    }

    function hermesText(items) {
        const describe = (item) =>
            [
                `Kanal: ${platform(item)} · ${kindWord(item)}`,
                `Kimden: ${[item.author?.name, item.author?.handle ? `@${String(item.author.handle).replace(/^@/, '')}` : null].filter(Boolean).join(' ') || 'bilinmiyor'}`,
                `Metin: “${excerpt(item.text, 1000)}”`,
                ...(item.post ? [`Gönderi: “${excerpt(item.post.excerpt, 200)}”`] : []),
                ...(item.permalink ? [`Bağlantı: ${item.permalink}`] : []),
                item.can_reply === false
                    ? 'Cevap: buradan cevap verilemiyor'
                    : item.reply_window_ends_at
                      ? `Cevap süresi: ${when(item.reply_window_ends_at)}’e kadar`
                      : 'Cevap süresi: sınır yok',
                `inbox_item_id: ${item.id}`,
            ].join('\n');
        if (items.length === 1) {
            const item = items[0];
            return [
                `[Echo · Gelen kutusu] Bu ${kindWord(item)}a cevap taslağı hazırla. Taslağı bana göster, onayımı almadan gönderme.`,
                '',
                describe(item),
            ].join('\n');
        }
        return [
            `[Echo · Gelen kutusu] ${items.length} yeni etkileşim var. Hangilerine cevap gerektiğini söyle ve onlar için cevap taslakları hazırla. Taslakları bana göster, onayımı almadan hiçbirini gönderme.`,
            ...items.map((item, index) => `\n${index + 1})\n${describe(item)}`),
        ].join('\n');
    }

    async function toHermes(echo, person, items, messageId, progress, say) {
        if (!echo.hasAssistant()) return say('Hermes bağlı değil; cevabı panelden yazabilir ya da "Cevapla"yı kullanabilirsin.');
        if (!progress.forwarded) {
            try {
                await echo.forwardToAssistant(person, hermesText(items), `${messageId}.inbox`);
            } catch (error) {
                error.userMessage = 'Hermes’e iletemedim; lütfen biraz sonra tekrar dene.';
                throw giveUp(error);
            }
            progress.forwarded = true;
        }
        say(items.length === 1 ? '🤖 Hermes’e ilettim; taslağı hazırlayınca sana gösterecek.' : '🤖 Hermes’e ilettim; etkileşimlere bakıp taslakları sana gösterecek.', true);
    }

    /** Sends the draft of an 'inbox_confirm' row, once per draft (decisions table + request_id). */
    async function send(echo, person, row, messageId, say) {
        const store = echo.store;
        const item = row.message.item;
        const current = decisionState(echo, row, person, messageId);
        if (current.state === 'done') return say('✅ Cevabın gönderildi.', true);
        if (current.state === 'busy') return say('Cevabın gönderiliyor.');
        if (current.state === 'taken') {
            const action = current.decision.action;
            if (action === 'cancel') return say('Bu taslağı iptal etmiştin; yeni bir cevap için bildirimi yanıtla.');
            if (action === 'replaced') return say('Bu taslağın yerine yenisini yazdın; son taslaktaki "Gönder"e bas.');
            return say('Bu cevap zaten gönderildi.');
        }
        if (current.state === 'fresh') {
            if (!store.startDecision(row.id, person.phone, 'send', messageId, row.message.requestId)) return say('Bu cevap zaten gönderiliyor.');
        }
        let result;
        try {
            result = await api('POST', `${itemPath(item)}/replies`, { text: row.message.draft, request_id: row.message.requestId });
        } catch (error) {
            // A temporary error keeps the started decision: the retry sends the same request_id.
            if (error.retryable) throw giveUp(error);
            store.undecide(row.id, person.phone, messageId);
            if (error.status === 409) {
                offerRead(echo, person, item, '⌛ Bu etkileşimin cevap süresi dolmuş; cevabın gönderilemedi.', messageId);
                return;
            }
            if (error.status === 422) {
                const body = error.body && typeof error.body === 'object' ? error.body : {};
                const reason = body.errors?.text?.[0] ?? body.message ?? 'metin kabul edilmedi';
                return say(`Cevabın gönderilemedi: ${String(reason).slice(0, 300)}\nMetni değiştirmek için "Düzenle"ye bas.`);
            }
            throw giveUp(error);
        }
        store.applyDecision(row.id, person.phone);
        store.socialReplied(project.id, item.id, person.name);
        const status = String((result?.data ?? result)?.status ?? '');
        if (status === 'failed') return say('TryPost cevabı aldı ama platforma iletemedi; lütfen panelden kontrol et.', true);
        say(`✅ Cevabın gönderildi (${label(item)}, ${who(item)}).`, true);
    }

    return {
        enabled: Boolean(settings.enabled),

        async handleEvent(event, echo) {
            const item = event.data?.item;
            if (!settings.enabled) {
                echo.log('info', `inbox of ${project.id} is off, item ignored`);
                return;
            }
            if (!item?.id) {
                echo.log('warn', `inbox event of ${project.id} without an item id`);
                return;
            }
            const store = echo.store;
            // One transaction: the item is recorded together with its notifications, so a crash leaves both or neither.
            store.transaction(() => {
                const now = store.now();
                const hold =
                    inQuietHours(now) || store.socialHeld(project.id).length > 0 || store.socialRecent(project.id, now - windowMs) >= threshold;
                if (!store.socialAdd(project.id, item, hold ? 'held' : 'notified')) return; // seen before
                if (!hold) queueItem(echo, item);
            });
        },

        /** Sends held items once the burst window (and quiet hours) are over: one alone, several as a digest. */
        async periodic(echo) {
            if (!settings.enabled) return;
            const store = echo.store;
            const held = store.socialHeld(project.id);
            if (!held.length) return;
            const now = store.now();
            if (inQuietHours(now) || now < held[0].received_at + windowMs) return;
            store.transaction(() => {
                const items = store.socialHeld(project.id);
                if (!items.length) return;
                if (items.length === 1) {
                    store.socialMark(project.id, items[0].item_id, 'notified');
                    queueItem(echo, items[0].item);
                    return;
                }
                for (const row of items) store.socialMark(project.id, row.item_id, 'digested');
                queueDigest(echo, items.map((row) => row.item));
            });
        },

        async handleAction({ echo, person, row, action, messageId, progress = {} }) {
            const say = (text, final = false) => echo.reply(person, text, messageId, project.id, row.id, final ? `${project.id}:answer:${messageId}` : null);
            const item = row.message.item;
            const valid = {
                inbox: ['ib_reply', 'ib_hermes', 'ib_read'],
                inbox_note: ['ib_read'],
                inbox_confirm: ['ib_send', 'ib_edit', 'ib_cancel'],
                inbox_digest: ['ib_all_hermes', 'ib_all_read'],
            };
            if (!valid[row.kind]?.includes(action)) return say('Bu buton artık geçerli değil.');

            if (action === 'ib_reply') {
                let current = item;
                try {
                    const json = await api('GET', itemPath(item));
                    current = { ...item, ...(json?.data ?? json ?? {}) };
                } catch (error) {
                    if (error.status === 404) return say('Bu etkileşim artık bulunamadı; silinmiş olabilir.');
                    // TryPost unreachable: the notification's copy is enough to ask for the text.
                }
                if (current.can_reply === false) return offerRead(echo, person, current, 'Bu etkileşime buradan cevap verilemiyor.', messageId);
                if (windowClosed(current, echo.store.now())) return offerRead(echo, person, current, '⌛ Bu etkileşimin cevap süresi dolmuş.', messageId);
                echo.store.setSession(person.phone, row.id, 'inbox_reply');
                const replied = echo.store.socialItem(project.id, item.id)?.replied_by;
                say(
                    [
                        `✍️ Cevabını yaz: ${label(current)}, ${who(current)}: “${excerpt(current.text, 80)}”`,
                        ...(replied ? [`Not: ${replied} bu etkileşime zaten cevap verdi.`] : []),
                        'Göndermeden önce sana göstereceğim. Vazgeçmek için "iptal" yaz.',
                    ].join('\n'),
                );
                return;
            }
            if (action === 'ib_hermes') return toHermes(echo, person, [item], messageId, progress, say);
            if (action === 'ib_all_hermes') return toHermes(echo, person, row.message.items ?? [], messageId, progress, say);
            if (action === 'ib_read') {
                await markRead([item], progress);
                return say('✓ Okundu olarak işaretlendi.', true);
            }
            if (action === 'ib_all_read') {
                await markRead(row.message.items ?? [], progress);
                return say(`✓ ${(row.message.items ?? []).length} etkileşim okundu olarak işaretlendi.`, true);
            }
            if (action === 'ib_send') return send(echo, person, row, messageId, say);

            const decision = echo.store.decision(row.id, person.phone);
            if (decision?.action === 'send') return say(decision.state === 'applied' ? 'Bu cevap zaten gönderildi.' : 'Cevabın gönderiliyor.');
            if (action === 'ib_edit') {
                echo.store.setSession(person.phone, row.id, 'inbox_reply');
                return say('Yeni cevabını yaz; göndermeden önce yine sana göstereceğim. Vazgeçmek için "iptal" yaz.');
            }
            // ib_cancel
            if (!decision) {
                echo.store.startDecision(row.id, person.phone, 'cancel', messageId);
                echo.store.applyDecision(row.id, person.phone);
            }
            if (echo.store.session(person.phone)?.outbox_id === row.id) echo.store.clearSession(person.phone);
            say('Tamam, cevap gönderilmedi.', true);
        },

        /** A typed reply (in the "Cevapla" session, or a quote-reply to a notification or draft): shown back for confirmation. */
        async handleText({ echo, person, row, text, messageId }) {
            const say = (body) => echo.reply(person, body, messageId, project.id, row.id);
            if (row.kind === 'inbox_digest') {
                return say('Bu bir özet. Tek bir etkileşime cevap vermek için "Hermes’e bırak"ı kullan ya da panelden cevapla.');
            }
            const item = row.message.item;
            if (!item) return say('Bu mesaja cevap yazılamıyor.');
            if (item.can_reply === false) return offerRead(echo, person, item, 'Bu etkileşime buradan cevap verilemiyor.', messageId);
            if (windowClosed(item, echo.store.now())) return offerRead(echo, person, item, '⌛ Bu etkileşimin cevap süresi dolmuş.', messageId);
            const draft = String(text).trim();
            // A new draft for a draft replaces it: its "Gönder" no longer sends.
            if (row.kind === 'inbox_confirm' && !echo.store.decision(row.id, person.phone)) {
                echo.store.startDecision(row.id, person.phone, 'replaced', messageId);
                echo.store.applyDecision(row.id, person.phone);
            }
            const head = `📝 Şu cevabı göndereyim mi?\n${label(item)}, ${who(item)}: “${excerpt(item.text, 80)}”`;
            let body = `${head}\n\n${draft}`;
            if (body.length > CONFIRM_LIMIT) {
                echo.enqueue({
                    project: project.id,
                    itemId: String(item.id),
                    kind: 'inbox_note',
                    person,
                    message: { text: draft, item, replyTo: messageId, onlyInWindow: true },
                    dedupeKey: `${project.id}:inbox-draft:${messageId}`,
                });
                body = `${head}\n\n(Cevabın bir önceki mesajda.)`;
            }
            echo.enqueue({
                project: project.id,
                itemId: String(item.id),
                kind: 'inbox_confirm',
                person,
                message: {
                    text: body,
                    buttons: [
                        { action: 'ib_send', title: 'Gönder' },
                        { action: 'ib_edit', title: 'Düzenle' },
                        { action: 'ib_cancel', title: 'İptal' },
                    ],
                    item,
                    draft,
                    requestId: replyRequestId(project.id, messageId),
                    replyTo: messageId,
                    onlyInWindow: true,
                },
                dedupeKey: `${project.id}:inbox-confirm:${messageId}`,
            });
        },
    };
}
