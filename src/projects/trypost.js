import { createHash } from 'node:crypto';

const PLATFORMS = {
    instagram: 'Instagram',
    'instagram-facebook': 'Instagram',
    linkedin: 'LinkedIn',
    'linkedin-page': 'LinkedIn',
    x: 'X',
    tiktok: 'TikTok',
    facebook: 'Facebook',
    youtube: 'YouTube',
    threads: 'Threads',
    bluesky: 'Bluesky',
};

/**
 * A short fingerprint of what a reviewer looked at: text, media and time. A
 * reply to an older fingerprint is never applied to the current post.
 * Works on both the webhook payload and the API resource (their date formats
 * differ, so the time is compared to the minute in UTC).
 */
export function fingerprint(post) {
    const media = (post.media ?? []).map((item) => item?.id ?? item?.path ?? '').join(',');
    let minute = '';
    if (post.scheduled_at) {
        const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(post.scheduled_at) ? post.scheduled_at : `${post.scheduled_at.replace(' ', 'T')}Z`;
        const time = Date.parse(iso);
        minute = Number.isNaN(time) ? post.scheduled_at : String(Math.floor(time / 60_000));
    }
    return createHash('sha256')
        .update(`${String(post.content ?? '').trim()}\u0000${media}\u0000${minute}`)
        .digest('hex')
        .slice(0, 16);
}

