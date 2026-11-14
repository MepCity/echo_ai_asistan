import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, describe, it } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { createEcho } from '../src/core.js';
import { createStore, openDatabase } from '../src/db.js';
import { createTryPostProject, fingerprint, sameVersion, versionTag } from '../src/projects/trypost.js';
import { createHttpServer } from '../src/server.js';
import { WhatsAppError, createWhatsAppClient, parseWebhook, toPayload, verifySignature } from '../src/whatsapp.js';

// AbortSignal.timeout timers do not keep the process alive (Echo's server and worker do); tests that wait on one need this.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const PHONES = { yasir: '905550000001', ayse: '905550000002', mehmet: '905550000003' };

const baseConfig = (extra = {}) =>
    normalizeConfig({
        ...extra,
        whatsapp: { phoneNumberId: '1', accessToken: 't', appSecret: 'app-secret', verifyToken: 'verify' },
        people: extra.people ?? [
            { id: 'yasir', name: 'Yasir', phone: `+${PHONES.yasir}` },
            { id: 'ayse', name: 'Ayşe', phone: PHONES.ayse },
            { id: 'mehmet', name: 'Mehmet', phone: PHONES.mehmet },
        ],
        projects: [
            {
                id: 'marmara',
                type: 'trypost',
                name: 'Marmara AI',
                apiUrl: 'https://trypost.test/api',
                publicUrl: 'https://trypost.test',
                apiToken: 'token',
                webhookSecret: 'hook-secret',
                templates: { language: 'tr', approval: 'onay_bekliyor', feedback: 'gorus_istegi' },
                members: [
                    { person: 'yasir', userId: 'u-yasir', roles: ['reviewer', 'approver'] },
                    { person: 'ayse', userId: 'u-ayse', roles: ['reviewer', 'approver'] },
                    { person: 'mehmet', userId: 'u-mehmet', roles: ['reviewer'] },
                ],
                ...(extra.projectExtra ?? {}),
            },
        ],
    });

/** A fake WhatsApp Cloud API: records payloads, can be told to fail. */
function fakeWhatsApp() {
    const sent = [];
    const failures = [];
    let next = 1;
    return {
        sent,
        failNext: (error) => failures.push(error),
        async send(payload) {
            if (failures.length) throw failures.shift();
            const id = `wamid.${next++}`;
            sent.push({ id, ...payload });
            return id;
        },
        to: (phone) => sent.filter((message) => message.to === phone),
        last: (phone) => sent.filter((message) => message.to === phone).at(-1),
    };
}

/** TryPost's own content version: a hash of content, media and schedule. */
const contentVersion = (post) =>
    createHash('sha1').update(JSON.stringify([post.content, post.media, post.scheduled_at])).digest('hex').slice(0, 12);

/**
 * A fake TryPost API with the endpoints Echo uses. Like TryPost, it adds
 * `content_version` to the post resource, refuses (409 version_mismatch) an
 * approve/reject whose `expected_version` is not the current one, answers 422
 * not_pending for a decided post, and records the approver (the API token's
 * user) and time. An approve/reject with a `request_id` is recorded with the
 * action it applied; repeating it answers 200 `replayed: true` (whatever the
 * post's state now), the same id with another action 409 request_id_conflict.
 * `setLegacy(true)` makes it an older TryPost: request_id ignored, no `error`
 * or `replayed` fields.
 *
 * `crashOn(call, { when, mode })` makes the next matching call (e.g.
 * "POST /posts/p1/approve") never answer ("hang": Echo's process died during
 * it) or fail with a network error ("network": the answer was lost), either
 * before TryPost applied it or after. It returns a promise that resolves when
 * that call is made.
 */
function fakeTryPost(clock) {
    const posts = new Map();
    const notes = [];
    const calls = [];
    const requests = [];
    const hooks = { afterGet: null };
    const uploads = [];
    const uploadAnswers = []; // queued answers for POST /uploads: a status code or 'network'
    const decided = new Map(); // "<post id> <request_id>" -> action
    let legacy = false;
    let down = false;
    let crash = null;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const stamp = () => new Date(clock.t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    function handle(method, path, body) {
        if (typeof down === 'number') return json(down, { message: 'error' });
        if (down) return json(503, { message: 'down' });
        const match = path.match(/^\/posts\/([^/]+)(?:\/(\w+))?$/);
        const post = match && posts.get(match[1]);
        if (!post) return json(404, { message: 'not found' });
        if (method === 'GET') {
            const response = json(200, { data: toApi(post) });
            // Lets a test change the post right after Echo read it (before Echo's next call).
            if (hooks.afterGet) {
                const hook = hooks.afterGet;
                hooks.afterGet = null;
                hook(post);
            }
            return response;
        }
        if (match[2] === 'notes') {
            notes.push({ postId: post.id, body: body.body });
            return json(201, { data: {} });
        }
        if (match[2] === 'approve' || match[2] === 'reject') {
            const action = match[2];
            const requestId = legacy ? undefined : body?.request_id;
            const error = (code) => (legacy ? {} : { error: code });
            if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9:._-]{1,100}$/.test(requestId))) {
                return json(400, { message: 'invalid request_id' });
            }
            if (requestId) {
                const done = decided.get(`${post.id} ${requestId}`);
                if (done === action) return json(200, { data: toApi(post), replayed: true });
                if (done) return json(409, { ...error('request_id_conflict'), message: 'request_id used for another action' });
            }
            if (body?.expected_version && body.expected_version !== contentVersion(post)) {
                return json(409, { ...error('version_mismatch'), message: 'content changed', content_version: contentVersion(post) });
            }
            if (post.status !== 'pending_approval') return json(422, { ...error('not_pending'), message: 'not pending' });
            post.status = action === 'approve' ? 'scheduled' : 'draft';
            if (action === 'approve') Object.assign(post, { approved_by: { id: 'u-echo', name: 'Echo' }, approved_at: stamp() });
            if (requestId) decided.set(`${post.id} ${requestId}`, action);
            return json(200, { data: toApi(post), ...(legacy ? {} : { replayed: false }) });
        }
        return json(404, {});
    }

    /** POST /uploads (multipart `media`): a temporary upload with a single-use token, like UploadController::create. */
    async function upload(init) {
        const answer = uploadAnswers.shift();
        if (answer === 'network') throw new TypeError('fetch failed');
        // Never answers, like a stalled connection; aborts with the request's signal as fetch does.
        if (answer === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
        if (answer) return json(answer, answer === 422 ? { message: 'invalid', errors: { media: ['The media field must be a file of type: jpg.'] } } : { message: 'error' });
        const file = init.body.get('media');
        const bytes = Buffer.from(await file.arrayBuffer());
        const token = `00000000-0000-4000-8000-${String(uploads.length + 1).padStart(12, '0')}`;
        uploads.push({ token, name: file.name, type: file.type, bytes, auth: init.headers.Authorization });
        const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'document';
        return json(201, { upload_token: token, type, mime_type: file.type, size: bytes.length, expires_at: '2026-11-12T12:00:00+00:00' });
    }

    return {
        posts,
        notes,
        uploads,
        uploadAnswers,
        calls,
        requests,
        hooks,
        decided,
        setDown: (value) => (down = value),
        setLegacy: (value) => (legacy = value),
        /** Someone decides in the panel (the API token's user is Echo's, so approved_by says nothing). */
        panelDecide(id, action, changes = {}) {
            const p = posts.get(id);
            Object.assign(p, changes, { status: action === 'approve' ? 'scheduled' : 'draft' });
            if (action === 'approve') Object.assign(p, { approved_by: { id: 'u-echo', name: 'Echo' }, approved_at: stamp() });
        },
        crashOn(call, { when = 'before', mode = 'hang' } = {}) {
            return new Promise((resolve) => (crash = { call, when, mode, resolve }));
        },
        fetch: async (url, init) => {
            const path = new URL(url).pathname.replace(/^\/api/, '');
            calls.push(`${init.method} ${path}`);
            if (init.method === 'POST' && path === '/uploads') return upload(init);
            const body = init.body ? JSON.parse(init.body) : null;
            requests.push({ method: init.method, path, body });
            if (crash && crash.call === `${init.method} ${path}`) {
                const { when, mode, resolve } = crash;
                crash = null;
                if (when === 'after') handle(init.method, path, body);
                resolve();
                if (mode === 'network') throw new TypeError('fetch failed');
                return new Promise(() => {});
            }
            if (down === 'network') throw new TypeError('fetch failed');
            return handle(init.method, path, body);
        },
    };
}

// The API resource formats dates as "Y-m-d H:i:s" (UTC); the webhook uses ISO 8601.
const toApi = (post) => ({
    ...post,
    scheduled_at: post.scheduled_at.replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)$/, ''),
    content_version: contentVersion(post),
});

function setup(extra = {}) {
    const clock = { t: Date.parse('2026-11-11T12:00:00Z') };
    const config = baseConfig(extra);
    const db = openDatabase(':memory:');
    const store = createStore(db, () => clock.t);
    const whatsapp = fakeWhatsApp();
    const trypost = fakeTryPost(clock);
    const logs = [];
    const t = { clock, config, db, store, whatsapp, trypost, logs, mediaTimeouts: extra.mediaTimeouts };
    t.echo = boot(t);

    let inbound = 1;
    t.user = {
        /** The person writes to us first, opening their 24-hour window. */
        async hello(phone) {
            await t.echo.handleWebhook({ messages: [{ id: `in.${inbound++}`, from: phone, type: 'text', text: 'merhaba' }], statuses: [] });
        },
        async tap(phone, buttonId, id = `in.${inbound++}`) {
            await t.echo.handleWebhook({ messages: [{ id, from: phone, type: 'interactive', buttonId }], statuses: [] });
        },
        async say(phone, text, contextId = null, id = `in.${inbound++}`) {
            await t.echo.handleWebhook({ messages: [{ id, from: phone, type: 'text', text, contextId }], statuses: [] });
        },
    };
    return t;
}

/** A new Echo process over the given state (database, WhatsApp, TryPost). */
function boot(t) {
    const echo = createEcho({ config: t.config, store: t.store, whatsapp: t.whatsapp, log: (...parts) => t.logs.push(parts), mediaTimeouts: t.mediaTimeouts });
    echo.register('marmara', createTryPostProject(t.config.projects[0], { fetchImpl: t.trypost.fetch }));
    return echo;
}

/** The process died: the old Echo is left hanging, a new one starts over the same database. */
const restart = (t) => (t.echo = boot(t));

const post = (overrides = {}) => ({
    id: 'p1',
    status: 'pending_approval',
    content: 'Yapay zeka atölyemiz cuma 18:00’de!',
    scheduled_at: '2026-11-20T15:00:00+00:00',
    media: [{ id: 'm1' }],
    platform: 'instagram',
    social_account: { platform: 'instagram', display_name: 'marmaraai' },
    ...overrides,
});

