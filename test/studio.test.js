import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { normalizeStudio } from '../src/studio/config.js';
import { CLUB_NAME, MESSAGES, buildEditPrompt, buildImagePrompt, createStudioGateway, dayOf, nearestAspect, posterText } from '../src/studio/gateway.js';
import { LOGO_CORNERS, createLogoCompositor, logoBox, variantFor } from '../src/studio/compose.js';
import { answerExcerpt, createHiggsfieldClient, parseCompact, parseCredits, parseJob, parseJobIds, rawAnswer, redactForLog } from '../src/studio/higgsfield.js';
import { DatabaseSync } from 'node:sqlite';
import { rawAnswerOf, recoverGeneration } from '../src/studio/recover.js';
import { createHiggsfieldAuth, createTokenFile, parsePasted } from '../src/studio/oauth.js';
import { bearerMatches, createStudioServer } from '../src/studio/server.js';
import { createStudioStore, openStudioDatabase } from '../src/studio/store.js';
import { createStudioNotifier } from '../src/studio/notify.js';
import { OUTSIDE_WINDOW, WhatsAppError } from '../src/whatsapp.js';

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
const LOGO_MEDIA = '77777777-2222-4333-8444-555555555555';
const CACHED_LOGO = '66666666-2222-4333-8444-555555555555';

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
        generateAnswer: null,
        waitGate: null,
        async call(name, args) {
            calls.push({ name, args });
            if (name === 'estimate_image_cost' || name === 'estimate_audio_cost') {
                return { text: `Cost preflight for ${args.params.model}: ${fake.estimate} credits (${fake.estimate} exact). No job submitted.`, structured: null, isError: false };
            }
            if (name === 'generate_image' || name === 'generate_audio') {
                if (fake.generateError) throw fake.generateError;
                if (fake.generateAnswer) return fake.generateAnswer;
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
            if (name === 'media_upload') return { text: '', structured: { upload_url: `https://cdn.higgsfield.test/upload/${args.filename}`, media_id: LOGO_MEDIA }, isError: false };
            if (name === 'media_confirm') return { text: `media_id: ${args.media_id}`, structured: null, isError: false };
            throw new Error(`unexpected call ${name}`);
        },
        generated: () => calls.filter((call) => call.name.startsWith('generate_')),
    };
    return fake;
}

