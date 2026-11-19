import { createHash } from 'node:crypto';
import { minutesOf } from '../config.js';

const DIGEST_LINES = 8;
// Re-checks of a reply TryPost accepted but had not sent yet: waits before each one (bounded).
const CHECK_BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000];
const NO_PERMISSION = 'Bu etkileşime cevap verme yetkin yok.';
// Buttons only people who may reply get (Hermes replies with the same TryPost token).
const REPLIER_ACTIONS = new Set(['ib_reply', 'ib_hermes', 'ib_all_hermes', 'ib_send', 'ib_edit', 'ib_cancel']);
// Interactive message bodies take 1024 characters: a longer draft is shown in a message of its own first.
const CONFIRM_LIMIT = 1000;

// Turkish suffixes: the locative after a clock time ("01:06’da": by how the last number is said) and the genitive.
const ONES_LOCATIVE = ['da', 'de', 'de', 'te', 'te', 'te', 'da', 'de', 'de', 'da'];
const TENS_LOCATIVE = { 1: 'da', 2: 'de', 3: 'da', 4: 'ta', 5: 'de' };
const locative = (number) => (number % 10 || number === 0 ? ONES_LOCATIVE[number % 10] : TENS_LOCATIVE[number / 10]);
const VOWELS = 'aıoueiöü';
/** "@ali" -> "@ali’nin", "Ayşe Kaya" -> "Ayşe Kaya’nın" (vowel harmony on the last vowel). */
export function genitive(word) {
    const letters = [...String(word).toLocaleLowerCase('tr')];
    const vowel = letters.findLast((letter) => VOWELS.includes(letter));
    const suffix = { a: 'ın', ı: 'ın', o: 'un', u: 'un', e: 'in', i: 'in', ö: 'ün', ü: 'ün' }[vowel] ?? 'in';
    return `${word}’${VOWELS.includes(letters.at(-1)) ? 'n' : ''}${suffix}`;
}

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
 * or a long draft's text), 'inbox_failed' (TryPost could not send a reply:
 * "Düzenle" / "Okundu"). The outbox row is the link from a WhatsApp message
 * (button or quote-reply) back to the item, as for approval requests.
 *
 * Who is notified (recipients) and who may reply (canReply: `inbox.repliers`,
 * by default the approvers) are separate. Others get "Okundu" only, and their
 * presses and typed replies are refused on the server side.
 *
 * Only a reply TryPost reports as `sent` is told as sent. `sending`/`pending`
 * keeps the decision open and is re-checked on the worker's passes by
 * replaying the POST with the same request_id, until `sent` or `failed`
 * (bounded); `failed` is reported with "Düzenle".
 *
 * Several people get every item: "Cevapla" and a typed draft read the item
 * from TryPost first, and a reply already sent from anywhere (Echo, Hermes,
 * the panel) is shown ("Not: Yasir 01:06’da cevap verdi: …") and turns
 * "Gönder" into "Yine de gönder". Once a reply is `sent`, the others who got
 * the item's notification are told, inside their 24-hour window only.
 */