const approvalEvent = (p, id = 'evt-1') => ({
    id,
    type: 'post.approval_requested',
    data: { ...p, approval: { requested_by: { id: 'u-mehmet', name: 'Mehmet' } } },
});

const buttonsOf = (message) => message.interactive?.action.buttons.map((button) => button.reply.id) ?? [];

describe('fingerprint', () => {
    it('matches across the webhook and API date formats', () => {
        const p = post();
        assert.equal(fingerprint(p), fingerprint(toApi(p)));
        assert.notEqual(fingerprint(p), fingerprint({ ...p, content: 'başka' }));
        assert.notEqual(fingerprint(p), fingerprint({ ...p, scheduled_at: '2026-11-20T16:00:00+00:00' }));
    });
});

describe('approval requests', () => {
    let t;
    beforeEach(() => {
        t = setup();
        t.trypost.posts.set('p1', post());
    });

    it('asks every approver except the requester, once per event', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        await t.echo.handleProjectEvent('marmara', approvalEvent(post())); // TryPost retried the webhook

        const yasir = t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive');
        assert.equal(yasir.length, 1);
        assert.match(yasir[0].interactive.body.text, /Onayını bekleyen/);
        // Ayşe never wrote to us, so she gets the approved template instead.
        const ayse = t.whatsapp.to(PHONES.ayse);
        assert.equal(ayse.length, 1);
        assert.equal(ayse[0].type, 'template');
        assert.equal(ayse[0].template.name, 'onay_bekliyor');
        // Mehmet asked for the approval and is not an approver.
        assert.equal(t.whatsapp.to(PHONES.mehmet).length, 0);
    });

    it('approves from a button, and a double tap acts once', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        await t.user.tap(PHONES.yasir, approve);
        await t.user.tap(PHONES.yasir, approve);

        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
        assert.equal(t.trypost.calls.filter((call) => call.endsWith('/approve')).length, 1);
        assert.ok(t.trypost.notes.some((note) => note.body.includes('Yasir onayladı')));
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /cevabını zaten aldım/);
    });

    it('ignores a retried WhatsApp webhook for the same message', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        await t.user.tap(PHONES.yasir, approve, 'same-id');
        const before = t.whatsapp.sent.length;
        await t.user.tap(PHONES.yasir, approve, 'same-id');
        assert.equal(t.whatsapp.sent.length, before);
    });

    it('asks for a note on "revise", then sends the post back with it', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const [, revise] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        await t.user.tap(PHONES.yasir, revise);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Ne düzeltilsin/);
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak');

        assert.equal(t.trypost.posts.get('p1').status, 'draft');
        assert.ok(t.trypost.notes.some((note) => note.body.includes('düzeltme istedi') && note.body.includes('19:00')));
    });

    it('cancels a pending note with "iptal"', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const [, revise] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        await t.user.tap(PHONES.yasir, revise);
        await t.user.say(PHONES.yasir, 'iptal');
        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        assert.equal(t.trypost.notes.length, 0);
    });

    it('refuses a reply to content that changed since it was sent, and sends the new version', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.posts.get('p1').content = 'Atölye ertelendi';
        await t.user.tap(PHONES.yasir, approve);

        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        const messages = t.whatsapp.to(PHONES.yasir);
        assert.ok(messages.some((m) => m.text?.body.includes('değişti')));
        assert.match(messages.at(-1).interactive.body.text, /Atölye ertelendi/);
    });

    it('keeps several pending items apart', async () => {
        t.trypost.posts.set('p2', post({ id: 'p2', content: 'İkinci gönderi' }));
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post(), 'e1'));
        const first = t.whatsapp.last(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post({ id: 'p2', content: 'İkinci gönderi' }), 'e2'));
        await t.user.tap(PHONES.yasir, buttonsOf(first)[0]);

        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
        assert.equal(t.trypost.posts.get('p2').status, 'pending_approval');
    });

    it('tells the second approver that someone already decided', async () => {
        await t.user.hello(PHONES.yasir);
        await t.user.hello(PHONES.ayse);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        await t.user.tap(PHONES.yasir, buttonsOf(t.whatsapp.last(PHONES.yasir))[0]);
        await t.user.tap(PHONES.ayse, buttonsOf(t.whatsapp.last(PHONES.ayse))[0]);
        assert.match(t.whatsapp.last(PHONES.ayse).text.body, /artık onay beklemiyor/);
        assert.equal(t.trypost.calls.filter((call) => call.endsWith('/approve')).length, 1);
    });

    it('rejects a button forwarded to someone else', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        await t.user.tap(PHONES.mehmet, approve);
        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        assert.match(t.whatsapp.last(PHONES.mehmet).text.body, /geçerli değil/);
    });

    it('ignores unknown numbers', async () => {
        await t.user.say('905559999999', 'selam');
        assert.equal(t.whatsapp.sent.length, 0);
        assert.ok(t.logs.some((entry) => entry[0] === 'warn' && /unknown number/.test(entry[1]) && entry[2] === '90555****999'));
    });

    it('saves a free-text reply to a request as a comment', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);
        await t.user.say(PHONES.yasir, 'Görsel biraz karanlık', request.id);
        assert.ok(t.trypost.notes.some((note) => note.body.includes('Görsel biraz karanlık')));
        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
    });

    it('says which content a "Yorum yaz" prompt is about', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        await t.user.tap(PHONES.yasir, buttonsOf(t.whatsapp.last(PHONES.yasir))[2]);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Yorumunu yaz, şu içerik için: "Yapay zeka atölyemiz cuma 18:00’de!" \(Instagram · marmaraai\)/);
    });
});

const later = async (t, ms) => {
    t.clock.t += ms;
    await t.echo.tick();
};
const textsTo = (t, phone, pattern) => t.whatsapp.to(phone).filter((m) => pattern.test(m.text?.body ?? ''));

describe('routing typed notes', () => {
    let t;
    let requestA;
    let requestB;
    beforeEach(async () => {
        t = setup();
        t.trypost.posts.set('p1', post());
        t.trypost.posts.set('p2', post({ id: 'p2', content: 'İkinci gönderi' }));
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post(), 'e1'));
        requestA = t.whatsapp.last(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post({ id: 'p2', content: 'İkinci gönderi' }), 'e2'));
        requestB = t.whatsapp.last(PHONES.yasir);
    });

    it('puts a quote-reply on the quoted post even when another post has an open session', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(requestA)[2]); // Yorum yaz on A
        await t.user.tap(PHONES.yasir, buttonsOf(requestB)[2]); // Yorum yaz on B: the session is now B
        await t.user.say(PHONES.yasir, 'A için yorum', requestA.id);
        assert.deepEqual(t.trypost.notes.map((note) => note.postId), ['p1']);

        // The session for B was left open: the next plain message is B's note.
        await t.user.say(PHONES.yasir, 'B için yorum');
        assert.deepEqual(t.trypost.notes.map((note) => [note.postId, note.body.includes('B için')]), [['p1', false], ['p2', true]]);
    });

    it('treats a quote-reply to a "Yorumunu yaz" prompt as a reply to its post', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(requestA)[2]);
        const promptA = t.whatsapp.last(PHONES.yasir);
        assert.match(promptA.text.body, /Yapay zeka atölyemiz/);
        await t.user.tap(PHONES.yasir, buttonsOf(requestB)[2]);
        await t.user.say(PHONES.yasir, 'A için yorum', promptA.id);
        assert.deepEqual(t.trypost.notes.map((note) => note.postId), ['p1']);
    });

    it('uses the session mode when the quote-reply is to the session\'s own post', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(requestA)[1]); // Düzeltme iste on A
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak', requestA.id);
        assert.equal(t.trypost.posts.get('p1').status, 'draft');
        assert.equal(t.trypost.posts.get('p2').status, 'pending_approval');
        // The session is used up: a plain message now gets the help reply.
        await t.user.say(PHONES.yasir, 'teşekkürler');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /o mesajı yanıtla/);
        assert.equal(t.trypost.notes.length, 1);
    });

    it('never guesses the post for a plain message without a quote or session', async () => {
        await t.user.say(PHONES.yasir, 'Görsel karanlık');
        assert.equal(t.trypost.notes.length, 0);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /o mesajı yanıtla/);
    });
});

describe('TryPost outages', () => {
    let t;
    beforeEach(async () => {
        t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
    });

    it('keeps a typed note through an outage and applies it, in order, when TryPost is back', async () => {
        const request = t.whatsapp.last(PHONES.yasir);
        await t.user.tap(PHONES.yasir, buttonsOf(request)[1]); // Düzeltme iste, while TryPost is up
        t.trypost.setDown(true);
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak');
        await t.user.say(PHONES.yasir, 'Bir de hashtag ekleyelim', request.id); // waits behind the first
        assert.equal(textsTo(t, PHONES.yasir, /ulaşamıyorum, cevabını kaydettim/).length, 1);
        assert.equal(t.trypost.notes.length, 0);

        await later(t, 31_000); // still down: retried quietly
        assert.equal(textsTo(t, PHONES.yasir, /ulaşamıyorum/).length, 1);

        t.trypost.setDown(false);
        await later(t, 2 * 60_000 + 1_000);
        assert.equal(t.trypost.posts.get('p1').status, 'draft');
        const bodies = t.trypost.notes.map((note) => note.body);
        assert.equal(bodies.length, 2);
        assert.match(bodies[0], /düzeltme istedi.*19:00/);
        assert.match(bodies[1], /hashtag/);
        assert.equal(textsTo(t, PHONES.yasir, /gönderi düzeltme için geri gönderildi/).length, 1);
        assert.equal(t.store.inboxStats().pending ?? 0, 0);
    });

    it('applies a tap made during an outage once TryPost is back', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.setDown('network');
        await t.user.tap(PHONES.yasir, approve);
        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /ulaşamıyorum/);

        t.trypost.setDown(false);
        await later(t, 31_000);
        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Onaylandı/);
        assert.equal(textsTo(t, PHONES.yasir, /ulaşamıyorum/).length, 1);
    });

    it('gives up after the last retry, says so once, and records no decision', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.setDown(true);
        await t.user.tap(PHONES.yasir, approve, 'tap-1');
        for (let i = 0; i < 6; i++) await later(t, 3 * 60 * 60_000);
        assert.equal(t.store.inbox('tap-1').status, 'failed');
        assert.equal(t.store.inbox('tap-1').attempts, 6);
        assert.equal(textsTo(t, PHONES.yasir, /ulaşamıyorum/).length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /uygulanamadı. Lütfen paneli kullan/).length, 1);

        t.trypost.setDown(false);
        await t.user.tap(PHONES.yasir, approve);
        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
    });

    it('does not retry a refusal', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.setDown(403);
        await t.user.tap(PHONES.yasir, approve, 'tap-1');
        assert.equal(t.store.inbox('tap-1').status, 'failed');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /yetkim yok/);
        assert.equal(textsTo(t, PHONES.yasir, /ulaşamıyorum/).length, 0);
    });

    it('recovers a message left in processing by a crash', async () => {
        t.store.receive({ id: 'crashed', from: PHONES.yasir, type: 'text', text: 'selam' }, PHONES.yasir);
        assert.ok(t.store.claimInbox('crashed'));
        await t.echo.tick();
        assert.equal(t.store.inbox('crashed').status, 'processing');
        await later(t, 6 * 60_000);
        assert.equal(t.store.inbox('crashed').status, 'done');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Merhaba/);
    });
});