/** Fetch for result downloads and presigned uploads (PUTs are recorded in `puts`). */
const puts = [];
const downloadFetch = (bytes = PNG, type = 'image/png') => async (url, init = {}) => {
    assert.ok(String(url).startsWith('https://cdn.higgsfield.test/'));
    if (init.method === 'PUT') {
        puts.push({ url, bytes: Buffer.from(init.body) });
        return new Response(null, { status: 200 });
    }
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

/**
 * `logoCached` (default): the logo media ids are already in studio.db, as after the first poster, so
 * most tests see no logo upload. `compositor`: add_logo's (createLogoCompositor with a fake runner).
 */
function setup({ studio = {}, start = Date.parse('2026-11-20T09:00:00Z'), higgsfield = fakeHiggsfield(), fetchImpl = downloadFetch(), trypost = fakeTryPost(), notify = null, logoCached = true, compositor = null } = {}) {
    const dataDir = tempDir();
    const config = echoConfig(dataDir);
    const settings = normalizeStudio({ waitSliceSec: 1, ...studio }, config, { STUDIO_PREVIEW_DIR: join(dataDir, 'hermes-preview'), STUDIO_BRAND_KIT: join(dataDir, 'brand-kit.md') });
    const clock = { now: start };
    const store = createStudioStore(openStudioDatabase(':memory:'), () => clock.now);
    if (logoCached) {
        for (const variant of ['logo', 'logo-dark']) {
            store.setAsset(`logo:${variant}`, CACHED_LOGO, createHash('sha256').update(readFileSync(join(settings.logoDir, `${variant}.png`))).digest('hex'));
        }
    }
    const gateway = createStudioGateway({ settings, store, higgsfield, trypost, fetchImpl, sleep: async (ms) => (clock.now += ms), notify, compositor });
    return { gateway, store, settings, higgsfield, trypost, clock, dataDir };
}

const call = (gateway, name, args) => gateway.callTool(name, args);
const image = (gateway, args = {}) => call(gateway, 'generate_image', { prompt: 'A clean modern poster for an AI workshop', ...args });

describe('studio gateway: tools and allowlist', () => {
    it('lists only the studio tools, read-only ones marked readOnlyHint', () => {
        const { gateway } = setup();
        const names = gateway.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, ['add_logo', 'attach_to_trypost', 'edit_image', 'generate_audio', 'generate_image', 'get_brand_kit', 'get_generation', 'get_original_file', 'studio_usage']);
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
        assert.equal(params.resolution, '1k', 'images are 1k unless 2k is asked for');
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

    it('a job past the stale limit gets one last look: completed meanwhile, it is stored as completed', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1, pendingStaleMin: 15, limits: { cooldownSec: 0 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        higgsfield.jobStatus = 'completed';
        clock.now += 16 * 60_000;
        await gateway.checkPending();
        const row = store.get(id);
        assert.equal(row.status, 'completed');
        assert.ok(row.file && row.sha256);
        assert.match((await call(gateway, 'get_generation', { generation_id: id })).text, /Üretim tamamlandı/);
    });

    it('a job still running past the stale limit becomes late: no block, still counted, keeps its job id', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1, pendingStaleMin: 15, limits: { cooldownSec: 0, dailyImages: 2 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 14 * 60_000;
        assert.equal((await image(gateway)).text, MESSAGES.pending(id));
        clock.now += 61_000;
        const next = await image(gateway);
        assert.equal(next.isError, false, next.text);
        const row = store.get(id);
        assert.equal(row.status, 'late');
        assert.equal(row.job_id, JOB);
        assert.equal(higgsfield.generated().length, 2);
        assert.equal(store.usage(dayOf(clock.now, 'Europe/Istanbul'), '2026-11').counts.image, 2, 'the late job still counts');
        clock.now += 16 * 60_000;
        assert.match((await call(gateway, 'studio_usage', {})).text, /Geç kalan üretim var/);
        assert.equal((await image(gateway)).text, MESSAGES.dailyImages, 'late rows count against the daily limit');
    });

    it('a late row counts against the credit limits', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress', estimate: 8 });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1, limits: { cooldownSec: 0, dailyCredits: 12, perPersonDailyCredits: 100 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 16 * 60_000;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'late');
        assert.equal(store.usage(dayOf(clock.now, 'Europe/Istanbul'), '2026-11').dayCredits, 8);
        assert.match((await image(gateway)).text, /Bugünkü kredi sınırı bu istek için yetmiyor \(kalan yaklaşık 4 kredi\)/);
    });

    it('a late job completes later through the background check, and get_generation returns it', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock, trypost } = setup({ higgsfield, studio: { jobTimeoutSec: 1, limits: { cooldownSec: 0 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 16 * 60_000;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'late');
        assert.equal((await call(gateway, 'get_generation', { generation_id: id })).text, MESSAGES.late(id));
        clock.now += 3 * 3_600_000;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'late');
        higgsfield.jobStatus = 'completed';
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'completed');
        assert.match((await call(gateway, 'get_generation', { generation_id: id })).text, /Üretim tamamlandı/);
        assert.match((await call(gateway, 'get_original_file', { generation_id: id })).text, /MEDIA:/);
        assert.equal((await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1' })).isError, false);
        assert.deepEqual(trypost.uploads[0].bytes, PNG);
    });

    it('get_generation itself polls a late job and stores it when done', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1 } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 16 * 60_000;
        assert.equal((await call(gateway, 'get_generation', { generation_id: id })).text, MESSAGES.late(id), 'stale + still running: late');
        higgsfield.jobStatus = 'completed';
        assert.match((await call(gateway, 'get_generation', { generation_id: id })).text, /Üretim tamamlandı/);
        assert.equal(store.get(id).status, 'completed');
    });

    it('a late job is given up as unknown after lateMaxHours', async () => {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const { gateway, store, clock } = setup({ higgsfield, studio: { jobTimeoutSec: 1 } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 16 * 60_000;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'late');
        clock.now += 24 * 3_600_000;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'unknown');
        assert.match(store.get(id).reason, /late over 24 h/);
    });

    it('a submitting row left by a crash blocks until the stale limit', async () => {
        const { gateway, store, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        store.insert({ id: 'gen_crashed', day: dayOf(clock.now, 'Europe/Istanbul'), month: '2026-11', tool: 'generate_image', kind: 'image', model: 'gpt_image_2_6', estimated: 3, status: 'submitting', requestedBy: 'yasir' });
        assert.equal((await image(gateway)).text, MESSAGES.pending('gen_crashed'));
        clock.now += 15 * 60_000;
        assert.equal((await image(gateway)).isError, false);
        assert.equal(store.get('gen_crashed').status, 'unknown', 'no job id: straight to unknown');
        assert.match(store.get('gen_crashed').reason, /without a job id/);
        assert.equal(store.usage(dayOf(clock.now, 'Europe/Istanbul'), '2026-11').counts.image, 2, 'and still counted');
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

    it('uploads the club logo PNG once (media_upload), caches its media id and reuses it; never a raw URL in medias', async () => {
        const { gateway, higgsfield, clock, settings, store } = setup({ logoCached: false, studio: { limits: { cooldownSec: 0 } } });
        puts.length = 0;
        await image(gateway, { reference_image: 'logo', logo_zemin: 'koyu' });
        assert.deepEqual(higgsfield.calls[0], { name: 'media_upload', args: { filename: 'logo.png', content_type: 'image/png' } });
        assert.ok(puts[0].bytes.equals(readFileSync(join(settings.logoDir, 'logo.png'))), 'the real PNG bytes are uploaded');
        assert.equal(higgsfield.calls.filter((item) => item.name === 'media_upload').length, 2, 'logo.png (reference) and logo-dark.png (the poster logo)');
        assert.deepEqual(higgsfield.generated()[0].args.params.medias, [{ value: LOGO_MEDIA, role: 'image_references' }, { value: LOGO_MEDIA, role: 'image_references' }]);
        assert.equal(store.getAsset('logo:logo-dark').media_id, LOGO_MEDIA);
        clock.now += 1000;
        await image(gateway);
        assert.equal(higgsfield.calls.filter((item) => item.name === 'media_upload').length, 2, 'cached: no second upload');
        for (const media of higgsfield.generated().flatMap((item) => item.args.params.medias ?? [])) assert.ok(!/^https?:/.test(media.value));
        assert.ok(!higgsfield.calls.some((item) => item.name === 'media_import_url'));
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

// The text of a live generate_image answer (Nov 2026), verbatim.
const LIVE_JOB = '8517fd80-1a96-419f-95a6-9312eb81e152';
const LIVE_GENERATE_TEXT = `Submitted 1 job. If a widget is visible, it polls automatically — do not call job_status or show_generations as a follow-up poll. In text-only clients, use job_status with sync:true to poll for completion.
- 8517fd80-1a96-419f-95a6-9312eb81e152  "simple flat blue gradient square, minimal"If the user requests a combined display ... show_generation_by_ids with jobs: [{"index":0,"job_id":"<first actual job ID>"},...] ...`;

describe('parseJobIds shapes', () => {
    const A = 'aaaaaaaa-1111-4111-8111-111111111111';
    const B = 'bbbbbbbb-2222-4222-8222-222222222222';
    const C = 'cccccccc-3333-4333-8333-333333333333';

    it('the live answer: "Submitted N job" + "- <uuid>" bullets, the placeholder ignored', () => {
        assert.deepEqual(parseJobIds({ text: LIVE_GENERATE_TEXT }), [LIVE_JOB]);
        assert.deepEqual(parseJobIds({ text: LIVE_GENERATE_TEXT, content: [{ type: 'text', text: LIVE_GENERATE_TEXT }] }), [LIVE_JOB]);
    });

    it('several bullets keep their order', () => {
        assert.deepEqual(parseJobIds({ text: `Submitted 2 jobs.\n- ${B}  "one"\n- ${A}  "two"\n- ${B} again` }), [B, A]);
    });

    it('job_id / jobId / generation_id anywhere in structuredContent', () => {
        assert.deepEqual(parseJobIds({ structured: { data: { deep: [{ jobId: A }] } } }), [A]);
        assert.deepEqual(parseJobIds({ structured: { generation_id: B } }), [B]);
        assert.deepEqual(parseJobIds({ structured: { jobs: [{ job_id: JOB }] } }), [JOB]);
    });

    it('job_ids / jobIds lists, in order, deduped', () => {
        assert.deepEqual(parseJobIds({ structured: { job_ids: [A, B, A] } }), [A, B]);
        assert.deepEqual(parseJobIds({ structured: { result: { jobIds: [C, 'not-a-uuid'] } } }), [C]);
    });

    it('bare id only under jobs/generations/results/job_set/items or next to status', () => {
        assert.deepEqual(parseJobIds({ structured: { jobs: [{ id: A }, { id: B }] } }), [A, B]);
        assert.deepEqual(parseJobIds({ structured: { generations: [{ id: A }] } }), [A]);
        assert.deepEqual(parseJobIds({ structured: { results: [{ id: B }] } }), [B]);
        assert.deepEqual(parseJobIds({ structured: { job_set: { id: C } } }), [C]);
        assert.deepEqual(parseJobIds({ structured: { items: [{ id: A, type: 'image' }] } }), [A]);
        assert.deepEqual(parseJobIds({ structured: { thing: { id: B, status: 'queued' } } }), [B]);
        assert.deepEqual(parseJobIds({ structured: { user: { id: A }, workspace: { id: B } } }), [], 'unrelated ids are not jobs');
    });

    it('walks _meta (widget state), resources and JSON inside strings', () => {
        assert.deepEqual(parseJobIds({ meta: { 'openai/widgetState': { ui: { generations: [{ id: A, status: 'queued' }] } } } }), [A]);
        assert.deepEqual(parseJobIds({ meta: { widget: { state: JSON.stringify({ job_set_id: C, jobs: [{ id: B }] }) } } }), [B]);
        assert.deepEqual(parseJobIds({ content: [{ type: 'resource', resource: { uri: 'ui://x', text: JSON.stringify({ job_id: C }) } }] }), [C]);
    });

    it('JSON text blocks', () => {
        assert.deepEqual(parseJobIds({ text: JSON.stringify({ jobs: [{ id: A, status: 'queued' }] }) }), [A]);
        const content = [
            { type: 'text', text: 'Started.' },
            { type: 'text', text: JSON.stringify({ job_ids: [B] }) },
        ];
        assert.deepEqual(parseJobIds({ text: content.map((part) => part.text).join('\n'), content }), [B]);
    });

    it('order across sources: structuredContent, then _meta, then text; deduped', () => {
        assert.deepEqual(parseJobIds({ structured: { job_id: A }, meta: { jobs: [{ id: B }, { id: A }] }, text: JSON.stringify({ job_id: C }) }), [A, B, C]);
    });

    it('compact tables with id or job_id in the header', () => {
        assert.deepEqual(parseJobIds({ text: `items[2]{id,type,status}:\n  ${A},image,queued\n  ${B},image,queued` }), [A, B]);
        assert.deepEqual(parseJobIds({ text: `jobs[1]{index,job_id,status}:\n  0,${C},queued` }), [C]);
        assert.deepEqual(parseJobIds({ text: `media[1]{name,size}:\n  x.png,10` }), []);
    });

    it('"job_id: …" lines and "job id … <uuid>" text', () => {
        assert.deepEqual(parseJobIds({ text: `status: queued\njob_id: ${A}` }), [A]);
        assert.deepEqual(parseJobIds({ text: `Submitted. job_id=${JOB}` }), [JOB]);
    });

    it('last resort: exactly one UUID in the text, never two', () => {
        assert.deepEqual(parseJobIds({ text: `Your image is on its way (${A}).` }), [A]);
        assert.deepEqual(parseJobIds({ text: `Ref ${A} and ${A.toUpperCase()}` }), [A], 'the same UUID twice is one');
        assert.deepEqual(parseJobIds({ text: `Media ${A}, workspace ${B}` }), []);
        assert.deepEqual(parseJobIds({ text: 'Cost preflight for x: 2.75 credits (2.75 exact). No job submitted.' }), []);
    });
});

describe('studio: unmatched answers, raw copy and recovery', () => {
    const odd = { text: 'Your generation is being prepared in the widget.', structured: { widget: { job_set_id: 'set-1' } }, meta: { 'openai/outputTemplate': 'ui://higgsfield/generation', auth: 'Bearer abc.def', url: 'https://cdn.test/x.png?X-Amz-Signature=deadbeef&token=zzz' }, content: [], isError: false };

    it('the live answer is submitted and polled with jobs_wait {index, job_id}', async () => {
        const higgsfield = fakeHiggsfield();
        higgsfield.generateAnswer = { text: LIVE_GENERATE_TEXT, structured: null, meta: null, content: [{ type: 'text', text: LIVE_GENERATE_TEXT }], isError: false };
        const { gateway, store } = setup({ higgsfield });
        await image(gateway);
        const row = store.recent().at(-1);
        assert.equal(row.job_id, LIVE_JOB);
        const wait = higgsfield.calls.find((item) => item.name === 'jobs_wait');
        assert.deepEqual(wait.args.jobs, [{ index: 0, job_id: LIVE_JOB }]);
        assert.ok(wait.args.timeout_seconds <= 15);
        assert.ok(!higgsfield.calls.some((item) => item.name === 'job_status'));
    });

    it('no job id: stores a raw copy, logs one redacted warn line, get_generation explains in Turkish', async () => {
        const higgsfield = fakeHiggsfield();
        higgsfield.generateAnswer = odd;
        const logs = [];
        const dataDir = tempDir();
        const config = echoConfig(dataDir);
        const settings = normalizeStudio({ waitSliceSec: 1 }, config, { STUDIO_PREVIEW_DIR: join(dataDir, 'p'), STUDIO_BRAND_KIT: join(dataDir, 'b.md') });
        const store = createStudioStore(openStudioDatabase(':memory:'), () => Date.parse('2026-11-20T09:00:00Z'));
        const gateway = createStudioGateway({ settings, store, higgsfield, fetchImpl: downloadFetch(), log: (...parts) => logs.push(parts.join(' ')) });
        assert.equal((await image(gateway)).text, MESSAGES.lostAnswer);
        const row = store.recent().at(-1);
        assert.equal(row.status, 'unknown');
        assert.equal(row.job_id, null);
        assert.match(row.raw_answer, /--- content text ---\nYour generation/);
        assert.match(row.raw_answer, /--- structuredContent ---\n\{"widget"/);
        assert.match(row.raw_answer, /X-Amz-Signature=deadbeef/, 'the DB keeps the signed URL');
        const warns = logs.filter((line) => line.startsWith('warn'));
        assert.equal(warns.length, 1);
        assert.match(warns[0], /no job id/);
        assert.match(warns[0], /Your generation is being prepared/);
        assert.ok(!/deadbeef|zzz|abc\.def/.test(warns[0]), warns[0]);
        const answer = await call(gateway, 'get_generation', { generation_id: row.id });
        assert.equal(answer.text, MESSAGES.unmatched(row.id));
        assert.match(answer.text, /eşleştirilemedi/);
        assert.match(answer.text, /yönetici/);
    });

    it('raw copies stay under ~8 KB and keep every section', () => {
        const raw = rawAnswer({ text: 'x'.repeat(20_000), structured: { a: 'y'.repeat(20_000) }, meta: { m: 1 } });
        assert.ok(raw.length <= 8 * 1024 + 32, String(raw.length));
        assert.match(raw, /--- structuredContent ---/);
        assert.match(raw, /--- _meta ---\n\{"m":1\}/);
    });

    it('log redaction drops tokens and URL query strings', () => {
        const line = redactForLog('get https://cdn.test/a.png?X-Amz-Signature=s1&e=2 Authorization: Bearer abc123 {"access_token":"tok-1"} eyJhbGciOi.eyJzdWIi.sig k=AbCdEf0123456789AbCdEf0123456789AbCdEf0123');
        assert.ok(!/s1|abc123|tok-1|eyJ|AbCdEf0123456789/.test(line), line);
        assert.match(line, /https:\/\/cdn\.test\/a\.png\?\[query removed\]/);
        assert.ok(answerExcerpt({ text: 'z'.repeat(1000) }).length < 320);
    });

    it('recover attaches the job id; the normal poll stores the result; raw prints the copy', async () => {
        const higgsfield = fakeHiggsfield();
        higgsfield.generateAnswer = odd;
        const { gateway, store, clock } = setup({ higgsfield, studio: { limits: { cooldownSec: 0 } } });
        await image(gateway);
        const id = store.recent().at(-1).id;
        clock.now += 30 * 3_600_000; // long after lateMaxHours: the clock restarts at the recovery
        assert.equal(rawAnswerOf(store, id).ok, true);
        assert.match(rawAnswerOf(store, id).message, /no job id in answer[\s\S]*--- content text ---/);
        assert.equal(recoverGeneration(store, id, 'nope').ok, false);
        assert.equal(recoverGeneration(store, 'gen_missing', JOB).ok, false);
        const result = recoverGeneration(store, id, JOB);
        assert.equal(result.ok, true, result.message);
        assert.equal(store.get(id).status, 'submitted');
        assert.equal(store.get(id).job_id, JOB);
        assert.match(store.get(id).reason, /recovered by admin \(was unknown: no job id in answer\)/);
        assert.equal(recoverGeneration(store, id, JOB).ok, false, 'only unknown/late rows');
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'completed');
        assert.ok(higgsfield.calls.some((item) => item.name === 'jobs_wait' && item.args.jobs[0].job_id === JOB));
        assert.match((await call(gateway, 'get_generation', { generation_id: id })).text, /Üretim tamamlandı/);
        assert.equal(higgsfield.generated().length, 1, 'nothing is sent again');
    });

    it('recover refuses a job id another row already has', async () => {
        const { gateway, store, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        await image(gateway);
        store.insert({ id: 'gen_lost', day: dayOf(clock.now, 'Europe/Istanbul'), month: '2026-11', tool: 'generate_image', kind: 'image', estimated: 3, status: 'unknown', requestedBy: 'yasir' });
        assert.match(recoverGeneration(store, 'gen_lost', JOB).message, /zaten/);
    });

    it('an existing studio.db gets the new columns in place', () => {
        const dir = tempDir();
        const old = new DatabaseSync(join(dir, 'studio.db'));
        old.exec("CREATE TABLE generations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, params TEXT, estimated_credits REAL, actual_credits REAL, job_id TEXT, status TEXT NOT NULL, reason TEXT, requested_by TEXT, file TEXT, mime TEXT, bytes INTEGER, sha256 TEXT, width INTEGER, height INTEGER, source_url TEXT); INSERT INTO generations (id, created_at, updated_at, day, month, tool, kind, status, reason) VALUES ('gen_old', 1, 1, '2026-11-20', '2026-11', 'generate_image', 'image', 'unknown', 'no job id in answer');");
        old.close();
        const store = createStudioStore(openStudioDatabase(dir));
        assert.equal(store.get('gen_old').raw_answer, null);
        assert.equal(store.get('gen_old').recovered_at, null);
        assert.equal(recoverGeneration(store, 'gen_old', JOB).ok, true);
        createStudioStore(openStudioDatabase(dir)); // opening again is a no-op
    });
});

/**
 * A fake ImageMagick: answers the brightness query with `brightness`, and for the composite writes the
 * input bytes plus a marker to the png: output (same PNG header, so same size; a different sha256).
 */
function fakeMagick(brightness = 0.2) {
    const calls = [];
    const run = async (args) => {
        assert.ok(Array.isArray(args) && args.every((arg) => typeof arg === 'string'), 'argument arrays only');
        calls.push(args);
        if (args.at(-1) === 'info:') return `${brightness}\n`;
        const output = args.at(-1).replace(/^png:/, '');
        writeFileSync(output, Buffer.concat([readFileSync(args[0]), Buffer.from('LOGO')]));
        return '';
    };
    return { run, calls };
}

describe('studio: posters (headline by the model, real logo as reference)', () => {
    it('buildImagePrompt appends the exact Turkish headline, subline, club name, typography and the logo corner', () => {
        const prompt = buildImagePrompt({ prompt: 'Calm navy poster with soft gradient shapes.', baslik: '8 Mart Dünya Kadınlar Günü', altMetin: 'İstanbul’da çağ, ışık, öğün, şüphe', logoCorner: 'alt-sag' });
        assert.ok(prompt.startsWith('Calm navy poster with soft gradient shapes.\n\n'));
        assert.match(prompt, /^Headline text, exactly: "8 Mart Dünya Kadınlar Günü"$/m);
        assert.match(prompt, /^Subline text \(smaller, below the headline\), exactly: "İstanbul’da çağ, ışık, öğün, şüphe"$/m);
        assert.match(prompt, new RegExp(`^Small text, exactly: "${CLUB_NAME}"$`, 'm'));
        assert.match(prompt, /ç ğ ı İ ö ş ü/);
        assert.match(prompt, /sans-serif/);
        assert.match(prompt, /bottom-right corner/);
        assert.match(prompt, /last reference image is the official Marmara Yapay Zeka Kulübü logo/);
        const plain = buildImagePrompt({ prompt: 'Abstract shapes.' });
        assert.equal(plain, 'Abstract shapes.', 'no headline, no logo: the prompt as given');
        assert.doesNotMatch(buildImagePrompt({ prompt: 'x', baslik: 'Başlık' }), /logo/i);
    });

    it('posterText: NFC Turkish letters, no control characters or double quotes', () => {
        const decomposed = 'Güzel İşçi Öğün'.normalize('NFD'); // spelled with combining marks
        assert.notEqual(decomposed, 'Güzel İşçi Öğün');
        assert.equal(posterText(decomposed), 'Güzel İşçi Öğün');
        assert.equal(posterText('  "Yapay‮ Zeka"\n Atölyesi '), "'Yapay Zeka' Atölyesi");
    });

    it('generate_image: headline and logo by default (logo PNG reference last), recorded for the result', async () => {
        const { gateway, higgsfield, store } = setup();
        const result = await image(gateway, { platform: 'instagram', baslik: '8 Mart Dünya Kadınlar Günü', alt_metin: 'Kadınların bilime katkısı', reference_image: 'gen_none' });
        assert.match(result.text, /Referans olarak verilen üretimi bulamadım/);
        const ok = await image(gateway, { platform: 'instagram', baslik: '8 Mart Dünya Kadınlar Günü', alt_metin: 'Kadınların bilime katkısı' });
        assert.equal(ok.isError, false, ok.text);
        const params = higgsfield.generated()[0].args.params;
        assert.match(params.prompt, /^A clean modern poster for an AI workshop\n\n/);
        assert.match(params.prompt, /Headline text, exactly: "8 Mart Dünya Kadınlar Günü"/);
        assert.match(params.prompt, /Subline text .*"Kadınların bilime katkısı"/);
        assert.deepEqual(params.medias, [{ value: CACHED_LOGO, role: 'image_references' }]);
        assert.equal(params.baslik, undefined, 'only allowlisted fields reach Higgsfield');
        const id = ok.text.match(/generation_id: (gen_\w+)/)[1];
        assert.equal(store.get(id).logo_corner, 'alt-sag');
        assert.deepEqual(JSON.parse(store.get(id).params).poster, { baslik: '8 Mart Dünya Kadınlar Günü', alt_metin: 'Kadınların bilime katkısı' });
        assert.match(ok.text, /Görseldeki yazıyı kontrol et: başlık “8 Mart Dünya Kadınlar Günü”/);
        assert.match(ok.text, /bir kez yeniden üretmeyi/);
        assert.match(ok.text, /add_logo/);
    });

    it('logo:false sends no logo; logo_konum and logo_zemin pick the corner and the file; Recraft gets none', async () => {
        const { gateway, higgsfield, store, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        store.setAsset('logo:logo', 'acik-logo-media', store.getAsset('logo:logo').sha256);
        await image(gateway, { logo: false, baslik: 'Atölye' });
        assert.equal(higgsfield.generated()[0].args.params.medias, undefined);
        assert.doesNotMatch(higgsfield.generated()[0].args.params.prompt, /reference image/);
        clock.now += 1000;
        await image(gateway, { logo_konum: 'ust-sol', logo_zemin: 'acik' });
        assert.deepEqual(higgsfield.generated()[1].args.params.medias, [{ value: 'acik-logo-media', role: 'image_references' }]);
        assert.match(higgsfield.generated()[1].args.params.prompt, /top-left corner/);
        clock.now += 1000;
        assert.match((await image(gateway, { logo_konum: 'orta' })).text, /logo_konum/);
        await image(gateway, { model: 'recraft_v4_1' });
        assert.equal(higgsfield.generated()[2].args.params.medias, undefined);
        assert.match((await image(gateway, { model: 'recraft_v4_1', logo: true })).text, /add_logo/);
    });

    it('refuses an over-long headline or a subline without a headline, without calling Higgsfield', async () => {
        const { gateway, higgsfield } = setup();
        assert.match((await image(gateway, { baslik: 'x'.repeat(121) })).text, /Başlık çok uzun/);
        assert.match((await image(gateway, { alt_metin: 'Sadece alt' })).text, /baslik da ver/);
        assert.equal(higgsfield.calls.length, 0);
    });
});

describe('studio: logo compositing (add_logo)', () => {
    it('logoBox: about 12% of the width, a 5% margin, in each corner', () => {
        const box = (corner) => logoBox({ width: 1000, height: 1250, corner, logoWidth: 1024, logoHeight: 415 });
        assert.deepEqual(box('alt-sag'), { x: 830, y: 1151, width: 120, height: 49 });
        assert.deepEqual(box('alt-sol'), { x: 50, y: 1151, width: 120, height: 49 });
        assert.deepEqual(box('ust-sag'), { x: 830, y: 50, width: 120, height: 49 });
        assert.deepEqual(box('ust-sol'), { x: 50, y: 50, width: 120, height: 49 });
        assert.deepEqual(LOGO_CORNERS, ['alt-sag', 'alt-sol', 'ust-sag', 'ust-sol']);
        assert.throws(() => box('orta'));
    });

    it('chooses the light logo on a dark corner and the navy one on a light corner, from the measured region', async () => {
        assert.equal(variantFor(0.1), 'logo-dark');
        assert.equal(variantFor(0.8), 'logo');
        const dir = tempDir();
        const input = join(dir, 'in.png');
        writeFileSync(input, PNG);
        for (const [brightness, variant] of [[0.15, 'logo-dark'], [0.85, 'logo']]) {
            const magick = fakeMagick(brightness);
            const made = await createLogoCompositor({ run: magick.run }).apply({ input, output: join(dir, `out-${variant}.png`), width: 2048, height: 2560, corner: 'alt-sag' });
            assert.equal(made.variant, variant);
            const [measure, compose] = magick.calls;
            assert.deepEqual(measure, [input, '-crop', '246x100+1700+2358', '+repage', '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']);
            assert.ok(compose[2].endsWith(`${variant}.png`));
            assert.deepEqual(compose.slice(3, 9), ['-resize', '246x100!', ')', '-geometry', '+1700+2358', '-composite']);
            assert.ok(readFileSync(input).equals(PNG), 'the original is never written');
            assert.equal(made.sha256, createHash('sha256').update(readFileSync(made.file)).digest('hex'));
        }
    });

    it('add_logo: no Higgsfield call, a new final PNG; preview, original file and TryPost use it; logosuz gives the original', async () => {
        const magick = fakeMagick(0.2);
        const { gateway, higgsfield, store, trypost, settings } = setup({ compositor: createLogoCompositor({ run: magick.run }) });
        const id = (await image(gateway, { baslik: 'Atölye' })).text.match(/generation_id: (gen_\w+)/)[1];
        const before = higgsfield.calls.length;
        const result = await call(gateway, 'add_logo', { generation_id: id, konum: 'ust-sag' });
        assert.equal(result.isError, false, result.text);
        assert.equal(higgsfield.calls.length, before, 'no Higgsfield call, no credits');
        assert.match(result.text, /sağ üst köşe/);
        const row = store.get(id);
        assert.ok(readFileSync(row.file).equals(PNG), 'original untouched');
        assert.equal(row.sha256, createHash('sha256').update(PNG).digest('hex'));
        const final = readFileSync(row.final_file);
        assert.notEqual(row.final_sha256, row.sha256);
        assert.equal(row.final_sha256, createHash('sha256').update(final).digest('hex'));
        assert.equal(row.logo_corner, 'ust-sag');
        assert.equal(row.final_variant, 'logo-dark');
        assert.equal(result.text.match(/^MEDIA:(.+)$/m)[1], join(settings.hermesPreviewDir, `${id}-final-preview.png`));

        const shown = await call(gateway, 'get_generation', { generation_id: id });
        assert.ok(readFileSync(shown.text.match(/^MEDIA:(.+)$/m)[1]).equals(final), 'the preview is the final');
        const doc = await call(gateway, 'get_original_file', { generation_id: id });
        assert.ok(readFileSync(doc.text.match(/^MEDIA:(.+)$/m)[1]).equals(final));
        const plain = await call(gateway, 'get_original_file', { generation_id: id, logosuz: true });
        assert.ok(readFileSync(plain.text.match(/^MEDIA:(.+)$/m)[1]).equals(PNG));

        const attached = await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1' });
        assert.equal(attached.isError, false, attached.text);
        assert.ok(trypost.uploads[0].bytes.equals(final), 'TryPost gets the final byte for byte');
        assert.equal(trypost.uploads[0].mimeType, 'image/png');
        assert.equal(store.attachments(id)[0].sha256, row.final_sha256);
        await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1', logosuz: true });
        assert.ok(trypost.uploads[1].bytes.equals(PNG));

        writeFileSync(row.final_file, 'tampered');
        assert.equal((await call(gateway, 'attach_to_trypost', { generation_id: id, post_id: 'post-1' })).text, MESSAGES.integrity);
    });

    it('add_logo is composited from the original every time (another corner never stacks logos)', async () => {
        const magick = fakeMagick(0.9);
        const { gateway, store } = setup({ compositor: createLogoCompositor({ run: magick.run }) });
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        await call(gateway, 'add_logo', { generation_id: id });
        await call(gateway, 'add_logo', { generation_id: id, konum: 'alt-sol' });
        const composites = magick.calls.filter((args) => args.at(-1) !== 'info:');
        assert.equal(composites.length, 2);
        for (const args of composites) assert.equal(args[0], store.get(id).file);
        assert.equal(store.get(id).logo_corner, 'alt-sol');
        assert.equal(store.get(id).final_variant, 'logo');
    });

    it('add_logo refuses without a compositor, for audio, and for an unknown generation', async () => {
        const { gateway } = setup();
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        assert.equal((await call(gateway, 'add_logo', { generation_id: id })).text, MESSAGES.noCompositor);
        assert.equal((await call(gateway, 'add_logo', { generation_id: 'gen_missing' })).text, MESSAGES.notFound);
        const tools = Object.fromEntries(gateway.tools.map((tool) => [tool.name, tool]));
        assert.equal(tools.add_logo.annotations.readOnlyHint, false, 'a write tool: it asks for approval');
        assert.equal(tools.edit_image.annotations.readOnlyHint, false);
    });

    it('a failed composite leaves the generation as it was', async () => {
        const { gateway, store } = setup({ compositor: createLogoCompositor({ run: async () => { throw new Error('magick: no decode delegate'); } }) });
        const id = (await image(gateway)).text.match(/generation_id: (gen_\w+)/)[1];
        assert.equal((await call(gateway, 'add_logo', { generation_id: id })).text, MESSAGES.logoFailed);
        assert.equal(store.get(id).final_file, null);
    });
});

describe('studio: edit_image (gpt_image_2_6 image-to-image)', () => {
    it('edits an earlier generation: its job id and the logo as references, same aspect ratio, 1k, Higgsfield generate_image', async () => {
        const { gateway, higgsfield, store, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        const id = (await image(gateway, { platform: 'instagram', baslik: 'Atölye' })).text.match(/generation_id: (gen_\w+)/)[1];
        clock.now += 1000;
        const result = await call(gateway, 'edit_image', { generation_id: id, talimat: 'Başlığı "Yapay Zeka Atölyesi" yap', ozet: 'Afiş düzeltmesi', requested_by: 'yasir' });
        assert.equal(result.isError, false, result.text);
        const [, edit] = higgsfield.generated();
        assert.equal(edit.name, 'generate_image');
        assert.equal(edit.args.params.model, 'gpt_image_2_6');
        assert.equal(edit.args.params.aspect_ratio, '4:5');
        assert.equal(edit.args.params.resolution, '1k');
        assert.equal(edit.args.params.count, 1);
        assert.deepEqual(edit.args.params.medias, [{ value: JOB, role: 'image_references' }, { value: CACHED_LOGO, role: 'image_references' }]);
        assert.match(edit.args.params.prompt, /^Edit the first reference image\. Change only this: Başlığı "Yapay Zeka Atölyesi" yap/);
        assert.match(edit.args.params.prompt, /ç ğ ı İ ö ş ü/);
        const editId = result.text.match(/generation_id: (gen_\w+)/)[1];
        assert.equal(store.get(editId).tool, 'edit_image');
        assert.equal(store.get(editId).logo_corner, 'alt-sag');
        assert.equal(JSON.parse(store.get(editId).params).edit.source, id);
        assert.equal(store.usage(dayOf(store.now(), 'Europe/Istanbul'), '2026-11').counts.image, 2, 'counted like any image');
    });

    it('edits a picture the user sent (uploaded as a reference), within the reference folders only', async () => {
        const { gateway, higgsfield, dataDir } = setup({ studio: { referenceDirs: [] } });
        const shared = join(dataDir, 'images');
        mkdirSync(shared);
        const { gateway: g2, higgsfield: h2 } = setup({ studio: { referenceDirs: [shared] } });
        writeFileSync(join(shared, 'sent.png'), PNG);
        const result = await call(g2, 'edit_image', { kaynak_gorsel: join(shared, 'sent.png'), talimat: 'add the club logo bottom right', logo: true });
        assert.equal(result.isError, false, result.text);
        assert.equal(h2.calls[0].name, 'media_upload');
        const params = h2.generated()[0].args.params;
        assert.equal(params.aspect_ratio, '4:5', '2048x2560 → 4:5');
        assert.deepEqual(params.medias, [{ value: LOGO_MEDIA, role: 'image_references' }, { value: CACHED_LOGO, role: 'image_references' }]);
        assert.match((await call(gateway, 'edit_image', { kaynak_gorsel: join(shared, 'sent.png'), talimat: 'x' })).text, /referans olarak kullanılamaz/);
        assert.equal(higgsfield.calls.length, 0);
    });

    it('needs exactly one source and an instruction; refused attempts send nothing', async () => {
        const { gateway, higgsfield } = setup();
        assert.equal((await call(gateway, 'edit_image', { talimat: 'x' })).text, MESSAGES.editSource);
        assert.equal((await call(gateway, 'edit_image', { generation_id: 'gen_x', kaynak_gorsel: '/a.png', talimat: 'x' })).text, MESSAGES.editSource);
        assert.equal((await call(gateway, 'edit_image', { generation_id: 'gen_missing', talimat: 'x' })).text, MESSAGES.editSource);
        assert.match((await call(gateway, 'edit_image', { generation_id: 'gen_x', talimat: '  ' })).text, /talimatı boş/);
        assert.equal(higgsfield.calls.length, 0);
    });

    it('the approval hint for edit_image uses the source aspect ratio and the GPT Image price', async () => {
        const { gateway } = setup();
        const id = (await image(gateway, { platform: 'story' })).text.match(/generation_id: (gen_\w+)/)[1];
        const hint = gateway.approvalHint('edit_image', { generation_id: id, talimat: 'x' });
        assert.equal(hint.aspect_ratio, '9:16');
        assert.equal(hint.resolution, '1k');
        assert.ok(Number.isFinite(hint.credits));
    });

    it('buildEditPrompt and nearestAspect', () => {
        assert.doesNotMatch(buildEditPrompt({ talimat: 'make it blue' }), /logo/);
        assert.match(buildEditPrompt({ talimat: 'fix the logo', logoCorner: 'alt-sol' }), /bottom-left corner/);
        assert.equal(nearestAspect(1080, 1350, ['1:1', '4:5', '9:16']), '4:5');
        assert.equal(nearestAspect(1920, 1080, ['1:1', '16:9', '4:5']), '16:9');
    });
});

describe('studio: image resolution (1k unless asked)', () => {
    it('every model generates at 1k by default', async () => {
        const { gateway, higgsfield, clock } = setup({ studio: { limits: { cooldownSec: 0, maxCreditsPerRequest: 20 } } });
        for (const model of ['gpt_image_2_6', 'nano_banana_2_1', 'recraft_v4_1']) {
            const result = await image(gateway, { model });
            assert.equal(result.isError, false, result.text);
            clock.now += 1000;
            assert.equal(higgsfield.generated().at(-1).args.params.resolution, '1k', model);
        }
        assert.equal(higgsfield.generated()[0].args.params.quality, 'high');
    });

    it('2k only when asked (yuksek_cozunurluk or resolution "2k"); 4k only by name and only on nano_banana_2_1', async () => {
        const { gateway, higgsfield, clock } = setup({ studio: { limits: { cooldownSec: 0 } } });
        await image(gateway, { yuksek_cozunurluk: true });
        clock.now += 1000;
        assert.equal(higgsfield.generated().at(-1).args.params.resolution, '2k');
        await image(gateway, { resolution: '2k', model: 'recraft_v4_1' });
        clock.now += 1000;
        assert.equal(higgsfield.generated().at(-1).args.params.resolution, '2k');
        await image(gateway, { model: 'nano_banana_2_1', yuksek_cozunurluk: true });
        clock.now += 1000;
        assert.equal(higgsfield.generated().at(-1).args.params.resolution, '2k', 'yuksek_cozunurluk never means 4k');
        await image(gateway, { model: 'nano_banana_2_1', resolution: '4k' });
        clock.now += 1000;
        assert.equal(higgsfield.generated().at(-1).args.params.resolution, '4k');
        assert.match((await image(gateway, { resolution: '4k' })).text, /gpt_image_2_6 için çözünürlük 1k \/ 2k olabilir/);
        assert.equal(higgsfield.generated().length, 4);
    });

    it('generate_image, generate_audio and attach_to_trypost accept an ozet; it is kept as the summary', async () => {
        const { gateway, store } = setup();
        for (const name of ['generate_image', 'generate_audio', 'attach_to_trypost']) {
            const tool = gateway.tools.find((item) => item.name === name);
            assert.equal(tool.inputSchema.properties.ozet.type, 'string', name);
        }
        assert.equal((await image(gateway, { ozet: '  8 Mart\nafişi ' })).isError, false);
        assert.equal(store.recent().at(-1).summary, '8 Mart afişi');
    });
});

describe('studio: approval card hint', () => {
    it('static per-model table: gpt 1k 1.5 / 2k 2.75, nano 1k 1.5 / 2k 2, recraft 8; platform ratio', () => {
        const { gateway } = setup();
        assert.deepEqual(gateway.approvalHint('generate_image', { platform: 'instagram' }), { aspect_ratio: '4:5', resolution: '1k', credits: 1.5 });
        assert.equal(gateway.approvalHint('generate_image', { yuksek_cozunurluk: true }).credits, 2.75);
        assert.equal(gateway.approvalHint('generate_image', { model: 'nano_banana_2_1' }).credits, 1.5);
        assert.equal(gateway.approvalHint('generate_image', { model: 'nano_banana_2_1', resolution: '2k' }).credits, 2);
        assert.equal(gateway.approvalHint('generate_image', { model: 'recraft_v4_1', resolution: '2k' }).credits, 8);
        assert.equal(gateway.approvalHint('generate_image', { aspect_ratio: '16:9' }).aspect_ratio, '16:9');
        assert.deepEqual(gateway.approvalHint('generate_audio', { kind: 'speech' }), { credits: 1 });
        assert.deepEqual(gateway.approvalHint('generate_audio', { kind: 'music', duration: 30 }), { duration: 30, credits: 4.5 });
        assert.deepEqual(gateway.approvalHint('attach_to_trypost', {}), {});
    });

    it('config.json studio.approxCredits overrides the table; a real earlier estimate of the same model and resolution wins', async () => {
        const higgsfield = fakeHiggsfield({ estimate: 1.75 });
        const { gateway } = setup({ higgsfield, studio: { approxCredits: { image: { gpt_image_2_6: { '1k': 1.25 } } } } });
        assert.equal(gateway.approvalHint('generate_image', {}).credits, 1.25);
        await image(gateway);
        assert.equal(gateway.approvalHint('generate_image', {}).credits, 1.75);
        assert.equal(gateway.approvalHint('generate_image', { resolution: '2k' }).credits, 2.75, 'other resolution: still the table');
    });

    it('POST /approval-hint needs the bearer and records nothing', async () => {
        const { gateway, store } = setup();
        const server = createStudioServer({ gateway, token: TOKEN });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/approval-hint`;
        const post = (body, token = TOKEN) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
        try {
            assert.equal((await post('{}', null)).status, 401);
            const answer = await post(JSON.stringify({ tool: 'generate_image', arguments: { platform: 'x' } }));
            assert.equal(answer.status, 200);
            assert.deepEqual(await answer.json(), { aspect_ratio: '16:9', resolution: '1k', credits: 1.5 });
            assert.equal((await post('not json')).status, 400);
            assert.equal(store.recent().length, 0);
        } finally {
            server.close();
        }
    });
});

describe('studio: "ready" message for a generation that finished late', () => {
    const sender = ({ fail = null } = {}) => {
        const sent = [];
        const notify = async (message) => {
            sent.push(message);
            if (fail) throw fail;
            return { ok: true };
        };
        return { sent, notify };
    };
    async function startedLate(options = {}, args = { requested_by: 'yasir', ozet: '8 Mart afişi' }) {
        const higgsfield = fakeHiggsfield({ jobStatus: 'in_progress' });
        const env = setup({ higgsfield, studio: { jobTimeoutSec: 1, limits: { cooldownSec: 0 } }, ...options });
        assert.match((await image(env.gateway, args)).text, /hâlâ hazırlanıyor/);
        const id = env.store.recent().at(-1).id;
        assert.equal(env.store.get(id).notify_state, 'waiting');
        return { ...env, id };
    }

    it('the background check sends the preview to the requester once', async () => {
        const { sent, notify } = sender();
        const { gateway, store, higgsfield, id } = await startedLate({ notify });
        await gateway.checkPending();
        assert.equal(sent.length, 0, 'still running: nothing yet');
        higgsfield.jobStatus = 'completed';
        await gateway.checkPending();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].requestedBy, 'yasir');
        assert.equal(sent[0].text, '🎨 8 Mart afişi hazır.\nGönderiye eklemek ya da değiştirmek için bana yazman yeterli.');
        assert.equal(sent[0].mime, 'image/png');
        assert.deepEqual(readFileSync(sent[0].file), PNG);
        assert.equal(store.get(id).notify_state, 'sent');
        await gateway.checkPending();
        assert.equal(sent.length, 1, 'never twice');
    });

    it('a failed late generation is reported in one short line', async () => {
        const { sent, notify } = sender();
        const { gateway, higgsfield } = await startedLate({ notify });
        higgsfield.jobStatus = 'failed';
        await gateway.checkPending();
        assert.equal(sent.length, 1);
        assert.match(sent[0].text, /^❌ 8 Mart afişi üretilemedi\./);
        assert.equal(sent[0].file, undefined);
    });

    it('no message when get_generation already gave the result to Hermes', async () => {
        const { sent, notify } = sender();
        const { gateway, store, higgsfield, id } = await startedLate({ notify });
        higgsfield.jobStatus = 'completed';
        assert.match((await call(gateway, 'get_generation', { generation_id: id })).text, /Üretim tamamlandı/);
        await gateway.checkPending();
        assert.equal(sent.length, 0);
        assert.equal(store.get(id).notify_state, 'shown');
    });

    it('an unknown requester ("bilinmiyor") gets nothing; it is left for get_generation', async () => {
        const { sent, notify } = sender();
        const { gateway, store, higgsfield, id } = await startedLate({ notify }, { requested_by: 'someone' });
        higgsfield.jobStatus = 'completed';
        await gateway.checkPending();
        assert.equal(sent.length, 0);
        assert.equal(store.get(id).notify_state, 'skipped');
        assert.match((await call(gateway, 'get_generation', { generation_id: id })).text, /Üretim tamamlandı/);
    });

    it('a send that fails is logged and never retried', async () => {
        const { sent, notify } = sender({ fail: new Error('network down') });
        const { gateway, store, higgsfield, id } = await startedLate({ notify });
        higgsfield.jobStatus = 'completed';
        await gateway.checkPending();
        await gateway.checkPending();
        assert.equal(sent.length, 1);
        assert.equal(store.get(id).notify_state, 'failed');
    });

    it('a late job that finishes after ~23 h is not pushed (outside the WhatsApp window)', async () => {
        const { sent, notify } = sender();
        const { gateway, store, higgsfield, clock, id } = await startedLate({ notify });
        clock.now += 16 * 60_000;
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'late');
        clock.now += 23 * 3_600_000;
        higgsfield.jobStatus = 'completed';
        await gateway.checkPending();
        assert.equal(store.get(id).status, 'completed');
        assert.equal(sent.length, 0);
        assert.equal(store.get(id).notify_state, 'skipped');
    });

    it('a result returned by the generate call itself is never pushed', async () => {
        const { sent, notify } = sender();
        const { gateway, store } = setup({ notify });
        assert.match((await image(gateway, { requested_by: 'yasir' })).text, /Üretim tamamlandı/);
        await gateway.checkPending();
        assert.equal(sent.length, 0);
        assert.equal(store.recent().at(-1).notify_state, null);
    });
});

describe('studio notifier (WhatsApp)', () => {
    const people = echoConfig(tempDir()).people;
    const fakeWhatsApp = ({ fail = null } = {}) => {
        const calls = [];
        return {
            calls,
            async uploadMedia({ bytes, mimeType, filename }) {
                calls.push({ upload: { size: bytes.length, mimeType, filename } });
                return 'media-1';
            },
            async send(payload) {
                calls.push({ send: payload });
                if (fail) throw fail;
                return 'wamid.1';
            },
        };
    };

    it('uploads the image and sends it with the text as caption, only to the known person', async () => {
        const dir = tempDir();
        const file = join(dir, 'gen_1.png');
        writeFileSync(file, PNG);
        const whatsapp = fakeWhatsApp();
        const notify = createStudioNotifier({ whatsapp, people, allowedPeople: ['yasir'] });
        assert.deepEqual(await notify({ requestedBy: 'yasir', text: '🎨 8 Mart afişi hazır.', file, mime: 'image/png' }), { ok: true });
        assert.deepEqual(whatsapp.calls[0].upload, { size: PNG.length, mimeType: 'image/png', filename: 'gen_1.png' });
        assert.deepEqual(whatsapp.calls[1].send, { to: '905550000001', type: 'image', image: { id: 'media-1', caption: '🎨 8 Mart afişi hazır.' } });
        assert.equal((await notify({ requestedBy: 'ayse', text: 'x' })).ok, false, 'not allowed to use the assistant');
        assert.equal((await notify({ requestedBy: 'nobody', text: 'x' })).ok, false);
        assert.equal(whatsapp.calls.length, 2);
    });

    it('text only for a file WhatsApp cannot show (webp); audio goes after the text', async () => {
        const dir = tempDir();
        const webp = join(dir, 'a.webp');
        writeFileSync(webp, Buffer.alloc(100));
        const mp3 = join(dir, 'a.mp3');
        writeFileSync(mp3, MP3);
        const whatsapp = fakeWhatsApp();
        const notify = createStudioNotifier({ whatsapp, people });
        await notify({ requestedBy: 'ayse', text: 'Görsel hazır.', file: webp, mime: 'image/webp' });
        assert.deepEqual(whatsapp.calls[0].send, { to: '905550000002', type: 'text', text: { body: 'Görsel hazır.', preview_url: false } });
        await notify({ requestedBy: 'ayse', text: '🎵 Müzik hazır.', file: mp3, mime: 'audio/mpeg' });
        assert.equal(whatsapp.calls[2].send.type, 'text');
        assert.deepEqual(whatsapp.calls[3].send, { to: '905550000002', type: 'audio', audio: { id: 'media-1' } });
    });

    it('outside the 24-hour window: { ok: false } with the reason, no throw', async () => {
        const logs = [];
        const whatsapp = fakeWhatsApp({ fail: new WhatsAppError('Re-engagement message', { code: OUTSIDE_WINDOW }) });
        const notify = createStudioNotifier({ whatsapp, people, log: (...parts) => logs.push(parts.join(' ')) });
        assert.deepEqual(await notify({ requestedBy: 'yasir', text: 'x' }), { ok: false, reason: 'outside the 24-hour window' });
        assert.match(logs[0], /not retried/);
    });
});
