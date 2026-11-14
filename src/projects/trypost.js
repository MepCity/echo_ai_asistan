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

/**
 * The version Echo showed a person, stored as the outbox fingerprint. TryPost's
 * own `content_version` ("tp:") is preferred and is sent back as
 * `expected_version`, so TryPost refuses (409) an approval of changed content
 * inside its own transaction. Echo's hash ("echo:") is kept beside it for older
 * TryPost versions that do not send one. A bare hash is an Echo hash stored
 * before versions existed.
 */
export function versionTag(post) {
    const echo = `echo:${fingerprint(post)}`;
    return post.content_version ? `tp:${post.content_version} ${echo}` : echo;
}

export function parseVersion(stored) {
    const parts = { tp: null, echo: null };
    for (const part of String(stored ?? '').split(' ').filter(Boolean)) {
        if (part.startsWith('tp:')) parts.tp = part.slice(3);
        else if (part.startsWith('echo:')) parts.echo = part.slice(5);
        else parts.echo = part;
    }
    return parts;
}

/** Compares like with like: TryPost's version when both sides have one, otherwise Echo's hash. */
export function sameVersion(stored, post) {
    const { tp, echo } = parseVersion(stored);
    if (tp && post.content_version) return tp === String(post.content_version);
    if (echo) return echo === fingerprint(post);
    return !tp; // only a TryPost version was stored and TryPost no longer sends one: cannot tell, treat as changed
}