export function createTryPostProject(project, { fetchImpl = globalThis.fetch, timeZone = 'Europe/Istanbul' } = {}) {
    const members = project.members;
    const memberByUserId = (id) => members.find((member) => member.userId && member.userId === id) ?? null;
    const memberByPhone = (phone) => members.find((member) => member.person.phone === phone) ?? null;
    const can = (member, role) => Boolean(member?.roles.includes(role));

    async function api(method, path, body) {
        const response = await fetchImpl(`${project.apiUrl.replace(/\/$/, '')}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${project.apiToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        if (!response.ok) {
            const error = new Error(`TryPost ${method} ${path} -> ${response.status}`);
            error.status = response.status;
            error.body = json ?? text;
            throw error;
        }
        return json;
    }

    const currentPost = async (id) => {
        try {
            const json = await api('GET', `/posts/${id}`);
            return json?.data ?? json;
        } catch (error) {
            if (error.status === 404) return null;
            throw error;
        }
    };

    const addNote = (postId, text) => api('POST', `/posts/${postId}/notes`, { body: text.slice(0, 2000) });

    const when = (iso) => {
        if (!iso) return 'Zaman seçilmedi (sıraya eklenecek)';
        const value = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`;
        return new Intl.DateTimeFormat('tr-TR', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    };
    const channel = (post) => {
        const account = post.social_account ?? {};
        const platform = PLATFORMS[account.platform ?? post.platform] ?? account.platform ?? post.platform ?? '';
        return [platform, account.display_name ?? post.display_name].filter(Boolean).join(' · ') || 'Kanal';
    };
    const excerpt = (content, length) => {
        const text = String(content ?? '').trim();
        if (!text) return '(Metin yok, sadece medya)';
        return text.length > length ? `${text.slice(0, length - 1)}…` : text;
    };
    const link = (post) => `${project.publicUrl.replace(/\/$/, '')}/schedule?edit=${post.id}`;
    const nameOf = (user) => memberByUserId(user?.id)?.person.name ?? user?.name ?? 'Bir ekip üyesi';

    function requestMessage(kind, post, { requesterName, note }) {
        const header = kind === 'approval' ? '📝 *Onayını bekleyen gönderi*' : '👀 *Görüşünü bekleyen içerik*';
        const lines = [
            header,
            `Proje: ${project.name}`,
            `Kanal: ${channel(post)}`,
            `${kind === 'approval' ? 'Onay isteyen' : 'Görüş isteyen'}: ${requesterName}`,
            `Yayın: ${when(post.scheduled_at)}`,
            ...(note ? [`Not: ${note}`] : []),
            '',
            excerpt(post.content, 600),
            '',
            `Panelde aç: ${link(post)}`,
            'Yorum yazmak için bu mesajı yanıtlayabilirsin.',
        ];
        const buttons =
            kind === 'approval'
                ? [
                      { action: 'approve', title: 'Onayla' },
                      { action: 'revise', title: 'Düzeltme iste' },
                      { action: 'comment', title: 'Yorum yaz' },
                  ]
                : [
                      { action: 'ok', title: 'Uygun' },
                      { action: 'revise', title: 'Revize gerekli' },
                      { action: 'comment', title: 'Yorum yaz' },
                  ];
        const templateName = project.templates?.[kind];
        const template = templateName
            ? {
                  name: templateName,
                  language: project.templates.language ?? 'tr',
                  // Template body: {{1}} project, {{2}} requester, {{3}} channel, {{4}} time, {{5}} excerpt
                  params: [project.name, requesterName, channel(post), when(post.scheduled_at), excerpt(post.content, 250)],
              }
            : null;
        return { message: { text: lines.join('\n'), buttons }, template };
    }

    function queueRequest(echo, kind, post, member, { requesterName, note = null, dedupeKey }) {
        const { message, template } = requestMessage(kind, post, { requesterName, note });
        return echo.enqueue({
            project: project.id,
            itemId: post.id,
            kind,
            person: member.person,
            message: { ...message, requesterName, note },
            template,
            fingerprint: fingerprint(post),
            dedupeKey,
        });
    }

    function notify(echo, member, text, dedupeKey, itemId) {
        echo.enqueue({
            project: project.id,
            itemId,
            kind: 'info',
            person: member.person,
            message: { text, onlyInWindow: true },
            dedupeKey,
        });
    }

    /** Re-reads the post. Returns it when the reply still applies, otherwise answers and returns null. */
    async function checkCurrent(echo, person, row, messageId, { decision = true } = {}) {
        const post = await currentPost(row.item_id);
        if (!post) {
            echo.reply(person, 'Bu gönderi silinmiş, işlem yapılmadı.', messageId, project.id);
            return null;
        }
        if (row.fingerprint && fingerprint(post) !== row.fingerprint) {
            echo.reply(person, 'Bu içerik sen baktıktan sonra değişti, eski mesaja verilen cevabı uygulamadım. Güncel hâlini gönderiyorum.', messageId, project.id);
            const member = memberByPhone(person.phone);
            if (member) {
                queueRequest(echo, row.kind, post, member, {
                    requesterName: row.message.requesterName ?? 'Bir ekip üyesi',
                    note: row.message.note,
                    dedupeKey: `${project.id}:refresh:${row.id}:${fingerprint(post)}:${person.id}`,
                });
            }
            return null;
        }
        if (decision && row.kind === 'approval' && post.status !== 'pending_approval') {
            echo.reply(person, 'Bu gönderi artık onay beklemiyor; başka biri karar vermiş ya da gönderi değişmiş.', messageId, project.id);
            return null;
        }
        return post;
    }

    const explain = (error) => {
        if (error.status === 403) return 'Bu işlem için TryPost yetkim yok, yöneticiye haber ver.';
        if (error.status === 404) return 'Gönderi bulunamadı, silinmiş olabilir.';
        if (error.status === 422) return 'TryPost bu işlemi kabul etmedi; gönderi artık bu durumda olmayabilir.';
        return 'Bir sorun oldu; birazdan tekrar dene ya da paneli kullan.';
    };

    return {
        async handleEvent(event, echo) {
            const post = event.data ?? {};
            const eventKey = `${project.id}:${event.id ?? `${event.type}:${post.id}:${fingerprint(post)}`}`;

            if (event.type === 'post.approval_requested') {
                const requester = post.approval?.requested_by ?? post.author ?? {};
                for (const member of members) {
                    if (!can(member, 'approver') || member.userId === requester.id) continue;
                    queueRequest(echo, 'approval', post, member, { requesterName: nameOf(requester), dedupeKey: `${eventKey}:${member.person.id}` });
                }
                return;
            }

            if (event.type === 'post.feedback_requested') {
                const feedback = post.feedback ?? {};
                for (const recipient of feedback.recipients ?? []) {
                    const member = memberByUserId(recipient.id);
                    if (!member) {
                        echo.log('warn', `no WhatsApp number for TryPost user ${recipient.id}`);
                        await addNote(post.id, `⚠️ ${recipient.name ?? 'Bir kişi'} için WhatsApp numarası tanımlı değil, görüş isteği gönderilemedi.`).catch(() => {});
                        continue;
                    }
                    queueRequest(echo, 'feedback', post, member, {
                        requesterName: nameOf(feedback.requested_by),
                        note: feedback.note ?? null,
                        dedupeKey: `${eventKey}:${member.person.id}`,
                    });
                }
                return;
            }

            if (event.type === 'post.approved' || event.type === 'post.rejected') {
                const approval = post.approval ?? {};
                const requester = memberByUserId(approval.requested_by?.id);
                const decider = approval.decided_by ?? {};
                const text =
                    event.type === 'post.approved'
                        ? `✅ ${nameOf(decider)} gönderiyi onayladı: "${excerpt(post.content, 120)}" (${when(post.scheduled_at)})`
                        : `↩️ ${nameOf(decider)} gönderi için düzeltme istedi: "${excerpt(post.content, 120)}"\nNotlar panelde: ${link(post)}`;
                const recipients = [requester, ...members.filter((member) => can(member, 'approver'))]
                    .filter(Boolean)
                    .filter((member, index, list) => list.indexOf(member) === index)
                    .filter((member) => member.userId !== decider.id);
                for (const member of recipients) notify(echo, member, text, `${eventKey}:${member.person.id}`, post.id);
            }
        },

        async handleAction({ echo, person, row, action, messageId }) {
            const member = memberByPhone(person.phone);
            if (!member) return;
            const isApproval = row.kind === 'approval';

            if (isApproval && (action === 'approve' || action === 'revise') && !can(member, 'approver')) {
                echo.reply(person, 'Onay verme yetkin yok; yorum yazabilirsin.', messageId, project.id);
                return;
            }
            if (!isApproval && !can(member, 'reviewer') && !can(member, 'approver')) {
                echo.reply(person, 'Bu projede görüş verme yetkin yok.', messageId, project.id);
                return;
            }
            if (!['approve', 'ok', 'revise', 'comment'].includes(action) || (isApproval && action === 'ok') || (!isApproval && action === 'approve')) {
                echo.reply(person, 'Bu buton artık geçerli değil.', messageId, project.id);
                return;
            }

            let post;
            try {
                post = await checkCurrent(echo, person, row, messageId, { decision: action !== 'comment' });
            } catch (error) {
                echo.reply(person, explain(error), messageId, project.id);
                return;
            }
            if (!post) return;

            if (action === 'approve' || action === 'ok') {
                // A double tap (or a retried webhook) acts once.
                if (!echo.store.decide(row.id, person.phone, action)) {
                    echo.reply(person, 'Bu içerik için cevabını zaten aldım.', messageId, project.id);
                    return;
                }
                try {
                    if (action === 'approve') {
                        await api('POST', `/posts/${post.id}/approve`, {});
                        await addNote(post.id, `✅ ${person.name} onayladı (WhatsApp).`).catch(() => {});
                        echo.reply(person, '✅ Onaylandı. Gönderi planlanan zamanda yayınlanacak.', messageId, project.id);
                    } else {
                        await addNote(post.id, `👍 ${person.name}: Uygun (WhatsApp).`);
                        echo.reply(person, '👍 Teşekkürler, görüşün eklendi.', messageId, project.id);
                    }
                } catch (error) {
                    echo.store.undecide(row.id, person.phone);
                    echo.log('error', 'trypost action failed', error.message);
                    echo.reply(person, explain(error), messageId, project.id);
                }
                return;
            }

            echo.store.setSession(person.phone, row.id, action);
            echo.reply(
                person,
                action === 'revise'
                    ? isApproval
                        ? 'Ne düzeltilsin? Yazdığın not gönderiye eklenecek ve gönderi hazırlayana geri dönecek. Vazgeçmek için "iptal" yaz.'
                        : 'Neyin revize edilmesini istiyorsun? Yazdığın not içeriğe eklenecek. Vazgeçmek için "iptal" yaz.'
                    : 'Yorumunu yaz, içeriğin notlarına eklenecek. Vazgeçmek için "iptal" yaz.',
                messageId,
                project.id,
            );
        },

        async handleText({ echo, person, row, mode, text, messageId }) {
            const member = memberByPhone(person.phone);
            if (!member) return;
            let post;
            try {
                post = await checkCurrent(echo, person, row, messageId, { decision: mode === 'revise' });
                if (!post) return;
                if (mode === 'revise' && row.kind === 'approval') {
                    if (!can(member, 'approver')) {
                        echo.reply(person, 'Onay verme yetkin yok; yorumunu not olarak ekledim.', messageId, project.id);
                        await addNote(post.id, `💬 ${person.name}: ${text}`);
                        return;
                    }
                    if (!echo.store.decide(row.id, person.phone, 'revise')) {
                        echo.reply(person, 'Bu içerik için kararını zaten aldım; notunu yine de ekledim.', messageId, project.id);
                        await addNote(post.id, `💬 ${person.name}: ${text}`);
                        return;
                    }
                    await addNote(post.id, `✏️ ${person.name} düzeltme istedi (WhatsApp): ${text}`);
                    await api('POST', `/posts/${post.id}/reject`, {});
                    echo.reply(person, '↩️ Not eklendi, gönderi düzeltme için geri gönderildi.', messageId, project.id);
                    return;
                }
                if (mode === 'revise') {
                    await addNote(post.id, `✏️ ${person.name}: Revize gerekli (WhatsApp): ${text}`);
                    echo.reply(person, '✏️ Revize notun içeriğe eklendi.', messageId, project.id);
                    return;
                }
                await addNote(post.id, `💬 ${person.name} (WhatsApp): ${text}`);
                echo.reply(person, '💬 Yorumun eklendi.', messageId, project.id);
            } catch (error) {
                if (mode === 'revise') echo.store.undecide(row.id, person.phone);
                echo.log('error', 'trypost note failed', error.message);
                echo.reply(person, explain(error), messageId, project.id);
            }
        },

        async onDeliveryFailed({ row, person, reason }) {
            if (!row.item_id) return;
            await addNote(row.item_id, `⚠️ ${person?.name ?? row.recipient} kişisine WhatsApp mesajı iletilemedi: ${reason}`);
        },
    };
}
