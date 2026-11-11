import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { createEcho } from '../src/core.js';
import { createStore, openDatabase } from '../src/db.js';
import { createTryPostProject, fingerprint, sameVersion, versionTag } from '../src/projects/trypost.js';
import { createHttpServer } from '../src/server.js';
import { WhatsAppError, parseWebhook, verifySignature } from '../src/whatsapp.js';

const PHONES = { yasir: '905550000001', ayse: '905550000002', mehmet: '905550000003' };

const baseConfig = () =>
    normalizeConfig({
        whatsapp: { phoneNumberId: '1', accessToken: 't', appSecret: 'app-secret', verifyToken: 'verify' },
        people: [
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

    return {
        posts,
        notes,
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

function setup() {
    const clock = { t: Date.parse('2026-11-11T12:00:00Z') };
    const config = baseConfig();
    const db = openDatabase(':memory:');
    const store = createStore(db, () => clock.t);
    const whatsapp = fakeWhatsApp();
    const trypost = fakeTryPost(clock);
    const logs = [];
    const t = { clock, config, db, store, whatsapp, trypost, logs };
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
    const echo = createEcho({ config: t.config, store: t.store, whatsapp: t.whatsapp, log: (...parts) => t.logs.push(parts) });
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
