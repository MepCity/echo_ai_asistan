import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { normalizeStudio } from '../src/studio/config.js';
import { MESSAGES, createStudioGateway, dayOf } from '../src/studio/gateway.js';
import { createHiggsfieldClient, parseCompact, parseCredits, parseJob, parseJobIds } from '../src/studio/higgsfield.js';
import { createHiggsfieldAuth, createTokenFile, parsePasted } from '../src/studio/oauth.js';
import { bearerMatches, createStudioServer } from '../src/studio/server.js';
import { createStudioStore, openStudioDatabase } from '../src/studio/store.js';

const dirs = [];
const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-studio-'));
    dirs.push(dir);
    return dir;
};
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'studio-secret-0123456789abcdef';
const JOB = '11111111-2222-4333-8444-555555555555';
// A real PNG header (IHDR 2048x2560) plus payload bytes: what "Higgsfield" returns.
const PNG = (() => {
    const header = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const size = Buffer.alloc(8);
    size.writeUInt32BE(2048, 0);
    size.writeUInt32BE(2560, 4);
    return Buffer.concat([header, size, Buffer.from('0806000000', 'hex'), Buffer.alloc(5000, 7)]);
})();
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 3)]);

function echoConfig(dataDir) {
    return normalizeConfig({
        dataDir,
        whatsapp: { phoneNumberId: '1', accessToken: 't', appSecret: 's', verifyToken: 'v' },
        people: [
            { id: 'yasir', name: 'Yasir', phone: '905550000001' },
            { id: 'ayse', name: 'Ayşe', phone: '905550000002' },
        ],
        projects: [
            {
                id: 'marmara',
                type: 'trypost',
                apiUrl: 'https://trypost.test/api',
                apiToken: 'tp',
                webhookSecret: 'w',
                members: [{ person: 'yasir', userId: 'u1', roles: ['approver'] }],
            },
        ],
    });
}

/**
 * A fake Higgsfield (the MCP tool layer): records every call; estimates and
 * job results can be set per test.
 */
function fakeHiggsfield({ estimate = 2.75, jobStatus = 'completed', resultUrl = 'https://cdn.higgsfield.test/out/x.png' } = {}) {
    const calls = [];
    const fake = {
        calls,
        estimate,
        jobStatus,
        resultUrl,
        generateError: null,
        waitGate: null,
        async call(name, args) {
            calls.push({ name, args });
            if (name === 'estimate_image_cost' || name === 'estimate_audio_cost') {
                return { text: `Cost preflight for ${args.params.model}: ${fake.estimate} credits (${fake.estimate} exact). No job submitted.`, structured: null, isError: false };
            }
            if (name === 'generate_image' || name === 'generate_audio') {
                if (fake.generateError) throw fake.generateError;
                return { text: `jobs[1]{index,job_id,status}:\n  0,${JOB},queued`, structured: null, isError: false };
            }
            if (name === 'jobs_wait') {
                if (fake.waitGate) await fake.waitGate;
                return {
                    text: `jobs[1]{index,job_id,status,type,model,result_url}:\n  0,${JOB},${fake.jobStatus},image,m,"${fake.resultUrl}"\nall_terminal: true`,
                    structured: null,
                    isError: false,
                };
            }
            if (name === 'media_import_url') return { text: 'media_id: 99999999-2222-4333-8444-555555555555', structured: null, isError: false };
            throw new Error(`unexpected call ${name}`);
        },
        generated: () => calls.filter((call) => call.name.startsWith('generate_')),
    };
    return fake;
}

/** Fetch for result downloads and presigned uploads. */
const downloadFetch = (bytes = PNG, type = 'image/png') => async (url) => {
    assert.ok(String(url).startsWith('https://cdn.higgsfield.test/'));
    return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
};