describe('content versions', () => {
    let t;
    const versionedEvent = (p, id = 'evt-1') => {
        const event = approvalEvent(p, id);
        event.data.content_version = contentVersion(p);
        return event;
    };
    beforeEach(async () => {
        t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', versionedEvent(post()));
    });

    it('keeps TryPost\'s content_version and sends it back as expected_version', async () => {
        const request = t.whatsapp.last(PHONES.yasir);
        assert.ok(t.store.outboxByWaId(request.id).fingerprint.startsWith(`tp:${contentVersion(post())} echo:`));
        await t.user.tap(PHONES.yasir, buttonsOf(request)[0]);
        const approve = t.trypost.requests.find((r) => r.path.endsWith('/approve'));
        assert.equal(approve.body.expected_version, contentVersion(post()));
        assert.match(approve.body.request_id, /^echo-marmara-\d+-yasir-approve-[a-z0-9]+$/);
        assert.ok(approve.body.request_id.length <= 100);
        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
    });

    it('does not approve content that changed between Echo\'s check and the approval', async () => {
        t.trypost.hooks.afterGet = (p) => (p.content = 'Atölye ertelendi');
        await t.user.tap(PHONES.yasir, buttonsOf(t.whatsapp.last(PHONES.yasir))[0]);
        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        const messages = t.whatsapp.to(PHONES.yasir);
        assert.ok(messages.some((m) => m.text?.body.includes('değişti')));
        assert.match(messages.at(-1).interactive.body.text, /Atölye ertelendi/);
        assert.ok(!t.trypost.notes.some((note) => note.body.includes('onayladı')));

        // The new version can be approved.
        await t.user.tap(PHONES.yasir, buttonsOf(messages.at(-1))[0]);
        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
    });

    it('does not send back content that changed between Echo\'s check and the rejection', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(t.whatsapp.last(PHONES.yasir))[1]);
        t.trypost.hooks.afterGet = (p) => (p.content = 'Atölye ertelendi');
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak');
        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        // The typed text is kept as a plain comment, not as a "düzeltme istedi" note.
        assert.deepEqual(t.trypost.notes.map((note) => note.body), ['💬 Yasir (WhatsApp): Saat 19:00 olacak']);
        assert.equal(textsTo(t, PHONES.yasir, /yorum olarak ekledim/).length, 1);
        assert.ok(t.whatsapp.to(PHONES.yasir).some((m) => /Atölye ertelendi/.test(m.interactive?.body.text ?? '')));
    });

    it('compares like with like, and still reads older fingerprints', () => {
        const p = post();
        const api = toApi(p);
        assert.ok(sameVersion(versionTag({ ...p, content_version: contentVersion(p) }), api));
        assert.ok(!sameVersion(versionTag({ ...p, content_version: 'old' }), api));
        // Without a TryPost version on one side, Echo's hash decides.
        assert.ok(sameVersion(versionTag(p), api));
        assert.ok(sameVersion(versionTag({ ...p, content_version: 'v1' }), { ...api, content_version: undefined }));
        assert.ok(sameVersion(fingerprint(p), api)); // a bare hash stored before versions existed
        assert.ok(!sameVersion(fingerprint(p), { ...api, content: 'başka' }));
    });
});

describe('feedback requests', () => {
    it('collects "Uygun", revise notes and comments from the chosen people', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post({ status: 'draft' }));
        await t.user.hello(PHONES.mehmet);
        await t.user.hello(PHONES.ayse);
        await t.echo.handleProjectEvent('marmara', {
            id: 'f1',
            type: 'post.feedback_requested',
            data: {
                ...post({ status: 'draft' }),
                feedback: {
                    requested_by: { id: 'u-yasir', name: 'Yasir' },
                    note: 'Metin uygun mu?',
                    recipients: [{ id: 'u-mehmet', name: 'Mehmet' }, { id: 'u-ayse', name: 'Ayşe' }, { id: 'u-nobody', name: 'Biri' }],
                },
            },
        });

        const toMehmet = t.whatsapp.last(PHONES.mehmet);
        assert.match(toMehmet.interactive.body.text, /Görüşünü bekleyen/);
        assert.match(toMehmet.interactive.body.text, /Metin uygun mu\?/);
        const [ok] = buttonsOf(toMehmet);
        await t.user.tap(PHONES.mehmet, ok);

        const [, revise] = buttonsOf(t.whatsapp.last(PHONES.ayse).interactive ? t.whatsapp.last(PHONES.ayse) : t.whatsapp.to(PHONES.ayse).at(-1));
        await t.user.tap(PHONES.ayse, revise);
        await t.user.say(PHONES.ayse, 'Hashtag ekleyelim');

        const bodies = t.trypost.notes.map((note) => note.body);
        assert.ok(bodies.some((body) => body.includes('Mehmet: Uygun')));
        assert.ok(bodies.some((body) => body.includes('Ayşe: Revize gerekli') && body.includes('Hashtag')));
        assert.ok(bodies.some((body) => body.includes('WhatsApp numarası tanımlı değil')));
        // Feedback never changes the post's status.
        assert.equal(t.trypost.posts.get('p1').status, 'draft');
    });
});

describe('delivery', () => {
    it('retries temporary WhatsApp errors with backoff', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        t.whatsapp.failNext(new WhatsAppError('rate limited', { status: 429, retryable: true }));
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        assert.equal(t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive').length, 0);

        t.clock.t += 31_000;
        await t.echo.tick();
        assert.equal(t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive').length, 1);
    });

    it('falls back to the template when the window turns out to be closed', async () => {
        const t = setup();
        await t.user.hello(PHONES.yasir);
        t.whatsapp.failNext(new WhatsAppError('outside window', { code: 131047, status: 400 }));
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        assert.equal(t.whatsapp.last(PHONES.yasir).type, 'template');
    });

    it('notes a failed delivery on the post', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        t.whatsapp.failNext(new WhatsAppError('invalid number', { code: 131026, status: 400 }));
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        assert.ok(t.trypost.notes.some((note) => note.body.includes('iletilemedi')));
    });

    it('reports a failed status webhook once and moves statuses only forward', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);
        const row = () => t.store.outboxByWaId(request.id);

        await t.echo.handleWebhook({ messages: [], statuses: [{ id: request.id, status: 'read' }] });
        await t.echo.handleWebhook({ messages: [], statuses: [{ id: request.id, status: 'delivered' }] });
        assert.equal(row().status, 'read');

        const failed = { id: request.id, status: 'failed', error: '131049: ecosystem' };
        await t.echo.handleWebhook({ messages: [], statuses: [failed] });
        await t.echo.handleWebhook({ messages: [], statuses: [failed] });
        assert.equal(t.trypost.notes.filter((note) => note.body.includes('iletilemedi')).length, 1);
    });

    it('does not send courtesy updates outside the window', async () => {
        const t = setup();
        await t.echo.handleProjectEvent('marmara', {
            id: 'a1',
            type: 'post.approved',
            data: { ...post({ status: 'scheduled' }), approval: { requested_by: { id: 'u-mehmet' }, decided_by: { id: 'u-yasir', name: 'Yasir' } } },
        });
        assert.equal(t.whatsapp.sent.length, 0);

        await t.user.hello(PHONES.mehmet);
        await t.echo.handleProjectEvent('marmara', {
            id: 'a2',
            type: 'post.approved',
            data: { ...post({ status: 'scheduled' }), approval: { requested_by: { id: 'u-mehmet' }, decided_by: { id: 'u-yasir', name: 'Yasir' } } },
        });
        assert.match(t.whatsapp.last(PHONES.mehmet).text.body, /Yasir gönderiyi onayladı/);
        // The approver who decided is not told about their own decision.
        assert.equal(t.whatsapp.to(PHONES.yasir).length, 0);
    });
});

