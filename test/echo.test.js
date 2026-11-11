import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
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
 * `content_version` to the post resource and refuses (409) an approve/reject
 * whose `expected_version` is not the current one.
 */
function fakeTryPost() {
    const posts = new Map();
    const notes = [];
    const calls = [];
    const requests = [];
    const hooks = { afterGet: null };
    let down = false;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    return {
        posts,
        notes,
        calls,
        requests,
        hooks,
        setDown: (value) => (down = value),
        fetch: async (url, init) => {
            const path = new URL(url).pathname.replace(/^\/api/, '');
            calls.push(`${init.method} ${path}`);
            const body = init.body ? JSON.parse(init.body) : null;
            requests.push({ method: init.method, path, body });
            if (down === 'network') throw new TypeError('fetch failed');
            if (typeof down === 'number') return json(down, { message: 'error' });
            if (down) return json(503, { message: 'down' });
            const match = path.match(/^\/posts\/([^/]+)(?:\/(\w+))?$/);
            const post = match && posts.get(match[1]);
            if (!post) return json(404, { message: 'not found' });
            if (init.method === 'GET') {
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
                if (body?.expected_version && body.expected_version !== contentVersion(post)) {
                    return json(409, { message: 'content changed', content_version: contentVersion(post) });
                }
                if (post.status !== 'pending_approval') return json(422, { message: 'not pending' });
                post.status = match[2] === 'approve' ? 'scheduled' : 'draft';
                return json(200, { data: toApi(post) });
            }
            return json(404, {});
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
    const store = createStore(openDatabase(':memory:'), () => clock.t);
    const whatsapp = fakeWhatsApp();
    const trypost = fakeTryPost();
    const logs = [];
    const echo = createEcho({ config, store, whatsapp, log: (...parts) => logs.push(parts) });
    echo.register('marmara', createTryPostProject(config.projects[0], { fetchImpl: trypost.fetch }));

    let inbound = 1;
    const user = {
        /** The person writes to us first, opening their 24-hour window. */
        async hello(phone) {
            await echo.handleWebhook({ messages: [{ id: `in.${inbound++}`, from: phone, type: 'text', text: 'merhaba' }], statuses: [] });
        },
        async tap(phone, buttonId, id = `in.${inbound++}`) {
            await echo.handleWebhook({ messages: [{ id, from: phone, type: 'interactive', buttonId }], statuses: [] });
        },
        async say(phone, text, contextId = null) {
            await echo.handleWebhook({ messages: [{ id: `in.${inbound++}`, from: phone, type: 'text', text, contextId }], statuses: [] });
        },
    };
    return { clock, config, store, whatsapp, trypost, echo, user, logs };
}

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
        assert.deepEqual(approve.body, { expected_version: contentVersion(post()) });
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
        assert.equal(t.trypost.notes.length, 0);
        assert.match(t.whatsapp.to(PHONES.yasir).at(-1).interactive.body.text, /Atölye ertelendi/);
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

describe('http', () => {
    const start = async (t) => {
        const server = createHttpServer({ config: t.config, echo: t.echo });
        await new Promise((resolve) => server.listen(0, resolve));
        return { server, base: `http://127.0.0.1:${server.address().port}` };
    };
    const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');

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
            assert.equal(t.whatsapp.to(PHONES.yasir).filter((m) => m.type === 'interactive').length, 1);
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