/** A fake TryPost for attach_to_trypost: records uploads (their bytes) and API calls. */
function fakeTryPost({ posts = ['post-1'] } = {}) {
    const uploads = [];
    const requests = [];
    return {
        uploads,
        requests,
        imageLimitMb: 10,
        async uploadMedia({ file, filename, mimeType }) {
            uploads.push({ bytes: Buffer.from(await file.arrayBuffer()), filename, mimeType });
            return { uploadToken: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', type: 'image' };
        },
        async request(method, path, body) {
            requests.push({ method, path, body });
            const match = path.match(/^\/posts\/([^/]+)/);
            if (match && !posts.includes(match[1])) throw Object.assign(new Error(`TryPost ${method} ${path} -> 404`), { status: 404 });
            if (method === 'POST' && path === '/posts') return { data: { id: 'new-post-9' } };
            return { data: { id: match?.[1] } };
        },
    };
}

function setup({ studio = {}, start = Date.parse('2026-11-20T09:00:00Z'), higgsfield = fakeHiggsfield(), fetchImpl = downloadFetch(), trypost = fakeTryPost() } = {}) {
    const dataDir = tempDir();
    const config = echoConfig(dataDir);
    const settings = normalizeStudio({ waitSliceSec: 1, ...studio }, config, { STUDIO_PREVIEW_DIR: join(dataDir, 'hermes-preview'), STUDIO_BRAND_KIT: join(dataDir, 'brand-kit.md') });
    const clock = { now: start };
    const store = createStudioStore(openStudioDatabase(':memory:'), () => clock.now);
    const gateway = createStudioGateway({ settings, store, higgsfield, trypost, fetchImpl, sleep: async (ms) => (clock.now += ms) });
    return { gateway, store, settings, higgsfield, trypost, clock, dataDir };
}

const call = (gateway, name, args) => gateway.callTool(name, args);
const image = (gateway, args = {}) => call(gateway, 'generate_image', { prompt: 'A clean modern poster for an AI workshop', ...args });

describe('studio gateway: tools and allowlist', () => {
    it('lists only the studio tools, read-only ones marked readOnlyHint', () => {
        const { gateway } = setup();
        const names = gateway.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, ['attach_to_trypost', 'generate_audio', 'generate_image', 'get_brand_kit', 'get_generation', 'get_original_file', 'studio_usage']);
        const readOnly = gateway.tools.filter((tool) => tool.annotations.readOnlyHint === true).map((tool) => tool.name).sort();
        assert.deepEqual(readOnly, ['get_brand_kit', 'get_generation', 'get_original_file', 'studio_usage']);
        for (const tool of gateway.tools) assert.ok(!/video/.test(tool.name));
    });

    it('refuses a video model without calling Higgsfield, and records the attempt', async () => {
        const { gateway, higgsfield, store } = setup();
        const result = await image(gateway, { model: 'kling_3_0' });
        assert.equal(result.isError, true);
        assert.equal(result.text, MESSAGES.video);
        assert.equal(higgsfield.calls.length, 0);
        const audio = await call(gateway, 'generate_audio', { kind: 'video' });
        assert.equal(audio.text, MESSAGES.video);
        assert.equal(store.usage(dayOf(store.now(), 'Europe/Istanbul'), '2026-11').counts.image, 0);
    });

    it('refuses a model outside the allowlist (and one a config narrowed away)', async () => {
        const { gateway, higgsfield } = setup({ studio: { imageModels: ['gpt_image_2_6', 'flux_pro'] } });
        assert.match((await image(gateway, { model: 'nano_banana_2_1' })).text, /Bu model kullanılamıyor/);
        assert.match((await image(gateway, { model: 'soul_2' })).text, /Bu model kullanılamıyor/);
        assert.equal(higgsfield.calls.length, 0);
    });

    it('the Higgsfield client never sends a tool outside its allowlist', async () => {
        let fetched = 0;
        const client = createHiggsfieldClient({ url: 'https://mcp.test/mcp', auth: { token: async () => 't', refresh: async () => 't' }, fetchImpl: async () => (fetched++, new Response('{}')) });
        for (const name of ['generate_video', 'generate_image_batch', 'upscale_video', 'execute_preset', 'gpu_generate', 'tiktok_publish_status', 'deploy_website']) {
            await assert.rejects(client.call(name, {}), /not allowed/);
        }
        assert.equal(fetched, 0);
    });

    it('builds the request server-side: count and batch_size 1, no unlimited or free generations, extra fields dropped', async () => {
        const { gateway, higgsfield } = setup();
        const result = await image(gateway, { count: 4, batch_size: 4, use_unlim: true, use_free_gens: true, model: 'gpt_image_2_6', platform: 'story' });
        assert.equal(result.isError, false, result.text);
        const [generate] = higgsfield.generated();
        const params = generate.args.params;
        assert.equal(generate.name, 'generate_image');
        assert.equal(params.count, 1);
        assert.equal(params.batch_size, 1);
        assert.equal(params.use_unlim, false);
        assert.equal(params.use_free_gens, undefined);
        assert.equal(params.aspect_ratio, '9:16');
        assert.equal(params.quality, 'high');
        assert.equal(params.resolution, '2k');
        const estimate = higgsfield.calls.find((item) => item.name === 'estimate_image_cost');
        assert.deepEqual(estimate.args.params, params, 'the estimate prices exactly what is sent');
    });

    it('generates in the aspect ratio of the target platform', async () => {
        const { gateway, higgsfield, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        for (const [platform, ratio] of [['instagram', '4:5'], ['x', '16:9'], ['linkedin', '1:1']]) {
            await image(gateway, { platform });
            clock.now += 1000;
            assert.equal(higgsfield.generated().at(-1).args.params.aspect_ratio, ratio);
        }
    });

    it('speech and music: allowlisted models, text and duration caps, count 1', async () => {
        const higgsfield = fakeHiggsfield({ resultUrl: 'https://cdn.higgsfield.test/out/a.mp3' });
        const { gateway, clock } = setup({ higgsfield, fetchImpl: downloadFetch(MP3, 'audio/mpeg'), studio: { limits: { cooldownSec: 0 } } });
        assert.match((await call(gateway, 'generate_audio', { kind: 'speech', text: 'x'.repeat(1501) })).text, /en fazla 1500 karakter/);
        assert.match((await call(gateway, 'generate_audio', { kind: 'music', prompt: 'lofi', duration: 120 })).text, /en fazla 60 saniye/);
        const speech = await call(gateway, 'generate_audio', { kind: 'speech', text: 'Merhaba!', voice: 'erkek' });
        assert.equal(speech.isError, false, speech.text);
        clock.now += 1000;
        await call(gateway, 'generate_audio', { kind: 'music', prompt: 'calm lofi', duration: 60 });
        const [first, second] = higgsfield.generated();
        assert.equal(first.args.params.model, 'elevenlabs_v4');
        assert.equal(first.args.params.dialogue[0].voice_id, '30fc8796-ceb6-4a66-b3a7-4a145ef7f346');
        assert.equal(second.args.params.model, 'elevenlabs_music_v2_5');
        assert.equal(second.args.params.duration, 60);
        assert.equal(second.args.params.force_instrumental, true);
        for (const item of [first, second]) assert.equal(item.args.params.batch_size, 1);
    });
});

describe('studio gateway: limits', () => {
    it('refuses a request whose estimate exceeds the per-request cap, without generating', async () => {
        const higgsfield = fakeHiggsfield({ estimate: 12 });
        const { gateway, store } = setup({ higgsfield });
        const result = await image(gateway);
        assert.equal(result.isError, true);
        assert.equal(result.text, MESSAGES.tooExpensive(12, 10));
        assert.equal(higgsfield.generated().length, 0);
        const row = store.recent().at(-1);
        assert.equal(row.status, 'refused');
        assert.equal(row.estimated_credits, 12);
    });

    it('refuses when the cost cannot be estimated', async () => {
        const higgsfield = fakeHiggsfield();
        higgsfield.estimate = 'unknown';
        const { gateway } = setup({ higgsfield });
        assert.equal((await image(gateway)).text, MESSAGES.noEstimate);
        assert.equal(higgsfield.generated().length, 0);
    });

    it('keeps a cooldown between generations', async () => {
        const { gateway, higgsfield, clock } = setup();
        assert.equal((await image(gateway)).isError, false);
        clock.now += 30_000;
        const second = await image(gateway);
        assert.equal(second.isError, true);
        assert.match(second.text, /bekleme süresi var; yaklaşık \d+ saniye/);
        clock.now += 31_000;
        assert.equal((await image(gateway)).isError, false);
        assert.equal(higgsfield.generated().length, 2);
    });

    it('runs one generation at a time', async () => {
        const higgsfield = fakeHiggsfield();
        let open;
        higgsfield.waitGate = new Promise((resolve) => (open = resolve));
        const { gateway } = setup({ higgsfield, studio: { limits: { cooldownSec: 0 } } });
        const first = image(gateway);
        await new Promise((resolve) => setImmediate(resolve));
        while (!higgsfield.calls.some((item) => item.name === 'jobs_wait')) await new Promise((resolve) => setImmediate(resolve));
        const second = await image(gateway);
        assert.equal(second.text, MESSAGES.busy);
        open();
        assert.equal((await first).isError, false);
        assert.equal(higgsfield.generated().length, 1);
        higgsfield.waitGate = null;
        assert.equal((await image(gateway)).isError, false);
    });

    it('stops at the daily image count with a plain Turkish reason', async () => {
        const { gateway, higgsfield, clock } = setup({ studio: { limits: { cooldownSec: 0, dailyImages: 2 } } });
        await image(gateway);
        clock.now += 1000;
        await image(gateway);
        clock.now += 1000;
        const third = await image(gateway);
        assert.equal(third.text, 'Bugünkü görsel üretim sınırı doldu, yarın tekrar deneyebilirsin.');
        assert.equal(higgsfield.generated().length, 2);
    });

    it('caps daily music and speech counts separately', async () => {
        const higgsfield = fakeHiggsfield({ resultUrl: 'https://cdn.higgsfield.test/out/a.mp3' });
        const { gateway, clock } = setup({ higgsfield, fetchImpl: downloadFetch(MP3, 'audio/mpeg'), studio: { limits: { cooldownSec: 0, dailyMusic: 1, dailySpeech: 1 } } });
        await call(gateway, 'generate_audio', { kind: 'music', prompt: 'x', duration: 10 });
        clock.now += 1000;
        assert.equal((await call(gateway, 'generate_audio', { kind: 'music', prompt: 'y', duration: 10 })).text, MESSAGES.dailyMusic);
        assert.equal((await call(gateway, 'generate_audio', { kind: 'speech', text: 'a' })).isError, false);
        clock.now += 1000;
        assert.equal((await call(gateway, 'generate_audio', { kind: 'speech', text: 'b' })).text, MESSAGES.dailySpeech);
    });

    it('stops at the daily and monthly credit caps', async () => {
        const higgsfield = fakeHiggsfield({ estimate: 8 });
        const { gateway, clock } = setup({ higgsfield, studio: { limits: { cooldownSec: 0, dailyCredits: 20, monthlyCredits: 30 } } });
        await image(gateway);
        clock.now += 1000;
        await image(gateway);
        clock.now += 1000;
        assert.match((await image(gateway)).text, /Bugünkü kredi sınırı bu istek için yetmiyor \(kalan yaklaşık 4 kredi\)/);
        clock.now += 24 * 3600_000;
        await image(gateway);
        clock.now += 1000;
        assert.equal((await image(gateway)).text, MESSAGES.monthlyCredits);
        assert.equal(higgsfield.generated().length, 3);
    });

    it('applies the per-person daily cap to known person keys', async () => {
        const higgsfield = fakeHiggsfield({ estimate: 8 });
        const { gateway, clock } = setup({ higgsfield, studio: { limits: { cooldownSec: 0, perPersonDailyCredits: 10 } } });
        await image(gateway, { requested_by: 'yasir' });
        clock.now += 1000;
        assert.match((await image(gateway, { requested_by: 'yasir' })).text, /senin adına kullanılabilecek kredi sınırı doldu/);
        assert.equal((await image(gateway, { requested_by: 'ayse' })).isError, false);
    });

    it('charges a missing requested_by to the shared "bilinmiyor" bucket with the same cap', async () => {
        const higgsfield = fakeHiggsfield({ estimate: 8 });
        const { gateway, clock, store } = setup({ higgsfield, studio: { limits: { cooldownSec: 0, perPersonDailyCredits: 10 } } });
        assert.equal((await image(gateway)).isError, false);
        assert.equal(store.recent().at(-1).requested_by, 'bilinmiyor');
        clock.now += 1000;
        assert.equal((await image(gateway)).text, MESSAGES.unknownPerson(2), 'leaving requested_by out does not skip the cap');
        assert.equal((await image(gateway, { requested_by: '' })).text, MESSAGES.unknownPerson(2));
        assert.equal(store.recent().at(-1).requested_by, 'bilinmiyor');
        assert.equal((await image(gateway, { requested_by: 'yasir' })).isError, false, 'a known person has their own bucket');
        assert.equal(higgsfield.generated().length, 2);
    });

    it('charges an unknown requested_by to the same "bilinmiyor" bucket', async () => {
        const higgsfield = fakeHiggsfield({ estimate: 8 });
        const { gateway, clock, store } = setup({ higgsfield, studio: { limits: { cooldownSec: 0, perPersonDailyCredits: 10 } } });
        assert.equal((await image(gateway, { requested_by: 'someone-else' })).isError, false);
        assert.equal(store.recent().at(-1).requested_by, 'bilinmiyor');
        clock.now += 1000;
        assert.equal((await image(gateway, { requested_by: 'another-stranger' })).text, MESSAGES.unknownPerson(2));
        assert.equal((await image(gateway)).text, MESSAGES.unknownPerson(2), 'missing and unknown share one bucket');
        assert.equal((await image(gateway, { requested_by: 'bilinmiyor' })).text, MESSAGES.unknownPerson(2));
        assert.equal(higgsfield.generated().length, 1);
    });

    it('a job still pending after the job timeout blocks the next generation until get_generation sees it finished', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1, limits: { cooldownSec: 0 } } });
        const first = await image(gateway);
        assert.equal(first.isError, false);
        assert.match(first.text, /hâlâ hazırlanıyor/);
        const id = store.recent().at(-1).id;
        assert.equal(store.get(id).status, 'submitted');
        clock.now += 60_000;
        const second = await image(gateway);
        assert.equal(second.isError, true);
        assert.equal(second.text, MESSAGES.pending(id));
        assert.equal(higgsfield.generated().length, 1, 'nothing new was sent');
        assert.match((await call(gateway, 'studio_usage', {})).text, /Şu an bir üretim sürüyor/);
        assert.equal((await call(gateway, 'get_generation', { generation_id: id })).text, MESSAGES.notReady);
        higgsfield.jobStatus = 'completed';
        const done = await call(gateway, 'get_generation', { generation_id: id });
        assert.match(done.text, /Üretim tamamlandı/);
        assert.equal(store.get(id).status, 'completed');
        assert.equal((await image(gateway)).isError, false);
        assert.equal(higgsfield.generated().length, 2);
    });

    it('the next generation (or the background check) notices a pending job has finished', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1, limits: { cooldownSec: 0 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'submitted');
        higgsfield.jobStatus = 'failed';
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'failed');
        clock.now += 1000;
        higgsfield.jobStatus = 'in_progress';
        assert.match((await image(gateway)).text, /hâlâ hazırlanıyor/);
        const second = store.recent().at(-1).id;
        higgsfield.jobStatus = 'completed';
        clock.now += 1000;
        assert.equal((await image(gateway)).isError, false, 'the pending check inside generate settles it first');
        assert.equal(store.get(second).status, 'completed');
        assert.equal(higgsfield.generated().length, 3);
    });

    it('a job pending past the stale limit is marked unknown, still counted, and stops blocking', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1, pendingStaleMin: 15, limits: { cooldownSec: 0, dailyImages: 2 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 14 * 60_000;
        assert.equal((await image(gateway)).text, MESSAGES.pending(id));
        clock.now += 61_000;
        const next = await image(gateway);
        assert.equal(next.isError, false, next.text);
        assert.equal(store.get(id).status, 'unknown');
        assert.match(store.get(id).reason, /pending over 15 min/);
        assert.equal(higgsfield.generated().length, 2);
        assert.equal(store.usage(dayOf(clock.now, 'Europe/Istanbul'), '2026-11').counts.image, 2, 'the stale job still counts');
        clock.now += 16 * 60_000;
        assert.equal((await image(gateway)).text, MESSAGES.dailyImages);
    });

    it('a submitting row left by a crash blocks until the stale limit', async () => {
        const { gateway, store, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        store.insert({ id: 'gen_crashed', day: dayOf(clock.now, 'Europe/Istanbul'), month: '2026-11', tool: 'generate_image', kind: 'image', model: 'gpt_image_2_6', estimated: 3, status: 'submitting', requestedBy: 'yasir' });
        assert.equal((await image(gateway)).text, MESSAGES.pending('gen_crashed'));
        clock.now += 15 * 60_000;
        assert.equal((await image(gateway)).isError, false);
        assert.equal(store.get('gen_crashed').status, 'unknown');
    });

    it('starts a new day at midnight in Istanbul, not UTC', async () => {
        // 20:59 UTC = 23:59 Istanbul (UTC+3).
        const { gateway, clock, higgsfield } = setup({ start: Date.parse('2026-11-20T20:59:00Z'), studio: { limits: { cooldownSec: 0, dailyImages: 1 } } });
        await image(gateway);
        assert.equal(dayOf(clock.now, 'Europe/Istanbul'), '2026-11-20');
        clock.now = Date.parse('2026-11-20T20:59:50Z');
        assert.equal((await image(gateway)).text, MESSAGES.dailyImages);
        clock.now = Date.parse('2026-11-20T21:00:30Z'); // 00:00:30 on the 21st in Istanbul, still the 20th in UTC
        assert.equal(dayOf(clock.now, 'Europe/Istanbul'), '2026-11-21');
        assert.equal((await image(gateway)).isError, false);
        assert.equal(higgsfield.generated().length, 2);
    });

    it('never resends a generation whose answer was lost, and counts it', async () => {
        const higgsfield = fakeHiggsfield();
        higgsfield.generateError = new Error('socket hang up');
        const { gateway, store, clock } = setup({ higgsfield, studio: { limits: { cooldownSec: 0, dailyImages: 1 } } });
        assert.equal((await image(gateway)).text, MESSAGES.lostAnswer);
        assert.equal(higgsfield.generated().length, 1);
        assert.equal(store.recent().at(-1).status, 'unknown');
        clock.now += 1000;
        assert.equal((await image(gateway)).text, MESSAGES.dailyImages, 'the lost one counts');
    });

    it('reports a failed job once, without retrying', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'nsfw' });
        const { gateway } = setup({ higgsfield });
        const result = await image(gateway);
        assert.match(result.text, /güvenlik\/telif/);
        assert.equal(higgsfield.generated().length, 1);
    });

    it('studio_usage tells what is left', async () => {
        const { gateway } = setup();
        await image(gateway);
        const usage = await call(gateway, 'studio_usage', {});
        assert.match(usage.text, /2\.75\/40 kredi; 1\/15 görsel/);
        assert.match(usage.text, /\d+ sn beklemek gerekiyor/);
    });
});