describe('crash between a decision and TryPost', () => {
    let t;
    beforeEach(async () => {
        t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
    });
    const approvals = () => t.trypost.notes.filter((note) => note.body.includes('Yasir onayladı'));

    it('approves after a crash right after the decision was recorded', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        const crashed = t.trypost.crashOn('POST /posts/p1/approve', { when: 'before' });
        t.user.tap(PHONES.yasir, approve, 'tap-1'); // the process dies inside the approve call
        await crashed;
        const request = t.store.outboxByWaId(t.whatsapp.last(PHONES.yasir).id);
        assert.equal(t.store.decision(request.id, PHONES.yasir).state, 'started');
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
        assert.equal(t.store.inbox('tap-1').status, 'done');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Onaylandı/);
        assert.equal(textsTo(t, PHONES.yasir, /zaten aldım/).length, 0);
        assert.equal(approvals().length, 1);
    });

    it('recognises its own approval when Echo crashed after TryPost applied it', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        const crashed = t.trypost.crashOn('POST /posts/p1/approve', { when: 'after' });
        t.user.tap(PHONES.yasir, approve, 'tap-1');
        await crashed;
        restart(t);
        await later(t, 6 * 60_000);

        // Sent again with the same request_id, and TryPost replays it.
        const attempts = t.trypost.requests.filter((r) => r.path.endsWith('/approve'));
        assert.equal(attempts.length, 2);
        assert.equal(attempts[1].body.request_id, attempts[0].body.request_id);
        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /zaten aldım|artık onay beklemiyor/).length, 0);
        assert.equal(approvals().length, 1);
        // A later tap on the same button is a double tap.
        await t.user.tap(PHONES.yasir, approve);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /cevabını zaten aldım/);
    });

    it('says "Onaylandı" when TryPost approved but its answer was lost', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.crashOn('POST /posts/p1/approve', { when: 'after', mode: 'network' });
        await t.user.tap(PHONES.yasir, approve, 'tap-1');
        assert.equal(t.store.inbox('tap-1').status, 'pending'); // kept for a retry
        await later(t, 31_000);

        assert.equal(t.store.inbox('tap-1').status, 'done');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Onaylandı/);
        assert.equal(textsTo(t, PHONES.yasir, /artık onay beklemiyor/).length, 0);
        assert.equal(t.trypost.calls.filter((call) => call.endsWith('/approve')).length, 2); // the second one replayed
        assert.equal(approvals().length, 1);
    });

    it('lets a new tap finish a decision whose message gave up after its approval got through', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.crashOn('POST /posts/p1/approve', { when: 'after', mode: 'network' });
        await t.user.tap(PHONES.yasir, approve, 'tap-1');
        t.trypost.setDown(true);
        for (let i = 0; i < 6; i++) await later(t, 3 * 60 * 60_000);
        assert.equal(t.store.inbox('tap-1').status, 'failed');

        t.trypost.setDown(false);
        await t.user.tap(PHONES.yasir, approve, 'tap-2');
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Onaylandı/);
        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
    });

    it('does not claim someone else\'s earlier approval as its own', async () => {
        const [approve] = buttonsOf(t.whatsapp.last(PHONES.yasir));
        t.trypost.crashOn('POST /posts/p1/approve', { when: 'before', mode: 'network' });
        await t.user.tap(PHONES.yasir, approve, 'tap-1');
        // Approved in the panel, long before this decision started.
        Object.assign(t.trypost.posts.get('p1'), { status: 'scheduled', approved_by: { id: 'u-echo' }, approved_at: '2026-11-11 10:00:00' });
        await later(t, 31_000);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /artık onay beklemiyor/);
        const request = t.store.outboxByWaId(t.whatsapp.to(PHONES.yasir).find((m) => m.type === 'interactive').id);
        assert.equal(t.store.decision(request.id, PHONES.yasir), null);
    });

    it('sends the post back and adds the note after a crash right after the reject', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(t.whatsapp.last(PHONES.yasir))[1]); // Düzeltme iste
        const crashed = t.trypost.crashOn('POST /posts/p1/reject', { when: 'after' });
        t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
        await crashed;
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.posts.get('p1').status, 'draft');
        const notes = t.trypost.notes.map((note) => note.body);
        assert.deepEqual(notes.filter((body) => body.includes('19:00')).length, 1);
        assert.match(notes[0], /düzeltme istedi.*19:00/);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /gönderi düzeltme için geri gönderildi/);
        assert.equal(textsTo(t, PHONES.yasir, /kararını zaten aldım/).length, 0);
    });

    it('adds the "Uygun" note after a crash right after the decision was recorded', async () => {
        t.trypost.posts.set('p2', post({ id: 'p2', status: 'draft' }));
        await t.user.hello(PHONES.mehmet);
        await t.echo.handleProjectEvent('marmara', {
            id: 'f1',
            type: 'post.feedback_requested',
            data: { ...post({ id: 'p2', status: 'draft' }), feedback: { requested_by: { id: 'u-yasir' }, recipients: [{ id: 'u-mehmet' }] } },
        });
        const [ok] = buttonsOf(t.whatsapp.last(PHONES.mehmet));
        const crashed = t.trypost.crashOn('POST /posts/p2/notes', { when: 'before' });
        t.user.tap(PHONES.mehmet, ok, 'ok-1');
        await crashed;
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.notes.filter((note) => note.body.includes('Mehmet: Uygun')).length, 1);
        assert.match(t.whatsapp.last(PHONES.mehmet).text.body, /görüşün eklendi/);
        assert.equal(textsTo(t, PHONES.mehmet, /zaten aldım/).length, 0);
    });
});

describe('request ids: a retried decision is only claimed when TryPost says it was ours', () => {
    let t;
    let request;
    beforeEach(async () => {
        t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        request = t.whatsapp.last(PHONES.yasir);
    });
    const notesWith = (text) => t.trypost.notes.filter((note) => note.body.includes(text));
    const decisionRow = () => t.store.decision(t.store.outboxByWaId(request.id).id, PHONES.yasir);
    const sent = (verb) => t.trypost.requests.filter((r) => r.path.endsWith(`/${verb}`));

    for (const versioned of [false, true]) {
        it(`does not claim an approval made in the panel after its own call was lost before reaching TryPost${versioned ? ' (content_version)' : ''}`, async () => {
            if (versioned) {
                const event = approvalEvent(post(), 'evt-v');
                event.data.content_version = contentVersion(post());
                await t.echo.handleProjectEvent('marmara', event);
                request = t.whatsapp.last(PHONES.yasir);
            }
            t.trypost.crashOn('POST /posts/p1/approve', { when: 'before', mode: 'network' });
            await t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
            assert.equal(t.store.inbox('tap-1').status, 'pending');
            // Another admin edits the post and approves it in the panel.
            t.trypost.panelDecide('p1', 'approve', { content: 'Panelde düzenlendi' });
            const requestsBefore = t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive').length;
            await later(t, 31_000);

            assert.equal(t.store.inbox('tap-1').status, 'done');
            assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 0);
            assert.equal(textsTo(t, PHONES.yasir, /artık onay beklemiyor; başka biri karar vermiş/).length, 1);
            assert.equal(notesWith('Yasir onayladı').length, 0);
            assert.equal(decisionRow(), null);
            // No new approval request for a post that is no longer pending.
            assert.equal(t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive').length, requestsBefore);
        });
    }

    it('does not claim an approval made in the panel (without an edit) after its own call was lost', async () => {
        t.trypost.crashOn('POST /posts/p1/approve', { when: 'before', mode: 'network' });
        await t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
        t.trypost.panelDecide('p1', 'approve');
        await later(t, 31_000);

        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 0);
        assert.equal(textsTo(t, PHONES.yasir, /başka biri karar vermiş/).length, 1);
        assert.equal(notesWith('Yasir onayladı').length, 0);
        assert.equal(decisionRow(), null);
    });

    it('claims its own approval when TryPost applied it and the answer was lost (replayed)', async () => {
        t.trypost.crashOn('POST /posts/p1/approve', { when: 'after', mode: 'network' });
        await t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
        const id = decisionRow().request_id;
        assert.equal(t.trypost.decided.get(`p1 ${id}`), 'approve');
        await later(t, 31_000);

        assert.deepEqual(sent('approve').map((r) => r.body.request_id), [id, id]);
        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 1);
        assert.equal(notesWith('Yasir onayladı').length, 1);
        assert.equal(decisionRow().state, 'applied');
        await later(t, 3 * 60 * 60_000);
        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 1);
        assert.equal(notesWith('Yasir onayladı').length, 1);
    });

    it('applies a decision whose process died after recording it and before calling TryPost', async () => {
        const crashed = t.trypost.crashOn('POST /posts/p1/approve', { when: 'before' });
        t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
        await crashed;
        const id = decisionRow().request_id;
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
        assert.equal(t.trypost.decided.get(`p1 ${id}`), 'approve');
        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 1);
        assert.equal(notesWith('Yasir onayladı').length, 1);
    });

    it('does not claim a rejection when someone else decided after its own call was lost', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(request)[1]); // Düzeltme iste
        t.trypost.crashOn('POST /posts/p1/reject', { when: 'before', mode: 'network' });
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
        t.trypost.panelDecide('p1', 'reject', { content: 'Panelde düzenlendi' });
        await later(t, 31_000);

        assert.equal(t.store.inbox('note-1').status, 'done');
        assert.equal(textsTo(t, PHONES.yasir, /geri gönderildi/).length, 0);
        assert.equal(textsTo(t, PHONES.yasir, /başka biri karar vermiş/).length, 1);
        assert.equal(notesWith('düzeltme istedi').length, 0);
        assert.deepEqual(t.trypost.notes.map((note) => note.body), ['💬 Yasir (WhatsApp): Saat 19:00 olacak']);
        assert.equal(textsTo(t, PHONES.yasir, /Düzeltme notunu gönderiye yorum olarak ekledim/).length, 1);
        assert.equal(decisionRow(), null);
    });

    it('keeps the typed text as a comment once when the note POST fails after a refused reject', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(request)[1]);
        t.trypost.panelDecide('p1', 'approve'); // someone approved before the note arrived
        t.trypost.crashOn('POST /posts/p1/notes', { when: 'before', mode: 'network' });
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
        assert.equal(t.store.inbox('note-1').status, 'pending');
        await later(t, 31_000);

        assert.equal(t.store.inbox('note-1').status, 'done');
        assert.equal(textsTo(t, PHONES.yasir, /artık onay beklemiyor/).length, 1); // explained once
        assert.deepEqual(t.trypost.notes.map((note) => note.body), ['💬 Yasir (WhatsApp): Saat 19:00 olacak']);
        assert.equal(textsTo(t, PHONES.yasir, /Düzeltme notunu gönderiye yorum olarak ekledim/).length, 1);
    });

    it('keeps the typed text as a comment when the reject hits a request_id conflict', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(request)[1]);
        const crashed = t.trypost.crashOn('POST /posts/p1/reject', { when: 'before' });
        t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
        await crashed;
        t.trypost.decided.set(`p1 ${decisionRow().request_id}`, 'approve');
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        assert.equal(textsTo(t, PHONES.yasir, /paneli kullan/).length, 1);
        assert.deepEqual(t.trypost.notes.map((note) => note.body), ['💬 Yasir (WhatsApp): Saat 19:00 olacak']);
        assert.equal(textsTo(t, PHONES.yasir, /Düzeltme notunu gönderiye yorum olarak ekledim/).length, 1);
        assert.equal(decisionRow(), null);
    });

    it('claims its own rejection when TryPost applied it and the answer was lost (replayed)', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(request)[1]);
        t.trypost.crashOn('POST /posts/p1/reject', { when: 'after', mode: 'network' });
        await t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
        await later(t, 31_000);

        const [first, second] = sent('reject');
        assert.equal(second.body.request_id, first.body.request_id);
        assert.match(first.body.request_id, /-yasir-reject-/);
        assert.equal(t.trypost.posts.get('p1').status, 'draft');
        assert.equal(notesWith('düzeltme istedi').length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /geri gönderildi/).length, 1);
    });

    it('rejects after a crash right after the decision was recorded', async () => {
        await t.user.tap(PHONES.yasir, buttonsOf(request)[1]);
        const crashed = t.trypost.crashOn('POST /posts/p1/reject', { when: 'before' });
        t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
        await crashed;
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.posts.get('p1').status, 'draft');
        assert.equal(notesWith('düzeltme istedi').length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /geri gönderildi/).length, 1);
    });

    it('drops a decision whose request_id TryPost recorded for another action, and points to the panel', async () => {
        const crashed = t.trypost.crashOn('POST /posts/p1/approve', { when: 'before' });
        t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
        await crashed;
        t.trypost.decided.set(`p1 ${decisionRow().request_id}`, 'reject');
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(t.trypost.posts.get('p1').status, 'pending_approval');
        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 0);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /paneli kullan/);
        assert.ok(t.logs.some((entry) => entry[0] === 'error' && /request_id conflict/.test(entry[1])));
        assert.equal(decisionRow(), null);
    });

    it('does not claim a decision started before request ids existed (after an upgrade)', async () => {
        const crashed = t.trypost.crashOn('POST /posts/p1/approve', { when: 'after' }); // applied, then the old process died
        t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
        await crashed;
        t.db.exec('UPDATE decisions SET request_id = NULL'); // as an older Echo left it
        restart(t);
        await later(t, 6 * 60_000);

        assert.equal(decisionRow(), null);
        assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 0);
        assert.equal(textsTo(t, PHONES.yasir, /doğrulayamadım/).length, 1);
        assert.equal(notesWith('Yasir onayladı').length, 0);
    });

    describe('older TryPost without request_id support', () => {
        beforeEach(() => t.trypost.setLegacy(true));

        it('approves a fresh tap as before', async () => {
            await t.user.tap(PHONES.yasir, buttonsOf(request)[0]);
            assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
            assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 1);
        });

        it('says it could not verify a resumed approval TryPost no longer accepts', async () => {
            t.trypost.crashOn('POST /posts/p1/approve', { when: 'after', mode: 'network' });
            await t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
            await later(t, 31_000);

            assert.equal(t.store.inbox('tap-1').status, 'done');
            assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 0);
            assert.equal(textsTo(t, PHONES.yasir, /Onayının uygulanıp uygulanmadığını doğrulayamadım; lütfen panelden kontrol et/).length, 1);
            assert.equal(notesWith('Yasir onayladı').length, 0);
            assert.equal(decisionRow(), null);
        });

        it('says it could not verify a resumed rejection TryPost no longer accepts', async () => {
            await t.user.tap(PHONES.yasir, buttonsOf(request)[1]);
            t.trypost.crashOn('POST /posts/p1/reject', { when: 'after', mode: 'network' });
            await t.user.say(PHONES.yasir, 'Saat 19:00 olacak', null, 'note-1');
            await later(t, 31_000);

            assert.equal(textsTo(t, PHONES.yasir, /doğrulayamadım/).length, 1);
            assert.equal(textsTo(t, PHONES.yasir, /geri gönderildi/).length, 0);
            assert.equal(notesWith('düzeltme istedi').length, 0);
            assert.equal(notesWith('💬 Yasir (WhatsApp): Saat 19:00 olacak').length, 1);
            assert.equal(textsTo(t, PHONES.yasir, /yorum olarak ekledim/).length, 1);
        });

        it('still applies a resumed approval whose call never reached TryPost', async () => {
            t.trypost.crashOn('POST /posts/p1/approve', { when: 'before', mode: 'network' });
            await t.user.tap(PHONES.yasir, buttonsOf(request)[0], 'tap-1');
            await later(t, 31_000);
            assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
            assert.equal(textsTo(t, PHONES.yasir, /Onaylandı/).length, 1);
            assert.equal(notesWith('Yasir onayladı').length, 1);
        });
    });
});