/** Parses both date formats (webhook ISO 8601, API "Y-m-d H:i:s" in UTC). */
const toTime = (value) => {
    if (!value) return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const VIDEO_HEADER_LIMIT = 16 * 1024 * 1024;
const MORE_IMAGES = 4;

/**
 * The template names of a project. `approval` / `feedback` name the text
 * templates; the media variants default to "<name>_gorsel" / "<name>_video"
 * and the other templates to their standard names once `approval` (or
 * `feedback`) is set. A key set to null or "" turns that template off.
 */
export function templateNames(templates = {}) {
    const t = templates ?? {};
    const on = Boolean(t.approval || t.feedback);
    const pick = (key, fallback) => (t[key] !== undefined ? t[key] || null : (on && fallback) || null);
    return {
        language: t.language ?? 'tr',
        approval: t.approval || null,
        approvalImage: pick('approvalImage', t.approval && `${t.approval}_gorsel`),
        approvalVideo: pick('approvalVideo', t.approval && `${t.approval}_video`),
        feedback: t.feedback || null,
        feedbackImage: pick('feedbackImage', t.feedback && `${t.feedback}_gorsel`),
        feedbackVideo: pick('feedbackVideo', t.feedback && `${t.feedback}_video`),
        alert: pick('alert', 'yayin_hatasi'),
        reminder: pick('reminder', 'onay_hatirlatma'),
        digest: pick('digest', 'gunluk_ozet'),
    };
}

const extension = (url) => (String(url ?? '').split('?')[0].match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();

/** image / video / document / null, the way TryPost classifies: the stored type, then the MIME type, then the path. */
function mediaType(item) {
    if (item.type) return item.type;
    const mime = String(item.mime_type ?? '');
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    const ext = extension(item.path ?? item.url);
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
    if (['mp4', 'mov', '3gp', 'webm'].includes(ext)) return 'video';
    return mime ? 'document' : null;
}

// WhatsApp takes JPEG/PNG images and MP4/3GPP videos.
const imageOk = (item) => (item.mime_type ? /^image\/(jpe?g|png)$/i.test(item.mime_type) : ['jpg', 'jpeg', 'png'].includes(extension(item.path ?? item.url)));
const videoOk = (item) => (item.mime_type ? /^video\/(mp4|3gpp)$/i.test(item.mime_type) : ['mp4', '3gp', ''].includes(extension(item.path ?? item.url)));

/**
 * What of a post's media goes into a WhatsApp request: its first media as the
 * header (a JPEG/PNG image, or an MP4 video of at most 16 MB or of unknown
 * size), the next images (at most 4, sent before the request inside the
 * window), and a line for media that cannot be shown ("🎞 Video panelde").
 * TryPost stores absolute public URLs (Storage::url of the public disk or a
 * public bucket); a relative one is resolved against the panel's URL.
 */
export function pickMedia(post, publicUrl = '') {
    const absolute = (url) => {
        if (!url) return null;
        if (/^https?:\/\//i.test(url)) return url;
        if (url.startsWith('/') && /^https?:\/\//i.test(publicUrl)) return `${publicUrl.replace(/\/$/, '')}${url}`;
        return null;
    };
    const items = (post.media ?? []).filter((item) => item && typeof item === 'object');
    const describe = (item, type) => ({
        type,
        url: absolute(item.url),
        mime: item.mime_type ?? null,
        size: Number.isFinite(Number(item.size)) && item.size !== null ? Number(item.size) : null,
    });
    const first = items[0];
    const none = { header: null, missing: null, extras: [] };
    if (!first) return none;
    const type = mediaType(first);
    if (type === 'image') {
        const header = describe(first, 'image');
        if (!header.url || !imageOk(first)) return { ...none, missing: '🖼 Görsel panelde' };
        const extras = items
            .slice(1)
            .filter((item) => mediaType(item) === 'image' && imageOk(item) && absolute(item.url))
            .slice(0, MORE_IMAGES)
            .map((item) => describe(item, 'image'));
        return { header, missing: null, extras };
    }
    if (type === 'video') {
        const header = describe(first, 'video');
        const fits = header.size === null || header.size <= VIDEO_HEADER_LIMIT;
        if (!header.url || !videoOk(first) || !fits) return { ...none, missing: '🎞 Video panelde' };
        return { header, missing: null, extras: [] };
    }
    return none;
}

/** Date and time parts of a moment in a time zone. */
export function localParts(ms, timeZone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(new Date(ms))
            .map((part) => [part.type, part.value]),
    );
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
        hhmm: `${parts.hour}:${parts.minute}`,
        dayMonth: `${parts.day}.${parts.month}`,
    };
}

const REQUEST_ID = /^[A-Za-z0-9:._-]{1,100}$/;
const idPart = (value, length) => String(value ?? '').replace(/[^A-Za-z0-9._]/g, '_').slice(0, length) || 'x';

/**
 * The idempotency key of one approve/reject decision, sent as `request_id` on
 * every attempt of it. TryPost records it in the transaction that applies the
 * decision and answers a repeat with 200 `replayed: true`, so a retry after a
 * lost answer or a crash can tell "we did it" from "someone else did". Made
 * when the decision starts and stored with it: project, request (outbox id),
 * person, verb, start time, plus a few random characters in case the same
 * decision is started again within the same millisecond.
 */
export function requestIdFor({ project, outboxId, person, verb, startedAt }) {
    const nonce = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    const id = `echo-${idPart(project, 20)}-${idPart(outboxId, 12)}-${idPart(person, 20)}-${verb}-${Number(startedAt).toString(36)}${nonce}`;
    if (!REQUEST_ID.test(id)) throw new Error(`invalid request_id ${id}`);
    return id;
}

export function createTryPostProject(project, { fetchImpl = globalThis.fetch, timeZone = 'Europe/Istanbul' } = {}) {
    const members = project.members;
    const memberByUserId = (id) => members.find((member) => member.userId && member.userId === id) ?? null;
    const memberByPhone = (phone) => members.find((member) => member.person.phone === phone) ?? null;
    const can = (member, role) => Boolean(member?.roles.includes(role));
    const names = templateNames(project.templates);
    const unique = (list) => list.filter(Boolean).filter((member, index, all) => all.indexOf(member) === index);
    let lastReminderScan = -Infinity;

    async function api(method, path, body) {
        let response;
        try {
            response = await fetchImpl(`${project.apiUrl.replace(/\/$/, '')}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${project.apiToken}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (cause) {
            // Network errors (DNS, refused, timeout): TryPost is unreachable, try again later.
            throw Object.assign(new Error(`TryPost ${method} ${path} -> ${cause.message}`), { status: null, retryable: true });
        }
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
            error.retryable = response.status >= 500 || response.status === 429;
            throw error;
        }
        return json;
    }

    /**
     * Uploads a file to the workspace as a temporary upload (POST /uploads,
     * multipart field `media`). TryPost keeps it 24 hours; its `upload_token`
     * is spent by the first post that takes it as a media item.
     * `file` is a Blob (e.g. fs.openAsBlob, so a large video streams from disk).
     * The whole call (sending the file and reading the answer) is limited to `timeoutMs`;
     * running out of time is a retryable error.
     * @returns {Promise<{ uploadToken: string, type: string|null, expiresAt: string|null }>}
     */
    async function uploadMedia({ file, filename, mimeType, timeoutMs = 180_000 }) {
        const form = new FormData();
        form.append('media', file, filename);
        const path = '/uploads';
        const signal = AbortSignal.timeout(timeoutMs);
        let response;
        let text;
        try {
            response = await fetchImpl(`${project.apiUrl.replace(/\/$/, '')}${path}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${project.apiToken}`, Accept: 'application/json' },
                body: form,
                signal,
            });
            text = await response.text();
        } catch (cause) {
            const reason = signal.aborted ? `timed out after ${timeoutMs} ms` : cause.message;
            throw Object.assign(new Error(`TryPost POST ${path} -> ${reason}`), { status: null, retryable: true, timedOut: signal.aborted });
        }
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        if (!response.ok) {
            // 422: the file was refused (type, size, pixels); TryPost says why in errors.media.
            const reason = json?.errors?.media?.[0] ?? json?.message ?? null;
            const error = new Error(`TryPost POST ${path} -> ${response.status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}`);
            error.status = response.status;
            error.retryable = response.status >= 500 || response.status === 429;
            throw error;
        }
        const data = json?.data ?? json;
        if (!data?.upload_token) throw Object.assign(new Error(`TryPost POST ${path} returned no upload_token`), { retryable: true });
        return { uploadToken: String(data.upload_token), type: data.type ?? null, expiresAt: data.expires_at ?? null };
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
        return new Intl.DateTimeFormat('tr-TR', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(toTime(iso)));
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

    function requestMessage(kind, post, { requesterName, note, reminder = false }) {
        const { header, missing, extras } = pickMedia(post, project.publicUrl);
        const title = reminder
            ? '⏰ *Hatırlatma: onayını bekleyen gönderi*'
            : kind === 'approval'
              ? '📝 *Onayını bekleyen gönderi*'
              : '👀 *Görüşünü bekleyen içerik*';
        const body = (mediaLine) => [
            title,
            `Proje: ${project.name}`,
            `Kanal: ${channel(post)}`,
            `${kind === 'approval' ? 'Onay isteyen' : 'Görüş isteyen'}: ${requesterName}`,
            `Yayın: ${when(post.scheduled_at)}`,
            ...(note ? [`Not: ${note}`] : []),
            '',
            excerpt(post.content, 600),
            ...(mediaLine ? ['', mediaLine] : []),
            '',
            `Panelde aç: ${link(post)}`,
            'Yorum yazmak için bu mesajı yanıtlayabilirsin.',
        ].join('\n');
        const unshown = header?.type === 'video' ? '🎞 Video panelde' : '🖼 Görsel panelde';
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
        const message = {
            text: body(missing ?? (extras.length ? `🖼 1/${extras.length + 1}` : null)),
            buttons,
            ...(header ? { media: header, withoutMedia: body(unshown) } : {}),
        };

        const language = names.language;
        // A template parameter is one line: a missing media is said before the excerpt.
        const withLine = (params, line) => (line ? [...params.slice(0, -1), `${line} · ${params.at(-1)}`] : params);
        let template = null;
        if (reminder && names.reminder) {
            // Template body: {{1}} channel, {{2}} time, {{3}} excerpt
            const params = [channel(post), when(post.scheduled_at), excerpt(post.content, 250)];
            // No media header in this template: say where the media is.
            template = { name: names.reminder, language, params: withLine(params, missing ?? (header ? unshown : null)) };
        } else if (names[kind]) {
            // Template body: {{1}} project, {{2}} requester, {{3}} channel, {{4}} time, {{5}} excerpt
            const params = [project.name, requesterName, channel(post), when(post.scheduled_at), excerpt(post.content, 250)];
            const text = { name: names[kind], language, params: withLine(params, missing) };
            const variant = header && names[`${kind}${header.type === 'video' ? 'Video' : 'Image'}`];
            if (variant) {
                template = { name: variant, language, params, header: { type: header.type }, withoutMedia: { ...text, params: withLine(params, unshown) } };
            } else {
                template = header ? { ...text, params: withLine(params, unshown) } : text;
            }
        }
        return { message, template, extras };
    }

    function queueRequest(echo, kind, post, member, { requesterName, note = null, dedupeKey, reminder = false, moreImages = !reminder }) {
        const { message, template, extras } = requestMessage(kind, post, { requesterName, note, reminder });
        // The other images go first, as plain image messages, only inside the window (outside it only the template goes).
        if (moreImages) {
            extras.forEach((media, index) => {
                echo.enqueue({
                    project: project.id,
                    itemId: post.id,
                    kind: 'media',
                    person: member.person,
                    message: { text: `${index + 2}/${extras.length + 1}`, media, onlyInWindow: true },
                    dedupeKey: `${dedupeKey}:media:${index + 2}`,
                });
            });
        }
        return echo.enqueue({
            project: project.id,
            itemId: post.id,
            kind,
            person: member.person,
            message: { ...message, requesterName, note, scheduledAt: post.scheduled_at ?? null, ...(reminder ? { reminder: true } : {}) },
            template,
            fingerprint: versionTag(post),
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

    /** Tells the person the content changed since they saw it and sends the current version. */
    function refresh(echo, person, row, messageId, post) {
        echo.reply(person, 'Bu içerik sen baktıktan sonra değişti, eski mesaja verilen cevabı uygulamadım. Güncel hâlini gönderiyorum.', messageId, project.id, row.id);
        const member = memberByPhone(person.phone);
        if (!member || !post) return;
        queueRequest(echo, row.kind, post, member, {
            requesterName: row.message.requesterName ?? 'Bir ekip üyesi',
            note: row.message.note,
            dedupeKey: `${project.id}:refresh:${row.id}:${versionTag(post)}:${person.id}`,
        });
    }

    /** Re-reads the post. Returns it when the reply still applies, otherwise answers and returns null. */
    async function checkCurrent(echo, person, row, messageId, options) {
        return checkPost(echo, person, row, messageId, await currentPost(row.item_id), options);
    }

    function checkPost(echo, person, row, messageId, post, { decision = true } = {}) {
        if (!post) {
            echo.reply(person, 'Bu gönderi silinmiş, işlem yapılmadı.', messageId, project.id, row.id);
            return null;
        }
        if (row.fingerprint && !sameVersion(row.fingerprint, post)) {
            refresh(echo, person, row, messageId, post);
            return null;
        }
        if (decision && row.kind === 'approval' && post.status !== 'pending_approval') {
            echo.reply(person, 'Bu gönderi artık onay beklemiyor; başka biri karar vermiş ya da gönderi değişmiş.', messageId, project.id, row.id);
            return null;
        }
        return post;
    }

    /**
     * Where this inbound message stands on the person's decision for a request:
     * - fresh:   no decision yet
     * - resumed: this message started it on an earlier attempt (crash, lost
     *            answer, outage) and TryPost may or may not have it
     * - done:    this message applied it; only the answer to the person is left
     * - taken:   another message applied it
     * - busy:    another message started it and is still queued
     * A decision started by a message that will never finish (it failed or gave
     * up) is taken over by this message and resumed.
     */
    function decisionState(echo, row, person, messageId) {
        const decision = echo.store.decision(row.id, person.phone);
        if (!decision) return { state: 'fresh', decision: null };
        if (decision.wa_message_id === messageId) return { state: decision.state === 'applied' ? 'done' : 'resumed', decision };
        if (decision.state === 'applied') return { state: 'taken', decision };
        const owner = decision.wa_message_id ? echo.store.inbox(decision.wa_message_id) : null;
        if (owner && ['pending', 'processing'].includes(owner.status)) return { state: 'busy', decision };
        echo.store.adoptDecision(row.id, person.phone, messageId);
        return { state: 'resumed', decision };
    }

    const notOurs = (verb) =>
        verb === 'approve'
            ? 'Bu gönderi artık onay beklemiyor; başka biri karar vermiş.'
            : 'Bu gönderi artık onay beklemiyor; başka biri karar vermiş, düzeltme isteğin uygulanmadı.';
    const unverified = (verb) =>
        verb === 'approve'
            ? 'Onayının uygulanıp uygulanmadığını doğrulayamadım; lütfen panelden kontrol et.'
            : 'Düzeltme isteğinin uygulanıp uygulanmadığını doğrulayamadım; lütfen panelden kontrol et.';

    /**
     * Approves or rejects (verb) for the decision this message owns, and returns
     * true only when TryPost answered 200 to this decision's request_id: then it
     * marks the decision applied, and only then may the caller add the
     * "onayladı" / "düzeltme istedi" note. Otherwise it tells the person why,
     * removes the decision and returns 'refused' (the post is there but the
     * decision was not applied: changed, decided by someone else, unverifiable,
     * request_id conflict) or 'gone' (deleted, or a decision already taken). Temporary errors (network, 5xx,
     * 429) are thrown and the started decision is kept for the retry; other
     * errors are thrown too (the caller removes the decision).
     *
     * A fresh decision is checked against the current post and started with a
     * new request_id. A resumed one (crash, lost answer, outage) is simply sent
     * again with the same request_id: TryPost replays it (200, `replayed`) when
     * the earlier attempt went through, and otherwise applies it or refuses it
     * as usual. Each call carries the version the person saw as
     * `expected_version`; TryPost checks it in the same transaction (409).
     *
     * An older TryPost without request_id support answers a lost earlier
     * attempt with a plain 422 (no `error` field), and a decision started
     * before request ids existed has no key TryPost could know: on a resumed
     * decision these cannot be told apart from someone else's decision, so
     * Echo says it could not verify it instead of claiming it.
     */
    async function settle(echo, person, row, messageId, verb, action, { state, decision }) {
        const store = echo.store;
        // Refused: the decision was not applied and the person was told why ('refused' lets the caller keep their note).
        const drop = () => {
            store.undecide(row.id, person.phone, messageId);
            return 'refused';
        };
        const say = (text) => echo.reply(person, text, messageId, project.id, row.id);
        const newRequestId = (startedAt) => requestIdFor({ project: project.id, outboxId: row.id, person: person.id, verb, startedAt });
        const expected = parseVersion(row.fingerprint).tp;
        let verifiable = true;
        if (state === 'resumed') {
            if (!decision.request_id) {
                // Started by a version without request ids: whatever an earlier attempt did is unknown to TryPost.
                // A one-off id (not stored, so every retry stays unverifiable) still lets a 200 count.
                verifiable = false;
                decision = { ...decision, request_id: newRequestId(store.now()) };
            }
            if (!expected) {
                // No TryPost version to send: Echo's own hash is the only check that the content is unchanged.
                const post = await currentPost(row.item_id);
                if (!post) {
                    say('Bu gönderi silinmiş, işlem yapılmadı.');
                    drop();
                    return 'gone';
                }
                // A changed post that is still pending must not be decided on. One that is no longer pending
                // cannot be changed by the call, and TryPost's answer to the request_id tells whose decision it was.
                if (row.fingerprint && !sameVersion(row.fingerprint, post) && post.status === 'pending_approval') {
                    refresh(echo, person, row, messageId, post);
                    return drop();
                }
            }
        } else {
            const post = await currentPost(row.item_id);
            if (!checkPost(echo, person, row, messageId, post)) return post ? 'refused' : 'gone';
            if (!store.startDecision(row.id, person.phone, action, messageId, newRequestId)) {
                say('Bu içerik için cevabını zaten aldım.');
                return 'gone';
            }
            decision = store.decision(row.id, person.phone);
        }

        try {
            const body = { request_id: decision.request_id, ...(expected ? { expected_version: expected } : {}) };
            const result = await api('POST', `/posts/${row.item_id}/${verb}`, body);
            if (result?.replayed === true) echo.log('info', `trypost ${verb} replayed`, decision.request_id);
        } catch (error) {
            const code = error.body && typeof error.body === 'object' ? error.body.error : undefined;
            if (error.status === 409 && code === 'request_id_conflict') {
                echo.log('error', `trypost ${verb} request_id conflict`, decision.request_id);
                say('Kararın TryPost’a işlenemedi; lütfen paneli kullan.');
                return drop();
            }
            if (error.status === 409) {
                // The content changed. If someone also decided on it meanwhile, say that rather than resend it.
                const now = await currentPost(row.item_id).catch(() => null);
                // (An older TryPost sends no `error` field and might be refusing our own applied, then edited, attempt.)
                if (now && row.kind === 'approval' && now.status !== 'pending_approval') {
                    say(state === 'resumed' && (!verifiable || code !== 'version_mismatch') ? unverified(verb) : notOurs(verb));
                }
                else refresh(echo, person, row, messageId, now);
                return drop();
            }
            if (error.status !== 422) throw error;
            // Not pending. TryPost with request ids would have replayed our own earlier attempt, so this is
            // someone else's decision; without them (no `error` field) a resumed decision cannot be told apart.
            say(state === 'resumed' && (!verifiable || code !== 'not_pending') ? unverified(verb) : notOurs(verb));
            return drop();
        }
        store.applyDecision(row.id, person.phone);
        return true;
    }

    const explain = (error) => {
        if (error.status === 403) return 'Bu işlem için TryPost yetkim yok, yöneticiye haber ver.';
        if (error.status === 404) return 'Gönderi bulunamadı, silinmiş olabilir.';
        if (error.status === 422) return 'TryPost bu işlemi kabul etmedi; gönderi artık bu durumda olmayabilir.';
        return 'Cevabın TryPost’a işlenemedi; lütfen paneli kullan.';
    };

    /** Hands an error to Echo: retryable ones are tried again later, others are explained to the person. */
    const giveUp = (error) => {
        error.retryable = Boolean(error.retryable);
        error.userMessage = explain(error);
        return error;
    };

    return {
        uploadMedia,

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
            const reply = (text) => echo.reply(person, text, messageId, project.id, row.id);

            if (isApproval && (action === 'approve' || action === 'revise') && !can(member, 'approver')) {
                reply('Onay verme yetkin yok; yorum yazabilirsin.');
                return;
            }
            if (!isApproval && !can(member, 'reviewer') && !can(member, 'approver')) {
                reply('Bu projede görüş verme yetkin yok.');
                return;
            }
            if (!['approve', 'ok', 'revise', 'comment'].includes(action) || (isApproval && action === 'ok') || (!isApproval && action === 'approve')) {
                reply('Bu buton artık geçerli değil.');
                return;
            }

            if (action === 'approve' || action === 'ok') {
                // The answer is keyed by the inbound message: a retry after a crash does not send it twice.
                const answer = () =>
                    echo.reply(
                        person,
                        action === 'approve' ? '✅ Onaylandı. Gönderi planlanan zamanda yayınlanacak.' : '👍 Teşekkürler, görüşün eklendi.',
                        messageId,
                        project.id,
                        row.id,
                        `${project.id}:answer:${messageId}`,
                    );
                // A double tap acts once; a retry of the same message finishes what it started.
                const current = decisionState(echo, row, person, messageId);
                if (current.state === 'taken') return reply('Bu içerik için cevabını zaten aldım.');
                if (current.state === 'busy') return reply('Bu içerik için cevabını zaten aldım, işleniyor.');
                if (current.state === 'done') return answer();
                try {
                    if (action === 'approve') {
                        if ((await settle(echo, person, row, messageId, 'approve', action, current)) !== true) return;
                        await addNote(row.item_id, `✅ ${person.name} onayladı (WhatsApp).`).catch(() => {});
                    } else {
                        const post = await checkCurrent(echo, person, row, messageId);
                        if (!post) {
                            echo.store.undecide(row.id, person.phone, messageId);
                            return;
                        }
                        if (current.state === 'fresh') echo.store.startDecision(row.id, person.phone, action, messageId);
                        // The note is the decision. A crash between a successful POST and marking it applied
                        // adds the note again on the retry: a duplicate note is harmless, a lost one is not.
                        await addNote(post.id, `👍 ${person.name}: Uygun (WhatsApp).`);
                        echo.store.applyDecision(row.id, person.phone);
                    }
                    answer();
                } catch (error) {
                    // A temporary error keeps the started decision for the retry; a final one removes it.
                    if (!error.retryable) echo.store.undecide(row.id, person.phone, messageId);
                    echo.log('error', 'trypost action failed', error.message);
                    throw giveUp(error);
                }
                return;
            }

            let post;
            try {
                post = await checkCurrent(echo, person, row, messageId, { decision: action !== 'comment' });
            } catch (error) {
                throw giveUp(error);
            }
            if (!post) return;

            // A new tap replaces any open session; the prompt names the content, so the person sees where the next message goes.
            echo.store.setSession(person.phone, row.id, action);
            const about = `şu içerik için: "${excerpt(post.content, 60)}" (${channel(post)})`;
            reply(
                action === 'revise'
                    ? isApproval
                        ? `Ne düzeltilsin, ${about}? Yazdığın not gönderiye eklenecek ve gönderi hazırlayana geri dönecek. Vazgeçmek için "iptal" yaz.`
                        : `Neyin revize edilmesini istiyorsun, ${about}? Yazdığın not içeriğe eklenecek. Vazgeçmek için "iptal" yaz.`
                    : `Yorumunu yaz, ${about}. İçeriğin notlarına eklenecek. Vazgeçmek için "iptal" yaz.`,
            );
        },

        async handleText({ echo, person, row, mode, text, messageId, progress = {} }) {
            const member = memberByPhone(person.phone);
            if (!member) return;
            const reply = (body, dedupeKey = null) => echo.reply(person, body, messageId, project.id, row.id, dedupeKey);
            try {
                if (mode === 'revise' && row.kind === 'approval' && can(member, 'approver')) {
                    // Reject first, with the version the person saw; then the note. A crash after the reject
                    // leaves only the note (and the answer) for the retry; the note may then be added twice.
                    const finish = async () => {
                        await addNote(row.item_id, `✏️ ${person.name} düzeltme istedi (WhatsApp): ${text}`);
                        reply('↩️ Not eklendi, gönderi düzeltme için geri gönderildi.', `${project.id}:answer:${messageId}`);
                    };
                    // The reject was refused (someone else decided, the content changed, it could not be verified):
                    // the typed text is still kept, as a plain comment. Recorded in progress first, so a retry after a
                    // failed note POST only adds the note (the refusal was already explained); duplicate tradeoff as above.
                    const keepAsComment = async () => {
                        progress.commentOnly = true;
                        await addNote(row.item_id, `💬 ${person.name} (WhatsApp): ${text}`);
                        reply('💬 Düzeltme notunu gönderiye yorum olarak ekledim.', `${project.id}:answer:${messageId}`);
                    };
                    if (progress.commentOnly) return await keepAsComment();
                    // progress.rejected: a retry queued by an older version, after its reject went through.
                    const current = progress.rejected ? { state: 'done' } : decisionState(echo, row, person, messageId);
                    if (current.state === 'done') return await finish();
                    if (current.state === 'busy') return reply('Bu içerik için kararını zaten aldım, işleniyor.');
                    if (current.state === 'taken') {
                        await addNote(row.item_id, `💬 ${person.name}: ${text}`);
                        reply('Bu içerik için kararını zaten aldım; notunu yine de ekledim.');
                        return;
                    }
                    const settled = await settle(echo, person, row, messageId, 'reject', 'revise', current);
                    if (settled === 'refused') return await keepAsComment();
                    if (settled !== true) return;
                    await finish();
                    return;
                }
                const post = await checkCurrent(echo, person, row, messageId, { decision: mode === 'revise' });
                if (!post) return;
                if (mode === 'revise' && row.kind === 'approval') {
                    await addNote(post.id, `💬 ${person.name}: ${text}`);
                    reply('Onay verme yetkin yok; yorumunu not olarak ekledim.');
                    return;
                }
                if (mode === 'revise') {
                    await addNote(post.id, `✏️ ${person.name}: Revize gerekli (WhatsApp): ${text}`);
                    reply('✏️ Revize notun içeriğe eklendi.');
                    return;
                }
                await addNote(post.id, `💬 ${person.name} (WhatsApp): ${text}`);
                reply('💬 Yorumun eklendi.');
            } catch (error) {
                // A temporary error keeps a started decision for the retry; a final one removes it (applied ones stay).
                if (!error.retryable) echo.store.undecide(row.id, person.phone, messageId);
                echo.log('error', 'trypost note failed', error.message);
                throw giveUp(error);
            }
        },

        texts: {
            retrying: 'TryPost’a şu an ulaşamıyorum, cevabını kaydettim; bağlantı gelince işleyeceğim.',
            gaveUp: 'TryPost’a uzun süre ulaşamadım; cevabın uygulanamadı. Lütfen paneli kullan.',
        },

        async onDeliveryFailed({ row, person, reason }) {
            if (!row.item_id) return;
            await addNote(row.item_id, `⚠️ ${person?.name ?? row.recipient} kişisine WhatsApp mesajı iletilemedi: ${reason}`);
        },
    };
}