describe('studio gateway: results, WhatsApp preview and TryPost', () => {
    it('keeps the original bytes, gives WhatsApp a preview copy and TryPost the same bytes (sha256 round trip)', async () => {
        const { gateway, settings, trypost, store } = setup();
        const result = await image(gateway);
        assert.equal(result.isError, false, result.text);
        const id = result.text.match(/generation_id: (gen_\w+)/)[1];
        const row = store.get(id);
        const original = readFileSync(row.file);
        const sha = createHash('sha256').update(PNG).digest('hex');
        assert.equal(row.sha256, sha);
        assert.ok(original.equals(PNG), 'stored exactly as downloaded');
        assert.equal(row.mime, 'image/png');
        assert.equal(row.width, 2048);
        assert.equal(row.height, 2560);
        const media = result.text.match(/^MEDIA:(.+)$/m)[1];
        assert.equal(media, join(settings.hermesPreviewDir, `${id}-preview.png`));
        assert.ok(readFileSync(media).equals(PNG));

        const attached = await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1' });
        assert.equal(attached.isError, false, attached.text);
        assert.equal(trypost.uploads.length, 1);
        assert.equal(createHash('sha256').update(trypost.uploads[0].bytes).digest('hex'), sha, 'TryPost got the original bytes');
        assert.equal(trypost.uploads[0].mimeType, 'image/png');
        assert.deepEqual(trypost.requests.map((item) => `${item.method} ${item.path}`), ['GET /posts/post-1', 'POST /posts/post-1/media/from-upload']);
        assert.deepEqual(trypost.requests[1].body, { upload_token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
        assert.equal(store.attachments(id)[0].sha256, sha);
    });

    it('creates a new draft when no post is given, and asks for the account first', async () => {
        const { gateway, trypost } = setup();
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        assert.equal((await call(gateway, 'attach_to_trypost', { generation_id: id })).text, MESSAGES.needAccount);
        assert.equal(trypost.uploads.length, 0);
        const result = await call(gateway, 'attach_to_trypost', { generation_id: id, social_account_id: 'acc-1', content: 'Taslak' });
        assert.match(result.text, /yeni taslak oluşturuldu \(post_id: new-post-9\)/);
        assert.deepEqual(trypost.requests.at(-1).body, { status: 'draft', social_account_id: 'acc-1', content: 'Taslak', media: [{ upload_token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] });
    });

    it('stays inside the Marmara workspace: a post the project token cannot read is refused before any upload', async () => {
        const { gateway, trypost } = setup();
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        const result = await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'someone-elses-post' });
        assert.equal(result.text, MESSAGES.postScope);
        assert.equal(trypost.uploads.length, 0);
        assert.equal((await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: '../../api-keys' })).text, MESSAGES.postScope);
        assert.equal(trypost.requests.length, 1, 'no path outside /posts/{id} is ever requested');
    });

    it('refuses to attach audio to a post', async () => {
        const higgsfield = fakeHiggsfield({ resultUrl: 'https://cdn.higgsfield.test/out/a.mp3' });
        const { gateway, trypost } = setup({ higgsfield, fetchImpl: downloadFetch(MP3, 'audio/mpeg') });
        const result = await call(gateway, 'generate_audio', { kind: 'music', prompt: 'calm', duration: 20 });
        assert.match(result.text, /^MEDIA:.+\.mp3$/m);
        const id = result.text.match(/generation_id: (gen_\w+)/)[1];
        const attached = await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1' });
        assert.equal(attached.isError, true);
        assert.equal(attached.text, MESSAGES.audioAttach);
        assert.equal(trypost.uploads.length, 0);
    });

    it('refuses to upload a stored file that changed (sha256 check)', async () => {
        const { gateway, store, trypost } = setup();
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        writeFileSync(store.get(id).file, Buffer.from('tampered'));
        assert.equal((await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1' })).text, MESSAGES.integrity);
        assert.equal(trypost.uploads.length, 0);
    });

    it('offers the original as a WhatsApp document', async () => {
        const { gateway } = setup();
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        const result = await call(gateway, 'get_original_file', { generation_id: id });
        assert.match(result.text, /^MEDIA:.+-original\.png$/m);
        assert.match(result.text, /^\[\[as_document\]\]$/m);
    });

    it('uses the club logo as a reference through media_import_url', async () => {
        const { gateway, higgsfield } = setup();
        await image(gateway, { reference_image: 'logo' });
        assert.deepEqual(higgsfield.calls[0], { name: 'media_import_url', args: { url: 'https://sosyal.marmaraai.com/marmara/logo.svg', type: 'image' } });
        assert.deepEqual(higgsfield.generated()[0].args.params.medias, [{ value: '99999999-2222-4333-8444-555555555555', role: 'image_references' }]);
    });

    it('refuses references outside the allowed places', async () => {
        const { gateway, higgsfield, dataDir } = setup();
        mkdirSync(join(dataDir, 'secret'), { recursive: true });
        writeFileSync(join(dataDir, 'secret', 'a.png'), PNG);
        assert.match((await image(gateway, { reference_image: join(dataDir, 'secret', 'a.png') })).text, /referans olarak kullanılamaz/);
        assert.match((await image(gateway, { reference_image: 'https://evil.test/a.png' })).text, /referans olarak kullanılamaz/);
        assert.equal(higgsfield.calls.length, 0);
    });

    it('get_brand_kit returns the editable file', async () => {
        const { gateway, settings } = setup();
        writeFileSync(settings.brandKitFile, '# Marka kiti\nÖğren · Paylaş · Üret');
        const result = await call(gateway, 'get_brand_kit', {});
        assert.match(result.text, /Öğren · Paylaş · Üret/);
        assert.match(result.text, /story: 9:16/);
    });
});

describe('studio MCP server', () => {
    async function start() {
        const { gateway } = setup();
        const server = createStudioServer({ gateway, token: TOKEN });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/mcp`;
        const rpc = (body, token = TOKEN) =>
            fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        return { server, rpc };
    }

    it('requires the bearer secret', async () => {
        const { server, rpc } = await start();
        try {
            assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status, 401);
            assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong-secret-xxxxxxxx')).status, 401);
            assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
            assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
            assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
            assert.throws(() => createStudioServer({ gateway: { tools: [] }, token: '' }), /ECHO_STUDIO_TOKEN/);
        } finally {
            server.close();
        }
    });

    it('speaks MCP: initialize, tools/list with annotations, unknown tools are errors', async () => {
        const { server, rpc } = await start();
        try {
            const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } } })).json();
            assert.equal(init.result.protocolVersion, '2025-06-18');
            assert.ok(init.result.capabilities.tools);
            assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
            const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
            const byName = Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool]));
            assert.equal(byName.get_brand_kit.annotations.readOnlyHint, true);
            assert.equal(byName.generate_image.annotations.readOnlyHint, false);
            assert.ok(!('generate_video' in byName));
            const unknown = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_video', arguments: {} } })).json();
            assert.equal(unknown.error.code, -32602);
            const usage = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'studio_usage', arguments: {} } })).json();
            assert.equal(usage.result.isError, false);
            assert.match(usage.result.content[0].text, /Bugün/);
        } finally {
            server.close();
        }
    });
});

describe('Higgsfield auth and client', () => {
    it('refreshes an expiring token with the refresh token and stores it 0600, never logging it', async () => {
        const dir = tempDir();
        const file = createTokenFile(join(dir, 'auth.json'));
        file.write({ client: { client_id: 'client-1', redirect_uri: 'http://127.0.0.1:8976/callback' }, tokens: { access_token: 'old', refresh_token: 'refresh-1', expires_at: 1000 } });
        const posts = [];
        const logs = [];
        const fetchImpl = async (url, init) => {
            posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
            return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'refresh-2', expires_in: 3600 }), { status: 200 });
        };
        const auth = createHiggsfieldAuth({ file, fetchImpl, now: () => 5000, log: (...parts) => logs.push(parts.join(' ')) });
        assert.equal(await auth.token(), 'new-access');
        assert.equal(posts[0].url, 'https://higgsfield.ai/_clerk/oauth/token');
        assert.equal(posts[0].body.grant_type, 'refresh_token');
        assert.equal(posts[0].body.refresh_token, 'refresh-1');
        assert.equal(posts[0].body.client_id, 'client-1');
        const saved = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
        assert.equal(saved.tokens.refresh_token, 'refresh-2');
        assert.equal(saved.tokens.expires_at, 5000 + 3600_000);
        assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
        assert.ok(!logs.join(' ').includes('new-access') && !logs.join(' ').includes('refresh-'));
        assert.equal(await auth.token(), 'new-access', 'a fresh token is reused');
        assert.equal(posts.length, 1);
    });

    it('a revoked refresh token means "not connected" with a Turkish reason', async () => {
        const file = createTokenFile(join(tempDir(), 'auth.json'));
        file.write({ client: { client_id: 'c' }, tokens: { access_token: 'a', refresh_token: 'r', expires_at: 1 } });
        const auth = createHiggsfieldAuth({ file, now: () => 10_000, fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) });
        await assert.rejects(auth.token(), (error) => error.notConnected && /Higgsfield bağlantısı kurulmamış/.test(error.userMessage));
        assert.equal(file.read().tokens.refresh_token, null);
    });

    it('HIGGSFIELD_API_KEY is used as the bearer as is', async () => {
        const auth = createHiggsfieldAuth({ file: createTokenFile(join(tempDir(), 'a.json')), apiKey: 'key-1' });
        assert.equal(await auth.token(), 'key-1');
    });

    it('the client opens a session, reads SSE answers and refreshes once on 401', async () => {
        const seen = [];
        let token = 'expired';
        const server = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            seen.push({ method: body.method, auth: request.headers.authorization, session: request.headers['mcp-session-id'] ?? null });
            if (request.headers.authorization !== 'Bearer fresh') {
                response.writeHead(401);
                return response.end();
            }
            if (body.method === 'initialize') {
                response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
                return response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
            }
            if (!body.id) {
                response.writeHead(202);
                return response.end();
            }
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Cost preflight for x: 2.75 credits (2.75 exact).' }] } })}\n\n`);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            let refreshed = 0;
            const client = createHiggsfieldClient({
                url: `http://127.0.0.1:${server.address().port}/mcp`,
                auth: { token: async () => token, refresh: async () => (refreshed++, (token = 'fresh')) },
            });
            const answer = await client.call('estimate_image_cost', { params: { model: 'gpt_image_2_6' } });
            assert.equal(parseCredits(answer), 2.75);
            assert.equal(refreshed, 1);
            assert.deepEqual(seen.map((item) => item.method), ['initialize', 'initialize', 'notifications/initialized', 'tools/call']);
            assert.equal(seen.at(-1).session, 'sess-1');
        } finally {
            server.close();
        }
    });

    it('parses Higgsfield answers', () => {
        const wait = `jobs[1]{index,job_id,status,type,model,result_url}:\n  0,${JOB},completed,audio,m,"https://cdn.test/a.mp3"\nsummary:\n  total: 1\nall_terminal: true`;
        assert.deepEqual(parseJob({ text: wait }, JOB), { status: 'completed', url: 'https://cdn.test/a.mp3', error: null, terminal: true });
        assert.equal(parseCompact(wait).values.all_terminal, 'true');
        assert.deepEqual(parseJobIds({ text: `Submitted. job_id=${JOB}` }), [JOB]);
        assert.deepEqual(parseJobIds({ text: '', structured: { jobs: [{ job_id: JOB }] } }), [JOB]);
        assert.equal(parseCredits({ text: 'Cost preflight for elevenlabs_v4: 0.23 credits (0.23 exact). No job submitted.' }), 0.23);
        assert.deepEqual(parsePasted('http://127.0.0.1:8976/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz', error: null });
    });
});