describe('decisions table migration', () => {
    it('adds the new columns to an existing database and counts old decisions as applied', () => {
        const dir = mkdtempSync(join(tmpdir(), 'echo-'));
        try {
            const old = new DatabaseSync(join(dir, 'echo.db'));
            old.exec(`
                CREATE TABLE decisions (outbox_id INTEGER NOT NULL, phone TEXT NOT NULL, action TEXT NOT NULL, decided_at INTEGER NOT NULL, PRIMARY KEY (outbox_id, phone));
                INSERT INTO decisions VALUES (7, '905550000001', 'approve', 1);
                CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, item_id TEXT, kind TEXT NOT NULL, recipient TEXT NOT NULL,
                    message_json TEXT NOT NULL, template_json TEXT, fingerprint TEXT, dedupe_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, wa_message_id TEXT UNIQUE,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                INSERT INTO outbox (project, item_id, kind, recipient, message_json, status, created_at, updated_at)
                    VALUES ('marmara', 'p1', 'approval', '905550000001', '{}', 'failed', 1, 1);
            `);
            old.close();

            const db = openDatabase(dir);
            const store = createStore(db);
            assert.deepEqual({ ...store.decision(7, '905550000001') }, { outbox_id: 7, phone: '905550000001', action: 'approve', decided_at: 1, state: 'applied', wa_message_id: null, request_id: null });
            assert.equal(store.unreportedFailures().length, 0); // already reported by the old version
            db.close();
            openDatabase(dir).close(); // a second open finds the columns and changes nothing
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('failed statuses', () => {
    it('reports a failure stored just before a crash', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);

        t.echo.ingest({ messages: [], statuses: [{ id: request.id, status: 'failed', error: '131049: ecosystem' }] }); // then the process dies
        restart(t);
        await t.echo.tick();
        await t.echo.tick();
        assert.equal(t.trypost.notes.filter((note) => note.body.includes('iletilemedi') && note.body.includes('131049')).length, 1);
    });

    it('retries the failure report while TryPost is down', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);

        t.trypost.setDown(true);
        await t.echo.handleWebhook({ messages: [], statuses: [{ id: request.id, status: 'failed', error: '131049: ecosystem' }] });
        assert.equal(t.trypost.notes.length, 0);
        t.trypost.setDown(false);
        await later(t, 5 * 60_000 + 1_000);
        await later(t, 5 * 60_000 + 1_000);
        assert.equal(t.trypost.notes.filter((note) => note.body.includes('iletilemedi')).length, 1);
        // A late "read" does not undo the failure.
        await t.echo.handleWebhook({ messages: [], statuses: [{ id: request.id, status: 'read' }] });
        assert.equal(t.store.outboxByWaId(request.id).status, 'failed');
    });
});

describe('http', () => {
    const start = async (t) => {
        const server = createHttpServer({ config: t.config, echo: t.echo });
        await new Promise((resolve) => server.listen(0, resolve));
        return { server, base: `http://127.0.0.1:${server.address().port}` };
    };
    const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');
    const until = async (check) => {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.ok(check());
    };
    const waBody = (message) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const postWa = (base, body, secret = 'app-secret') =>
        fetch(`${base}/whatsapp`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${sign(secret, body)}` } });

    it('verifies the Meta webhook subscription', async () => {
        const t = setup();
        const { server, base } = await start(t);
        try {
            const ok = await fetch(`${base}/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42`);
            assert.equal(await ok.text(), '42');
            const bad = await fetch(`${base}/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
            assert.equal(bad.status, 403);
        } finally {
            server.close();
        }
    });

    it('accepts only signed project webhooks', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        const { server, base } = await start(t);
        try {
            const body = JSON.stringify(approvalEvent(post()));
            const unsigned = await fetch(`${base}/projects/marmara/webhook`, { method: 'POST', body, headers: { 'X-Webhook-Signature': 'x' } });
            assert.equal(unsigned.status, 401);
            const signed = await fetch(`${base}/projects/marmara/webhook`, {
                method: 'POST',
                body,
                headers: { 'X-Webhook-Signature': sign('hook-secret', body) },
            });
            assert.equal(signed.status, 200);
            // Queued before the answer, delivered after it.
            await until(() => t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive').length === 1);
            const bad = await fetch(`${base}/projects/marmara/webhook`, { method: 'POST', body: '{nope', headers: { 'X-Webhook-Signature': sign('hook-secret', '{nope') } });
            assert.equal(bad.status, 400);
        } finally {
            server.close();
        }
    });

    it('accepts only WhatsApp webhooks signed with the app secret', async () => {
        const t = setup();
        const { server, base } = await start(t);
        try {
            const body = JSON.stringify({
                entry: [{ changes: [{ value: { messages: [{ id: 'w1', from: PHONES.yasir, type: 'text', text: { body: 'selam' }, timestamp: '1' }] } }] }],
            });
            const bad = await fetch(`${base}/whatsapp`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': 'sha256=00' } });
            assert.equal(bad.status, 401);
            const good = await fetch(`${base}/whatsapp`, {
                method: 'POST',
                body,
                headers: { 'X-Hub-Signature-256': `sha256=${sign('app-secret', body)}` },
            });
            assert.equal(good.status, 200);
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.match(t.whatsapp.last(PHONES.yasir).text.body, /Merhaba/);
        } finally {
            server.close();
        }
    });

    it('answers Meta 200 only after the message is stored, and 500 when it could not be', async () => {
        const t = setup();
        const { server, base } = await start(t);
        const receive = t.store.receive;
        try {
            t.store.receive = () => {
                throw new Error('database is locked');
            };
            const body = waBody({ id: 'w1', from: PHONES.yasir, type: 'text', text: { body: 'selam' }, timestamp: '1' });
            const failed = await postWa(base, body);
            assert.equal(failed.status, 500); // Meta will send it again
            assert.equal(t.store.inbox('w1'), null);

            t.store.receive = receive;
            const retried = await postWa(base, body);
            assert.equal(retried.status, 200);
            assert.ok(t.store.inbox('w1')); // stored before the answer
            await until(() => t.store.inbox('w1').status === 'done');
            assert.equal(textsTo(t, PHONES.yasir, /Merhaba/).length, 1);
        } finally {
            server.close();
        }
    });

    it('rolls back a partly stored webhook so the retry stores all of it', async () => {
        const t = setup();
        const { server, base } = await start(t);
        const touch = t.store.touchWindow;
        try {
            t.store.touchWindow = () => {
                throw new Error('disk I/O error');
            };
            const body = waBody({ id: 'w2', from: PHONES.yasir, type: 'text', text: { body: 'selam' }, timestamp: '1' });
            assert.equal((await postWa(base, body)).status, 500);
            assert.equal(t.store.inbox('w2'), null);
            t.store.touchWindow = touch;
            assert.equal((await postWa(base, body)).status, 200);
            assert.ok(t.store.windowOpen(PHONES.yasir));
        } finally {
            server.close();
        }
    });

    it('stores a failed status before answering, and answers bad JSON with 400', async () => {
        const t = setup();
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);
        const { server, base } = await start(t);
        try {
            const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: request.id, status: 'failed', errors: [{ code: 131049, title: 'ecosystem' }] }] } }] }] });
            assert.equal((await postWa(base, body)).status, 200);
            assert.equal(t.store.outboxByWaId(request.id).status, 'failed');
            await until(() => t.trypost.notes.some((note) => note.body.includes('iletilemedi')));

            assert.equal((await postWa(base, '{not json')).status, 400);
        } finally {
            server.close();
        }
    });
});