export function createInbox({ project, api, names, timeZone, platformName, decisionState, recipients, canReply }) {
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
    const accusative = (item) => `${platform(item)} ${item.kind === 'message' ? 'mesajını' : item.kind === 'comment' ? 'yorumunu' : 'etkileşimini'}`;
    const windowClosed = (item, now) => Boolean(item.reply_window_ends_at) && toTime(item.reply_window_ends_at) <= now;
    // The item without its thread and replies (TryPost's detail), as kept in outbox rows.
    const slim = ({ thread, replies, ...rest }) => rest;
    const itemPath = (item) => `/inbox/items/${encodeURIComponent(String(item.id))}`;

    /** "01:06’da" (with the day when it is not today), in the project's time zone. */
    function atTime(ms, now) {
        const hm = new Intl.DateTimeFormat('tr-TR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
        const [hour, minute] = hm.split(':').map(Number);
        const day = (value) => new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(value));
        const date = day(ms) === day(now) ? '' : `${new Intl.DateTimeFormat('tr-TR', { timeZone, day: 'numeric', month: 'long' }).format(new Date(ms))} `;
        return `${date}${hm}’${locative(minute || hour)}`;
    }

    /** Fetches the item from TryPost: { item } (merged over the snapshot), { item, stale: true } when TryPost could not answer, { gone: true } on 404. */
    async function fetchCurrent(item) {
        try {
            const json = await api('GET', itemPath(item));
            return { item: { ...item, ...(json?.data ?? json ?? {}) } };
        } catch (error) {
            if (error.status === 404) return { gone: true, item };
            return { item, stale: true };
        }
    }

    /**
     * The last reply already sent to the item, from anywhere (Echo, Hermes, the panel): TryPost's
     * `replies` when it gave them, else what went through Echo. { name, at, text } or null. The
     * name is the reply's author when TryPost gives one, else the person who sent the same text
     * through Echo, else "biri".
     */
    function previousReply(echo, item, current) {
        const drafts = echo.store.itemSentDrafts(project.id, item.id);
        if (Array.isArray(current?.replies)) {
            const last = current.replies.filter((reply) => reply?.status === 'sent').at(-1);
            if (!last) return null;
            const text = String(last.text ?? '');
            const match = drafts.findLast((draft) => draft.draft.trim() === text.trim());
            const author = [last.author?.name, last.user?.name, last.sent_by?.name].find((name) => typeof name === 'string' && name.trim());
            const at = toTime(last.sent_at ?? last.created_at);
            return {
                name: author?.trim() ?? (match && echo.personByPhone(match.phone)?.name) ?? 'biri',
                at: Number.isNaN(at) ? (match?.at ?? null) : at,
                text,
            };
        }
        const row = echo.store.socialItem(project.id, item.id);
        if (!row?.replied_by) return null;
        return { name: row.replied_by, at: row.replied_at, text: drafts.at(-1)?.draft ?? null };
    }

    const replyNote = (previous, now) =>
        `Not: ${previous.name} ${previous.at ? `${atTime(previous.at, now)} ` : 'bu etkileşime zaten '}cevap verdi${previous.text ? `: “${excerpt(previous.text, 120)}”` : '.'}`;

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
    function itemMessage(item, replier) {
        const lines = [`📥 *${label(item)}* — ${who(item)}: “${excerpt(item.text, 500)}”`];
        if (item.post) lines.push(`Gönderi: “${excerpt(item.post.excerpt, 80)}”`);
        if (item.reply_window_ends_at) lines.push(`Cevap süresi: ${when(item.reply_window_ends_at)}’e kadar`);
        if (item.can_reply === false) lines.push('Bu etkileşime buradan cevap verilemiyor.');
        if (item.permalink) lines.push(`🔗 ${item.permalink}`);
        if (replier && item.can_reply !== false) lines.push('', 'Cevap yazmak için bu mesajı yanıtlayabilirsin.');
        // Template body: {{1}} platform, {{2}} kind (yorum / mesaj), {{3}} "@author: text"
        const name = replier ? names.inbox : names.inboxReadOnly;
        const template = name ? { name, language: names.language, params: [platform(item), kindWord(item), `${who(item)}: ${excerpt(item.text, 200)}`] } : null;
        const buttons = replier ? notifyButtons : notifyButtons.filter((button) => button.action === 'ib_read');
        return { message: { text: lines.join('\n'), buttons, item }, template };
    }

    function digestMessage(items, replier) {
        const lines = [`📥 *${items.length} yeni etkileşim var*`];
        for (const item of items.slice(0, DIGEST_LINES)) lines.push(`• ${label(item)} — ${who(item)}: “${excerpt(item.text, 60)}”`);
        if (items.length > DIGEST_LINES) lines.push(`… ve ${items.length - DIGEST_LINES} tane daha`);
        lines.push('', replier ? 'Hermes’e bırakırsan cevap gerekenler için taslak hazırlar; tek tek panelden de bakabilirsin.' : 'Ayrıntılar panelde.');
        const counts = new Map();
        for (const item of items) counts.set(platform(item), (counts.get(platform(item)) ?? 0) + 1);
        const channels = [...counts].map(([name, count]) => `${name} (${count})`).join(', ');
        // Template body: {{1}} count, {{2}} channels with counts
        const name = replier ? names.inboxDigest : names.inboxDigestReadOnly;
        const template = name ? { name, language: names.language, params: [String(items.length), channels] } : null;
        const buttons = [
            ...(replier ? [{ action: 'ib_all_hermes', title: 'Hermes’e bırak' }] : []),
            { action: 'ib_all_read', title: 'Hepsi okundu' },
        ];
        return { message: { text: lines.join('\n'), buttons, items }, template };
    }

    function queueItem(echo, item) {
        for (const member of recipients()) {
            const { message, template } = itemMessage(item, canReply(member.person));
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
        for (const member of recipients()) {
            const { message, template } = digestMessage(items, canReply(member.person));
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
                `[Echo · Gelen kutusu] Bu ${kindWord(item)}a cevap taslağı hazırla ve göndermek için onayıma sun; onaylamadan gönderme.`,
                '',
                describe(item),
            ].join('\n');
        }
        return [
            `[Echo · Gelen kutusu] ${items.length} yeni etkileşim var. Hangilerine cevap gerektiğini söyle ve onlar için cevap taslakları hazırlayıp her birini ayrı ayrı onayıma sun; onaylamadan hiçbirini gönderme.`,
            ...items.map((item, index) => `\n${index + 1})\n${describe(item)}`),
        ].join('\n');
    }

    async function toHermes(echo, person, items, messageId, progress, say) {
        if (!echo.hasAssistant()) return say('Hermes bağlı değil; cevabı panelden yazabilir ya da "Cevapla"yı kullanabilirsin.');
        if (!echo.assistantAllowed(person)) return say('Asistanı kullanma yetkin yok; onay/görüş mesajları çalışmaya devam ediyor.');
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
        // 'done' (this tap applied it) is answered by sent(); a retry of the tap only repeats the dedup-keyed answer.
        if (current.state === 'done') return say('✅ Cevabın gönderildi.', true);
        if (current.state === 'busy') return say('⏳ Cevabın gönderiliyor.');
        if (current.state === 'taken') {
            const action = current.decision.action;
            if (action === 'cancel') return say('Bu taslağı iptal etmiştin; yeni bir cevap için bildirimi yanıtla.');
            if (action === 'replaced') return say('Bu taslağın yerine yenisini yazdın; son taslaktaki "Gönder"e bas.');
            if (action === 'failed') return say('Bu cevap gönderilemedi; metni değiştirip yeniden denemek için "Düzenle"ye bas.');
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
        const reply = result?.data ?? result ?? {};
        const status = String(reply.status ?? '');
        if (status === 'sent') {
            store.replyCheckDone(row.id, person.phone);
            return sent(echo, person, row, messageId);
        }
        if (status === 'failed') return failed(echo, person, row, reply, messageId);
        // Accepted, not sent yet: the decision stays open and the worker checks again with the same request_id.
        store.checkReply(row.id, person.phone, project.id, CHECK_BACKOFF_MS[0]);
        say('⏳ Gönderiliyor… Gönderilince haber vereceğim.', true);
    }

    function sent(echo, person, row, messageId) {
        const item = row.message.item;
        echo.store.applyDecision(row.id, person.phone);
        echo.store.socialReplied(project.id, item.id, person.name);
        echo.reply(person, `✅ Cevabın gönderildi (${label(item)}, ${who(item)}).`, messageId, project.id, row.id, `${project.id}:inbox-sent:${row.id}:${person.phone}`);
        notifyOthers(echo, person, row);
    }

    /**
     * Tells everyone else who was notified of the item that it was answered, as a reply to their
     * notification. Only inside their 24-hour window (no template is paid for this); replies made
     * through Hermes or the panel are not seen here (the next "Cevapla" shows them).
     */
    function notifyOthers(echo, person, row) {
        const item = row.message.item;
        const notified = new Map(echo.store.itemNotified(project.id, item.id).map((entry) => [entry.recipient, entry.wa_message_id]));
        // Sent in a digest: everyone who gets the inbox saw it there.
        if (echo.store.socialItem(project.id, item.id)?.state === 'digested') {
            for (const member of recipients()) if (!notified.has(member.person.phone)) notified.set(member.person.phone, null);
        }
        const author = who(item) === 'Biri' ? 'birinin' : genitive(who(item));
        const text = `✅ ${person.name}, ${author} ${accusative(item)} cevapladı: “${excerpt(row.message.draft, 300)}”`;
        for (const [phone, waId] of notified) {
            if (phone === person.phone) continue;
            const other = echo.personByPhone(phone);
            if (!other) continue;
            echo.enqueue({
                project: project.id,
                itemId: String(item.id),
                kind: 'inbox_note',
                person: other,
                message: { text, item, ...(waId ? { replyTo: waId } : {}), onlyInWindow: true },
                dedupeKey: `${project.id}:inbox-replied:${row.id}:${phone}`,
            });
        }
    }

    /** TryPost could not send it: the draft is closed (its request_id would replay the failure); "Düzenle" starts a new one. */
    function failed(echo, person, row, reply, messageId) {
        const store = echo.store;
        const item = row.message.item;
        store.replyCheckDone(row.id, person.phone);
        store.undecideAny(row.id, person.phone);
        store.startDecision(row.id, person.phone, 'failed', messageId);
        store.applyDecision(row.id, person.phone);
        const reason = reply.error ?? reply.failure_reason ?? reply.message ?? null;
        echo.enqueue({
            project: project.id,
            itemId: String(item.id),
            kind: 'inbox_failed',
            person,
            message: {
                text: `❌ Cevabın gönderilemedi${reason ? `: ${String(reason).slice(0, 300)}` : '.'}\nMetni değiştirip yeniden denemek için "Düzenle"ye bas.`,
                buttons: [
                    { action: 'ib_edit', title: 'Düzenle' },
                    { action: 'ib_read', title: 'Okundu' },
                ],
                item,
                replyTo: messageId,
            },
            dedupeKey: `${project.id}:inbox-failed:${row.id}:${person.phone}`,
        });
    }

    /** Re-checks replies TryPost had not sent yet, replaying the POST with the same request_id. */
    async function checkReplies(echo) {
        const store = echo.store;
        for (const check of store.replyChecksDue(project.id)) {
            const row = store.outbox(check.outbox_id);
            const person = echo.personByPhone(check.phone);
            const decision = store.decision(check.outbox_id, check.phone);
            if (!row || !person || decision?.state !== 'started') {
                store.replyCheckDone(check.outbox_id, check.phone);
                continue;
            }
            const later = () => {
                const attempts = store.replyCheckLater(row.id, person.phone, CHECK_BACKOFF_MS[Math.min(check.attempts + 1, CHECK_BACKOFF_MS.length - 1)]);
                if (attempts < CHECK_BACKOFF_MS.length) return;
                // Given up: the decision stays started, so a new "Gönder" checks again with the same request_id.
                store.replyCheckDone(row.id, person.phone);
                echo.reply(person, 'Cevabın hâlâ gönderiliyor görünüyor; durumunu doğrulayamadım. Lütfen panelden kontrol et.', null, project.id, row.id, `${project.id}:inbox-unknown:${row.id}:${person.phone}`);
            };
            let reply;
            try {
                const result = await api('POST', `${itemPath(row.message.item)}/replies`, { text: row.message.draft, request_id: row.message.requestId });
                reply = result?.data ?? result ?? {};
            } catch (error) {
                if (error.retryable) {
                    later();
                    continue;
                }
                reply = { status: 'failed', error: error.status === 409 ? 'cevap süresi dolmuş' : (error.body?.message ?? `TryPost ${error.status}`) };
            }
            if (reply.status === 'sent') {
                store.replyCheckDone(row.id, person.phone);
                sent(echo, person, row, decision.wa_message_id);
            } else if (reply.status === 'failed') {
                failed(echo, person, row, reply, decision.wa_message_id);
            } else {
                later();
            }
        }
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
            await checkReplies(echo);
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
                inbox_failed: ['ib_edit', 'ib_read'],
            };
            if (!valid[row.kind]?.includes(action)) return say('Bu buton artık geçerli değil.');
            // Checked on every press: a button sent before a role change (or forwarded) does not grant anything.
            if (REPLIER_ACTIONS.has(action) && !canReply(person)) return say(NO_PERMISSION);

            if (action === 'ib_reply') {
                // TryPost unreachable: the notification's copy is enough to ask for the text.
                const fetched = await fetchCurrent(item);
                if (fetched.gone) return say('Bu etkileşim artık bulunamadı; silinmiş olabilir.');
                const current = slim(fetched.item);
                if (current.can_reply === false) return offerRead(echo, person, current, 'Bu etkileşime buradan cevap verilemiyor.', messageId);
                if (windowClosed(current, echo.store.now())) return offerRead(echo, person, current, '⌛ Bu etkileşimin cevap süresi dolmuş.', messageId);
                echo.store.setSession(person.phone, row.id, 'inbox_reply');
                const previous = previousReply(echo, item, fetched.item);
                say(
                    [
                        `✍️ Cevabını yaz: ${label(current)}, ${who(current)}: “${excerpt(current.text, 80)}”`,
                        ...(previous ? [replyNote(previous, echo.store.now())] : []),
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
            if (decision?.action === 'send') return say(decision.state === 'applied' ? 'Bu cevap zaten gönderildi.' : '⏳ Cevabın gönderiliyor.');
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
            if (!canReply(person)) return say(NO_PERMISSION);
            if (row.kind === 'inbox_digest') {
                return say('Bu bir özet. Tek bir etkileşime cevap vermek için "Hermes’e bırak"ı kullan ya da panelden cevapla.');
            }
            const item = row.message.item;
            if (!item) return say('Bu mesaja cevap yazılamıyor.');
            // Fresh from TryPost: whether it can still be answered, and whether someone already did (Echo, Hermes or the panel).
            const fetched = await fetchCurrent(item);
            if (fetched.gone) return say('Bu etkileşim artık bulunamadı; silinmiş olabilir.');
            const current = slim(fetched.item);
            if (current.can_reply === false) return offerRead(echo, person, current, 'Bu etkileşime buradan cevap verilemiyor.', messageId);
            if (windowClosed(current, echo.store.now())) return offerRead(echo, person, current, '⌛ Bu etkileşimin cevap süresi dolmuş.', messageId);
            const previous = previousReply(echo, item, fetched.item);
            const draft = String(text).trim();
            // A new draft for a draft replaces it: its "Gönder" no longer sends.
            if (row.kind === 'inbox_confirm' && !echo.store.decision(row.id, person.phone)) {
                echo.store.startDecision(row.id, person.phone, 'replaced', messageId);
                echo.store.applyDecision(row.id, person.phone);
            }
            const head = [
                '📝 Şu cevabı göndereyim mi?',
                `${label(item)}, ${who(item)}: “${excerpt(item.text, 80)}”`,
                // Already answered: sending another one takes an explicit "Yine de gönder".
                ...(previous ? [replyNote(previous, echo.store.now())] : []),
            ].join('\n');
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
                        { action: 'ib_send', title: previous ? 'Yine de gönder' : 'Gönder' },
                        { action: 'ib_edit', title: 'Düzenle' },
                        { action: 'ib_cancel', title: 'İptal' },
                    ],
                    item,
                    draft,
                    ...(previous ? { answered: true } : {}),
                    requestId: replyRequestId(project.id, messageId),
                    replyTo: messageId,
                    onlyInWindow: true,
                },
                dedupeKey: `${project.id}:inbox-confirm:${messageId}`,
            });
        },
    };
}