describe('whatsapp helpers', () => {
    it('looks up and downloads inbound media with the access token', async () => {
        const calls = [];
        const client = createWhatsAppClient({ graphUrl: 'https://graph.test', graphVersion: 'v23.0', phoneNumberId: '1', accessToken: 'wa-token' }, async (url, init) => {
            calls.push({ url, auth: init.headers.Authorization });
            if (url.endsWith('/v23.0/img-1')) return Response.json({ url: 'https://lookaside.test/x', mime_type: 'image/jpeg; q=1', file_size: 8, sha256: 'ab', id: 'img-1' });
            if (url === 'https://lookaside.test/x') return new Response('12345678');
            return Response.json({ error: { code: 100, message: 'bad id' } }, { status: 400 });
        });
        assert.deepEqual(await client.mediaInfo('img-1'), { url: 'https://lookaside.test/x', mimeType: 'image/jpeg', size: 8, sha256: 'ab' });
        assert.equal(await (await client.downloadMedia('https://lookaside.test/x')).text(), '12345678');
        await assert.rejects(client.mediaInfo('nope'), (error) => error.code === 100 && !error.retryable);
        const hung = createWhatsAppClient({ graphUrl: 'https://graph.test', graphVersion: 'v23.0', phoneNumberId: '1', accessToken: 'wa-token' }, (url, init) =>
            new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
        await assert.rejects(hung.mediaInfo('img-1', { timeoutMs: 20 }), (error) => error.retryable && error.timedOut && /timed out/.test(error.message));
        assert.ok(calls.every((call) => call.auth === 'Bearer wa-token'));
    });

    it('parses button replies, template quick replies and statuses', () => {
        const parsed = parseWebhook({
            entry: [
                {
                    changes: [
                        {
                            value: {
                                messages: [
                                    { id: 'a', from: '90', type: 'interactive', interactive: { button_reply: { id: 'approve:1' } } },
                                    { id: 'b', from: '90', type: 'button', button: { payload: 'ok:2' }, context: { id: 'wamid.9' } },
                                ],
                                statuses: [{ id: 'wamid.1', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }],
                            },
                        },
                    ],
                },
            ],
        });
        assert.deepEqual(parsed.messages.map((m) => m.buttonId), ['approve:1', 'ok:2']);
        assert.equal(parsed.messages[1].contextId, 'wamid.9');
        assert.equal(parsed.statuses[0].error, '131026: Undeliverable');
    });

    it('checks signatures in constant time', () => {
        const body = Buffer.from('{}');
        const header = `sha256=${createHmac('sha256', 's').update(body).digest('hex')}`;
        assert.ok(verifySignature('s', body, header));
        assert.ok(!verifySignature('s', body, 'sha256=abc'));
        assert.ok(!verifySignature('s', body, undefined));
    });
});

/**
 * A fake Hermes Agent WhatsApp Cloud adapter on a real HTTP port: it checks the
 * signature like Hermes does (X-Hub-Signature-256 "sha256=<hex>" of the raw
 * body, keyed by the app secret: 401 otherwise), takes only WhatsApp Business
 * webhooks for its phone number id, and records what it accepted.
 * `respond(status | 'network')` sets the answer to the next requests.
 */
async function fakeHermes({ appSecret = 'app-secret', phoneNumberId = '1' } = {}) {
    const accepted = [];
    const refused = [];
    let answer = 200;
    const server = createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const raw = Buffer.concat(chunks);
            if (answer === 'network') return request.socket.destroy();
            const header = String(request.headers['x-hub-signature-256'] ?? '');
            const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`);
            const given = Buffer.from(header);
            if (request.url !== '/whatsapp/webhook' || given.length !== expected.length || !timingSafeEqual(given, expected)) {
                refused.push(raw.toString());
                response.writeHead(401).end();
                return;
            }
            const body = JSON.parse(raw);
            const value = body.entry?.[0]?.changes?.[0]?.value;
            const ours = body.object === 'whatsapp_business_account' && body.entry[0].changes[0].field === 'messages' && value?.metadata?.phone_number_id === phoneNumberId;
            if (answer !== 200) {
                response.writeHead(answer).end();
                return;
            }
            if (ours) accepted.push(body);
            response.writeHead(200).end();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const messages = () => accepted.flatMap((body) => body.entry[0].changes[0].value.messages ?? []);
    const statuses = () => accepted.flatMap((body) => body.entry[0].changes[0].value.statuses ?? []);
    return {
        url: `http://127.0.0.1:${server.address().port}/whatsapp/webhook`,
        accepted,
        refused,
        messages,
        statuses,
        texts: () => messages().map((message) => message.text?.body ?? message.interactive?.button_reply?.id ?? message.type),
        respond: (status) => (answer = status),
        close: () => {
            server.closeAllConnections();
            return new Promise((resolve) => server.close(resolve));
        },
    };
}

describe('assistant (Hermes) behind Echo', () => {
    let t;
    let hermes;
    after(() => hermes?.close());
    beforeEach(async () => {
        await hermes?.close();
        hermes = await fakeHermes();
        t = setup({ assistant: { url: hermes.url, enabled: true } });
        t.trypost.posts.set('p1', post());
    });

    it('forwards a message Echo does not handle, signed and shaped like Meta\'s webhook, instead of the help reply', async () => {
        await t.user.say(PHONES.yasir, 'Bu hafta ne paylaşıyoruz?', null, 'm1');
        assert.equal(hermes.accepted.length, 1);
        assert.equal(hermes.refused.length, 0);
        const value = hermes.accepted[0].entry[0].changes[0].value;
        assert.equal(value.metadata.phone_number_id, '1');
        assert.deepEqual(value.contacts, [{ profile: { name: 'Yasir' }, wa_id: PHONES.yasir }]);
        assert.equal(value.messages[0].id, 'm1');
        assert.equal(value.messages[0].from, PHONES.yasir);
        assert.deepEqual(value.messages[0].text, { body: 'Bu hafta ne paylaşıyoruz?' });
        assert.equal(t.whatsapp.sent.length, 0); // Hermes answers, not Echo
        assert.equal(t.store.inbox('m1').status, 'done');
    });

    it('passes on exactly what Meta sent: message, contact and metadata', async () => {
        const server = createHttpServer({ config: t.config, echo: t.echo });
        await new Promise((resolve) => server.listen(0, resolve));
        try {
            const message = { from: PHONES.ayse, id: 'wamid.voice', timestamp: '1762862400', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg' } };
            const contact = { profile: { name: 'Ayşe K.' }, wa_id: PHONES.ayse };
            const metadata = { display_phone_number: '908500000000', phone_number_id: '1' };
            const body = JSON.stringify({
                object: 'whatsapp_business_account',
                entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata, contacts: [contact], messages: [message] } }] }],
            });
            const signature = createHmac('sha256', 'app-secret').update(body).digest('hex');
            const answer = await fetch(`http://127.0.0.1:${server.address().port}/whatsapp`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${signature}` } });
            assert.equal(answer.status, 200);
            for (let i = 0; i < 200 && !hermes.accepted.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
            assert.equal(hermes.accepted.length, 1);
            assert.deepEqual(hermes.accepted[0], JSON.parse(body));
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });

    it('keeps Echo\'s own flows: buttons, note sessions, quote-replies and "iptal"', async () => {
        await t.user.hello(PHONES.yasir); // goes to Hermes
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);
        const [, revise, comment] = buttonsOf(request);

        await t.user.tap(PHONES.yasir, comment); // "Yorum yaz": Echo
        await t.user.say(PHONES.yasir, 'Görsel biraz karanlık'); // the note: Echo
        await t.user.say(PHONES.yasir, 'Saat de yanlış', request.id); // quote-reply: Echo
        await t.user.tap(PHONES.yasir, revise); // "Düzeltme iste": Echo
        await t.user.say(PHONES.yasir, 'iptal'); // cancels Echo's session
        await t.user.say(PHONES.yasir, 'iptal'); // nothing open: Echo says so, Hermes never sees it
        await t.user.tap(PHONES.yasir, 'approve:999'); // an old Echo button
        await t.user.tap(PHONES.yasir, 'appr:a1b2:approve'); // Hermes' own approval button
        await t.user.say(PHONES.yasir, 'Teşekkürler'); // nothing of Echo's: Hermes

        assert.deepEqual(hermes.texts(), ['merhaba', 'appr:a1b2:approve', 'Teşekkürler']);
        assert.deepEqual(t.trypost.notes.map((note) => note.body).length, 2);
        assert.match(textsTo(t, PHONES.yasir, /vazgeçildi/)[0].text.body, /vazgeçildi/);
        assert.equal(textsTo(t, PHONES.yasir, /İptal edilecek açık bir işlem yok/).length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /geçerli değil/).length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /o mesajı yanıtla/).length, 0);
    });

    it('retries while Hermes is down, in order per person, and then delivers', async () => {
        hermes.respond(503);
        await t.user.say(PHONES.yasir, 'birinci', null, 'm1');
        await t.user.say(PHONES.yasir, 'ikinci', null, 'm2'); // waits behind the first
        assert.equal(t.store.inbox('m1').status, 'pending');
        assert.equal(t.store.inbox('m2').attempts, 0);
        assert.equal(textsTo(t, PHONES.yasir, /Asistana şu an ulaşamıyorum/).length, 1);

        hermes.respond('network');
        await later(t, 16_000);
        assert.equal(t.store.inbox('m1').attempts, 2);
        assert.equal(hermes.accepted.length, 0);

        hermes.respond(200);
        await later(t, 61_000);
        assert.deepEqual(hermes.texts(), ['birinci', 'ikinci']);
        assert.equal(t.store.inbox('m2').status, 'done');
        assert.equal(textsTo(t, PHONES.yasir, /Asistana şu an ulaşamıyorum/).length, 1);
        assert.equal(textsTo(t, PHONES.yasir, /yanıt veremiyor/).length, 0);
    });

    it('gives up after the last retry and tells the person once', async () => {
        hermes.respond(502);
        await t.user.say(PHONES.yasir, 'orada mısın?', null, 'm1');
        for (let i = 0; i < 6; i++) await later(t, 20 * 60_000);
        assert.equal(t.store.inbox('m1').status, 'failed');
        assert.equal(t.store.inbox('m1').attempts, 5);
        assert.equal(textsTo(t, PHONES.yasir, /Asistan şu an yanıt veremiyor/).length, 1);
        assert.equal(hermes.accepted.length, 0);
    });

    it('does not retry a refusal (bad signature)', async () => {
        t = setup({ assistant: { url: hermes.url, appSecret: 'wrong-secret' } });
        await t.user.say(PHONES.yasir, 'selam', null, 'm1');
        assert.equal(hermes.refused.length, 1);
        assert.equal(t.store.inbox('m1').status, 'failed');
        assert.equal(textsTo(t, PHONES.yasir, /Asistan şu an yanıt veremiyor/).length, 1);
    });

    it('forwards statuses of Hermes\' messages, not of Echo\'s own', async () => {
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const echoMessage = t.whatsapp.last(PHONES.yasir);
        await t.echo.handleWebhook({
            messages: [],
            statuses: [
                { id: echoMessage.id, status: 'delivered', recipient: PHONES.yasir },
                { id: 'wamid.hermes1', status: 'read', recipient: PHONES.yasir, raw: { id: 'wamid.hermes1', status: 'read', recipient_id: PHONES.yasir, timestamp: '1' } },
                { id: 'wamid.stranger', status: 'read', recipient: '905559999999' },
            ],
        });
        assert.deepEqual(hermes.statuses(), [{ id: 'wamid.hermes1', status: 'read', recipient_id: PHONES.yasir, timestamp: '1' }]);
        assert.equal(t.store.outbox(1).status, 'delivered');

        // While Hermes is down a status waits and is sent later; a retried Meta webhook adds it once.
        hermes.respond(500);
        const late = { id: 'wamid.hermes2', status: 'delivered', recipient: PHONES.yasir };
        await t.echo.handleWebhook({ messages: [], statuses: [late] });
        await t.echo.handleWebhook({ messages: [], statuses: [late] });
        hermes.respond(200);
        await later(t, 16_000);
        assert.deepEqual(hermes.statuses().map((status) => status.id), ['wamid.hermes1', 'wamid.hermes2']);
        assert.deepEqual(t.store.forwardStats(), {});
    });

    it('never forwards unknown numbers', async () => {
        await t.user.say('905559999999', 'selam');
        await t.echo.handleWebhook({ messages: [], statuses: [{ id: 'wamid.x', status: 'read', recipient: '905559999999' }] });
        assert.equal(hermes.accepted.length + hermes.refused.length, 0);
        assert.equal(t.whatsapp.sent.length, 0);
    });

    it('keeps the help reply when the assistant is not configured or disabled', async () => {
        t = setup({ assistant: { url: hermes.url, enabled: false } });
        await t.user.say(PHONES.yasir, 'selam');
        assert.equal(hermes.accepted.length, 0);
        assert.match(t.whatsapp.last(PHONES.yasir).text.body, /o mesajı yanıtla/);
    });
});

describe('senders without a phone number (WhatsApp usernames, BSUIDs)', () => {
    const BSUID = 'TR.13491208655302741918';
    /** A Meta webhook body with one text message; `from`, `from_user_id` and the contact fields only when given. */
    const metaBody = ({ id, from, userId, waId, contactUserId, username, text = 'selam' }) => ({
        object: 'whatsapp_business_account',
        entry: [{
            id: 'waba-1',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '908500000000', phone_number_id: '1' },
                    contacts: [{
                        profile: { name: 'Ayşe K.', ...(username ? { username } : {}) },
                        ...(waId ? { wa_id: waId } : {}),
                        ...(contactUserId ? { user_id: contactUserId } : {}),
                    }],
                    messages: [{ ...(from ? { from } : {}), ...(userId ? { from_user_id: userId } : {}), id, timestamp: '1762862400', type: 'text', text: { body: text } }],
                },
            }],
        }],
    });
    const receive = (t, fields) => t.echo.handleWebhook(parseWebhook(metaBody(fields)));

    it('takes the number from contacts[].wa_id when the message has no `from`', async () => {
        const t = setup();
        const parsed = parseWebhook(metaBody({ id: 'm1', waId: PHONES.ayse, userId: BSUID, contactUserId: BSUID }));
        assert.equal(parsed.messages[0].from, PHONES.ayse);
        assert.equal(parsed.messages[0].userId, BSUID);
        await t.echo.handleWebhook(parsed);
        assert.equal(t.store.inbox('m1').phone, PHONES.ayse);
        assert.match(t.whatsapp.last(PHONES.ayse).text.body, /o mesajı yanıtla/);
    });

    it('learns the BSUID seen with a known number and finds the person by it later', async () => {
        const t = setup();
        await receive(t, { id: 'm1', from: PHONES.ayse, waId: PHONES.ayse, userId: BSUID, contactUserId: BSUID });
        assert.equal(t.store.phoneForUserId(BSUID), PHONES.ayse);
        await receive(t, { id: 'm2', userId: BSUID, contactUserId: BSUID, username: 'ayse.k' });
        assert.equal(t.store.inbox('m2').phone, PHONES.ayse);
        assert.equal(t.whatsapp.to(PHONES.ayse).length, 2); // replies still go to the number
        assert.ok(t.logs.some((entry) => entry[0] === 'info' && /without a phone number/.test(entry[1])));
    });

    it('finds people by a configured whatsappUserId or whatsappUsername, and writes to a BSUID with `recipient`', async () => {
        const t = setup({
            people: [
                { id: 'yasir', name: 'Yasir', phone: PHONES.yasir, whatsappUsername: '@HasanVural1' },
                { id: 'ayse', name: 'Ayşe', whatsappUserId: BSUID },
                { id: 'mehmet', name: 'Mehmet', phone: PHONES.mehmet },
            ],
        });
        await receive(t, { id: 'm1', userId: 'TR.999000111222', contactUserId: 'TR.999000111222', username: 'hasanvural1' });
        assert.equal(t.store.inbox('m1').phone, PHONES.yasir);
        await receive(t, { id: 'm2', userId: BSUID, contactUserId: BSUID });
        assert.equal(t.store.inbox('m2').phone, BSUID);
        const reply = t.whatsapp.sent.find((message) => message.recipient === BSUID);
        assert.ok(reply && reply.to === undefined);
        assert.deepEqual(Object.keys(toPayload(PHONES.yasir, { text: 'x' })).slice(0, 1), ['to']);
    });

    it('logs which identifiers an ignored message carried, never its text', async () => {
        const t = setup();
        await receive(t, { id: 'm1', userId: 'TR.555666777888', contactUserId: 'TR.555666777888', text: 'gizli metin' });
        const entry = t.logs.find((line) => line[0] === 'warn' && /unknown number/.test(line[1]));
        assert.deepEqual(entry.slice(2), ['-', 'user=TR.*********888', 'username=no', 'keys=from_user_id,id,timestamp,type,text']);
        assert.ok(!JSON.stringify(t.logs).includes('gizli metin'));
        assert.equal(t.store.inbox('m1'), null);
    });

    it('gives Hermes the resolved number in `from` and `wa_id` when Meta left it out', async () => {
        const hermes = await fakeHermes();
        try {
            const t = setup({ assistant: { url: hermes.url } });
            t.store.learnUserId(BSUID, PHONES.ayse);
            await receive(t, { id: 'm1', userId: BSUID, contactUserId: BSUID, username: 'ayse.k', text: 'merhaba' });
            const value = hermes.accepted[0].entry[0].changes[0].value;
            assert.equal(value.messages[0].from, PHONES.ayse);
            assert.equal(value.messages[0].from_user_id, BSUID);
            assert.deepEqual(value.contacts[0], { profile: { name: 'Ayşe K.', username: 'ayse.k' }, user_id: BSUID, wa_id: PHONES.ayse });
            // A status of Hermes' message addressed by BSUID only is still forwarded.
            await t.echo.handleWebhook({ messages: [], statuses: [{ id: 'wamid.h1', status: 'read', recipient: null, recipientUserId: BSUID }] });
            assert.equal(hermes.statuses().length, 1);
        } finally {
            await hermes.close();
        }
    });
});

/**
 * Gives the fake WhatsApp client Meta's media endpoints: GET /{media-id} and
 * the authenticated download. `files` maps a media id to { bytes, mime, size?, sha256? }.
 */
function fakeMedia(t, files) {
    const lookups = [];
    const downloads = [];
    const answers = []; // queued answers for the lookup: a WhatsAppError to throw
    t.whatsapp.mediaInfo = async (id) => {
        lookups.push(id);
        if (answers.length) throw answers.shift();
        const file = files[id];
        if (!file) throw new WhatsAppError('Unsupported get request', { code: 100, status: 400 });
        return {
            url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${id}&sig=secret`,
            mimeType: file.mime,
            size: file.size ?? file.bytes.length,
            sha256: file.sha256 ?? createHash('sha256').update(file.bytes).digest('hex'),
        };
    };
    t.whatsapp.downloadMedia = async (url, { signal } = {}) => {
        const id = new URL(url).searchParams.get('mid');
        downloads.push(id);
        if (!files[id].hang) return new Response(files[id].bytes, { status: 200, headers: { 'Content-Type': files[id].mime } });
        // Sends the first bytes, then stalls; the body fails when the request is aborted, as with fetch.
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(files[id].bytes.subarray(0, 2)));
                signal?.addEventListener('abort', () => controller.error(signal.reason));
            },
        });
        return new Response(body, { status: 200 });
    };
    return { lookups, downloads, answers };
}

describe('media bridge: WhatsApp media to TryPost for the assistant', () => {
    let t;
    let hermes;
    let media;
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7]);
    const MP4 = Buffer.alloc(64, 7);
    let inbound = 1;
    const receive = (type, block, id = `wamid.media${inbound++}`, from = PHONES.yasir) =>
        t.echo.handleWebhook({ messages: [{ id, from, type, text: null, raw: { from, id, timestamp: '1762862400', type, [type]: block } }], statuses: [] });
    // A message arrives and its upload job (run beside the worker) finishes.
    const send = async (...args) => {
        await receive(...args);
        await t.echo.settled();
    };
    const step = async (ms) => {
        await later(t, ms);
        await t.echo.settled();
    };
    const captions = () => hermes.messages().map((message) => message[message.type]?.caption ?? message.text?.body);
    const target = `https://trypost.test/api#${createHash('sha256').update('token').digest('hex').slice(0, 12)}`;
    const bridged = (messageId, mediaId) => t.store.bridged({ messageId, mediaId, project: 'marmara', target });

    after(() => hermes?.close());
    beforeEach(async () => {
        await hermes?.close();
        hermes = await fakeHermes();
        t = setup({ assistant: { url: hermes.url, enabled: true }, mediaTimeouts: { lookup: 200, download: 400, idle: 60, upload: 100 } });
        media = fakeMedia(t, {
            'hang-1': { bytes: JPEG, mime: 'image/jpeg', hang: true },
            'img-1': { bytes: JPEG, mime: 'image/jpeg' },
            'img-2': { bytes: PNG, mime: 'image/png' },
            'vid-1': { bytes: MP4, mime: 'video/mp4' },
            'pdf-1': { bytes: Buffer.from('%PDF-1.4'), mime: 'application/pdf' },
            'big-1': { bytes: JPEG, mime: 'image/jpeg', size: 11 * 1024 * 1024 },
            'gif-sticker': { bytes: JPEG, mime: 'image/webp; codecs=x' },
            'doc-1': { bytes: Buffer.from('PK'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        });
    });

    it('chooses the TryPost project from the config', () => {
        assert.equal(t.config.mediaBridge, 'marmara');
        const projects = (extra) => [{ id: 'a', type: 'trypost', ...extra }, { id: 'b', type: 'trypost' }];
        const config = (list) => normalizeConfig({ whatsapp: { phoneNumberId: '1', accessToken: 't', appSecret: 's', verifyToken: 'v' }, people: [{ id: 'y', name: 'Y', phone: '905550000001' }], projects: list });
        assert.equal(config([{ id: 'a', type: 'trypost', mediaBridge: false }]).mediaBridge, null);
        assert.equal(config(projects({})).mediaBridge, null); // two projects, none chosen: off
        assert.equal(config(projects({ mediaBridge: true })).mediaBridge, 'a');
        assert.throws(() => config([{ id: 'a', type: 'trypost', mediaBridge: true }, { id: 'b', type: 'trypost', mediaBridge: true }]), /only one project/);
    });

    it('downloads an image, uploads it to TryPost and forwards it with the upload token in its caption', async () => {
        await send('image', { id: 'img-1', mime_type: 'image/jpeg', sha256: 'x', caption: 'Bunu şu metinle paylaş: Atölye cuma!' }, 'wamid.a');
        assert.equal(t.trypost.uploads.length, 1);
        const [upload] = t.trypost.uploads;
        assert.deepEqual(upload.bytes, JPEG);
        assert.equal(upload.type, 'image/jpeg');
        assert.equal(upload.name, 'whatsapp-img-1.jpg');
        assert.equal(upload.auth, 'Bearer token');
        const [message] = hermes.messages();
        assert.equal(message.id, 'wamid.a');
        assert.equal(message.image.id, 'img-1'); // Hermes can still look at the image itself
        assert.equal(message.image.caption, `Bunu şu metinle paylaş: Atölye cuma!\n\n[TryPost medya: upload_token=${upload.token}, tür=image]`);
        assert.equal(t.store.inbox('wamid.a').status, 'done');
        assert.equal(t.whatsapp.sent.length, 0);
        // Nothing secret in the logs: no token, no download URL.
        assert.ok(!JSON.stringify(t.logs).includes(upload.token));
        assert.ok(!JSON.stringify(t.logs).includes('sig=secret'));
    });

    it('gives a caption to media sent without one, and bridges videos, PDFs and several images in a row', async () => {
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' });
        await send('image', { id: 'img-2', mime_type: 'image/png' });
        await send('video', { id: 'vid-1', mime_type: 'video/mp4', caption: 'video' });
        await send('document', { id: 'pdf-1', mime_type: 'application/pdf', filename: 'sunum/../kulup.pdf' });
        const [one, two, video, pdf] = t.trypost.uploads;
        assert.equal(t.trypost.uploads.length, 4);
        assert.equal(pdf.name, 'sunum_.._kulup.pdf');
        assert.equal(video.type, 'video/mp4');
        assert.deepEqual(captions(), [
            `[TryPost medya: upload_token=${one.token}, tür=image]`,
            `[TryPost medya: upload_token=${two.token}, tür=image]`,
            `video\n\n[TryPost medya: upload_token=${video.token}, tür=video]`,
            `[TryPost medya: upload_token=${pdf.token}, tür=document]`,
        ]);
    });

    it('uploads once: a forward retried while the assistant is down and a redelivered webhook reuse the upload', async () => {
        hermes.respond(503);
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a');
        assert.equal(t.store.inbox('wamid.a').status, 'pending');
        hermes.respond(200);
        await step(16_000);
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a'); // Meta sends the webhook again
        assert.equal(t.store.inbox('wamid.a').attempts, 2); // the wait for the upload counted no try
        assert.equal(t.trypost.uploads.length, 1);
        assert.equal(media.downloads.length, 1);
        assert.deepEqual(captions(), [`[TryPost medya: upload_token=${t.trypost.uploads[0].token}, tür=image]`]);
        assert.equal(bridged('wamid.a', 'img-1').status, 'uploaded');
    });

    it('retries a failing upload a bounded number of times, quietly, then forwards with a failure note', async () => {
        t.trypost.uploadAnswers.push(503, 'network', 503);
        await send('image', { id: 'img-1', mime_type: 'image/jpeg', caption: 'paylaş' }, 'wamid.a');
        assert.equal(hermes.messages().length, 0);
        assert.equal(t.store.inbox('wamid.a').attempts, 0);
        await step(16_000);
        assert.equal(hermes.messages().length, 0);
        await step(61_000);
        assert.deepEqual(captions(), ['paylaş\n\n[TryPost medya yüklenemedi: bağlantı sorunu]']);
        assert.equal(t.store.inbox('wamid.a').status, 'done');
        assert.equal(bridged('wamid.a', 'img-1').attempts, 3);
        assert.equal(t.whatsapp.sent.length, 0); // no "Asistana ulaşamıyorum" for a media retry
    });

    it('recovers when a retry succeeds', async () => {
        t.trypost.uploadAnswers.push(502);
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a');
        await step(16_000);
        assert.deepEqual(captions(), [`[TryPost medya: upload_token=${t.trypost.uploads[0].token}, tür=image]`]);
    });

    it('does not retry what cannot succeed: refused by TryPost, too large, unsupported or unknown media', async () => {
        t.trypost.uploadAnswers.push(422);
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' });
        await send('image', { id: 'big-1', mime_type: 'image/jpeg' });
        await send('document', { id: 'doc-1', mime_type: 'application/msword', filename: 'a.docx' });
        await send('image', { id: 'missing', mime_type: 'image/jpeg' });
        assert.deepEqual(captions(), [
            '[TryPost medya yüklenemedi: TryPost dosyayı kabul etmedi]',
            '[TryPost medya yüklenemedi: dosya çok büyük (11.0 MB, sınır 10 MB)]',
            '[TryPost medya yüklenemedi: desteklenmeyen dosya türü (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]',
            '[TryPost medya yüklenemedi: WhatsApp medyası alınamadı]',
        ]);
        assert.deepEqual(media.downloads, ['img-1']); // the large one was refused from its announced size
        assert.equal(t.trypost.uploads.length, 0);
    });

    it('retries when WhatsApp\'s media lookup is temporarily down', async () => {
        media.answers.push(new WhatsAppError('busy', { status: 500, retryable: true }));
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a');
        assert.equal(hermes.messages().length, 0);
        await step(16_000);
        assert.equal(t.trypost.uploads.length, 1);
        assert.equal(hermes.messages().length, 1);
    });

    it('leaves other messages as they were: text, audio, and media when the bridge is off', async () => {
        await t.user.say(PHONES.yasir, 'Bu hafta ne paylaşıyoruz?');
        await send('audio', { id: 'aud-1', mime_type: 'audio/ogg' });
        assert.deepEqual(hermes.texts(), ['Bu hafta ne paylaşıyoruz?', 'audio']);
        assert.equal(hermes.messages()[1].audio.caption, undefined);
        assert.equal(t.trypost.uploads.length + media.lookups.length, 0);

        const off = setup({ assistant: { url: hermes.url }, projectExtra: { mediaBridge: false } });
        assert.equal(off.config.mediaBridge, null);
    });

    it('keeps Echo\'s approval flow as it was: buttons and notes go to TryPost, nothing is uploaded', async () => {
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        const request = t.whatsapp.last(PHONES.yasir);
        const [approve, , comment] = buttonsOf(request);
        await t.user.tap(PHONES.yasir, comment);
        await t.user.say(PHONES.yasir, 'Görsel biraz karanlık');
        await t.user.tap(PHONES.yasir, approve);
        assert.ok(t.trypost.notes.some((note) => note.body.includes('Görsel biraz karanlık')));
        assert.equal(t.trypost.posts.get('p1').status, 'scheduled');
        assert.deepEqual(hermes.texts(), ['merhaba']);
        assert.equal(t.trypost.uploads.length + media.lookups.length, 0);
    });

    it('gives a new message a fresh upload even when it carries the same media id', async () => {
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a');
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.b'); // e.g. forwarded again after a post spent the first token
        const [first, second] = t.trypost.uploads;
        assert.equal(t.trypost.uploads.length, 2);
        assert.notEqual(first.token, second.token);
        assert.deepEqual(captions(), [
            `[TryPost medya: upload_token=${first.token}, tür=image]`,
            `[TryPost medya: upload_token=${second.token}, tür=image]`,
        ]);
    });

    it('never reuses an upload made for another workspace (project API URL or token changed)', async () => {
        hermes.respond(503);
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a'); // uploaded, the forward waits
        assert.equal(t.trypost.uploads.length, 1);
        t.config = baseConfig({ assistant: { url: hermes.url }, projectExtra: { apiToken: 'stage-token' } });
        restart(t);
        hermes.respond(200);
        await step(16_000);
        const [, again] = t.trypost.uploads;
        assert.equal(t.trypost.uploads.length, 2);
        assert.equal(again.auth, 'Bearer stage-token');
        assert.deepEqual(captions(), [`[TryPost medya: upload_token=${again.token}, tür=image]`]);
    });

    it('cuts a stalled download, retries it (bounded) and forwards with a timeout note', async () => {
        await send('image', { id: 'hang-1', mime_type: 'image/jpeg', caption: 'paylaş' }, 'wamid.a');
        assert.equal(hermes.messages().length, 0);
        assert.equal(bridged('wamid.a', 'hang-1').attempts, 1);
        await step(16_000);
        await step(61_000);
        assert.deepEqual(media.downloads, ['hang-1', 'hang-1', 'hang-1']);
        assert.deepEqual(captions(), ['paylaş\n\n[TryPost medya yüklenemedi: zaman aşımı]']);
        assert.equal(t.trypost.uploads.length, 0);
    });

    it('cuts a hung upload and retries it', async () => {
        t.trypost.uploadAnswers.push('hang');
        await send('image', { id: 'img-1', mime_type: 'image/jpeg' }, 'wamid.a');
        assert.equal(hermes.messages().length, 0);
        assert.match(t.logs.flat().join(' '), /timed out after 100 ms/);
        await step(16_000);
        assert.deepEqual(captions(), [`[TryPost medya: upload_token=${t.trypost.uploads[0].token}, tür=image]`]);
    });

    it('does not hold up approvals while an upload is slow', async () => {
        t.trypost.posts.set('p1', post());
        await t.user.hello(PHONES.yasir);
        await receive('image', { id: 'hang-1', mime_type: 'image/jpeg' }, 'wamid.a'); // its upload stalls in the background
        const started = Date.now();
        await t.echo.handleProjectEvent('marmara', approvalEvent(post()));
        assert.ok(Date.now() - started < 50);
        assert.equal(buttonsOf(t.whatsapp.last(PHONES.yasir)).length, 3); // the approval request went out at once
        assert.equal(hermes.messages().filter((message) => message.type === 'image').length, 0);
        await t.echo.settled();
    });
});

