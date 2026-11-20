import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVideoTools, normalizeVideo, openVideoDatabase, withVideo } from '../src/studio/video.js';

/**
 * The studio's video tools (src/studio/video.js) with a fake render service: tool schemas, input
 * checks before anything is sent, the daily and one-at-a-time limits, late renders pushed to
 * WhatsApp, TryPost attach of a video, and the Turkish approval card line (render.py).
 */

const dirs = [];
const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-video-'));
    dirs.push(dir);
    return dir;
};
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MP4 = (size = 5000) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(size, 1)]);
const tick = () => new Promise((done) => setTimeout(done, 5));

function setup({ fetchImpl, videoConfig = {}, people = [{ id: 'yasir', phone: '905551112233' }], trypost = null, now = () => Date.now() } = {}) {
    const root = tempDir();
    const logoDir = join(root, 'brand');
    mkdirSync(logoDir);
    writeFileSync(join(logoDir, 'logo.png'), PNG);
    writeFileSync(join(logoDir, 'logo-dark.png'), PNG);
    const images = join(root, 'images');
    mkdirSync(images);
    writeFileSync(join(images, 'sent.jpg'), PNG);
    writeFileSync(join(root, 'secret.png'), PNG);
    writeFileSync(join(root, 'gen-image.png'), PNG);
    writeFileSync(join(root, 'gen-speech.mp3'), Buffer.from('ID3speech'));
    const rows = {
        gen_img1: { id: 'gen_img1', kind: 'image', status: 'completed', file: join(root, 'gen-image.png'), mime: 'image/png' },
        gen_voice1: { id: 'gen_voice1', kind: 'speech', status: 'completed', file: join(root, 'gen-speech.mp3'), mime: 'audio/mpeg' },
        gen_pending: { id: 'gen_pending', kind: 'image', status: 'submitted' },
    };
    const settings = {
        timeZone: 'Europe/Istanbul',
        referenceDirs: [images],
        originalsDir: join(root, 'media'),
        previewDir: join(root, 'preview'),
        hermesPreviewDir: '/opt/data/cache/generated/echo-studio',
        project: trypost ? 'marmara' : null,
        logoDir,
        dataDir: root,
    };
    const video = { ...normalizeVideo({ waitSec: 0.2, ...videoConfig }, { ECHO_RENDER_TOKEN: 'render-token-0123456789abcdef' }) };
    const sent = [];
    const whatsapp = {
        uploadMedia: async ({ mimeType }) => {
            sent.push({ upload: mimeType });
            return 'wa-media-1';
        },
        send: async (payload) => {
            sent.push(payload);
            return 'wamid.1';
        },
    };
    const tools = createVideoTools({ settings, video, db: openVideoDatabase(':memory:'), store: { get: (id) => rows[id] ?? null }, trypost, whatsapp, people, fetchImpl, now });
    const gateway = withVideo(
        {
            tools: [{ name: 'generate_image' }, { name: 'attach_to_trypost' }],
            callTool: async (name, args) => ({ text: `gateway:${name}:${args.generation_id ?? ''}`, isError: false }),
            approvalHint: () => ({ from: 'gateway' }),
            checkPending: async () => {},
        },
        tools,
    );
    return { gateway, tools, sent, root, images, settings };
}

/** A fake render service: records requests; answers with `answer(path, body)` or an MP4. */
function fakeRender(answer = null) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        const path = new URL(url).pathname;
        const body = options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : options.body;
        calls.push({ path, body, auth: options.headers.Authorization });
        if (answer) return answer(path, body);
        return new Response(MP4(), { status: 200, headers: { 'Content-Type': 'video/mp4', 'X-Render-Info': JSON.stringify({ frames: 375, ms: 40000, seconds: 15, captions: 0 }) } });
    };
    return { calls, fetchImpl };
}

const template = (extra = {}) => ({ sablon: 'etkinlik', parametreler: { baslik: 'Hackathon 2026', tarih: '12 Mart', gorsel: 'gen_img1' }, platform: 'reels', sure: 15, ozet: 'Hackathon duyurusu', requested_by: 'yasir', ...extra });

describe('video tools: schemas', () => {
    it('adds create_video (write), get_video and transcribe_audio (read-only) next to the gateway tools', () => {
        const { gateway } = setup({ fetchImpl: fakeRender().fetchImpl });
        const names = gateway.tools.map((tool) => tool.name);
        assert.deepEqual(names, ['generate_image', 'attach_to_trypost', 'create_video', 'get_video', 'transcribe_audio']);
        const create = gateway.tools.find((tool) => tool.name === 'create_video');
        assert.equal(create.annotations.readOnlyHint, false);
        assert.deepEqual(create.inputSchema.required, ['sure', 'ozet']);
        assert.equal(create.inputSchema.additionalProperties, false);
        assert.deepEqual(create.inputSchema.properties.sablon.enum, ['etkinlik', 'ozel_gun', 'alinti', 'slayt']);
        assert.ok(create.inputSchema.properties.platform.enum.includes('reels'));
        assert.equal(create.inputSchema.properties.sure.maximum, 60);
        assert.match(create.description, /kredisi HARCAMAZ/);
        for (const name of ['get_video', 'transcribe_audio']) assert.equal(gateway.tools.find((tool) => tool.name === name).annotations.readOnlyHint, true);
    });

    it('answers the approval hint for create_video with no credits', () => {
        const { gateway } = setup({ fetchImpl: fakeRender().fetchImpl });
        assert.deepEqual(gateway.approvalHint('create_video', { platform: 'kare', sure: 12 }), { aspect_ratio: '1:1', duration: 12, credits: 0 });
        assert.deepEqual(gateway.approvalHint('generate_image', {}), { from: 'gateway' });
    });
});

describe('video tools: create_video', () => {
    it('sends a checked job with the files under neutral ids and stores the MP4 like an image', async () => {
        const render = fakeRender();
        const { gateway, root, settings } = setup({ fetchImpl: render.fetchImpl });
        const answer = await gateway.callTool('create_video', template({ seslendirme: 'gen_voice1', muzik: 'gen_voice1' }));
        assert.equal(answer.isError, false, answer.text);
        assert.match(answer.text, /Video hazır\. video_id: vid_/);
        assert.match(answer.text, /MEDIA:\/opt\/data\/cache\/generated\/echo-studio\/vid_[a-z0-9]+-preview\.mp4/);
        assert.equal(render.calls.length, 1);
        const { body, auth } = render.calls[0];
        assert.equal(auth, 'Bearer render-token-0123456789abcdef');
        assert.deepEqual(body.job.size, { width: 1080, height: 1920, fps: 25 });
        assert.equal(body.job.params.gorsel, 'a0');
        assert.deepEqual(body.job.audio, { music: 'a1', voiceover: 'a1', subtitles: true });
        assert.deepEqual(Object.keys(body.assets).sort(), ['a0', 'a1', 'logo', 'logo-dark']);
        assert.equal(body.assets.a0.mime, 'image/png');
        // No file path of the studio reaches the render service.
        assert.doesNotMatch(JSON.stringify(body.job), new RegExp(root.replace(/[/\\]/g, '.')));
        const id = answer.text.match(/vid_[a-z0-9]+/)[0];
        assert.ok(existsSync(join(settings.originalsDir, `${id}.mp4`)));
        assert.ok(existsSync(join(settings.previewDir, `${id}-preview.mp4`)));
    });

    it('accepts a free composition and sends it without the computed start times', async () => {
        const render = fakeRender();
        const { gateway } = setup({ fetchImpl: render.fetchImpl });
        const answer = await gateway.callTool('create_video', {
            kompozisyon: { background: { color: '#0f1c47' }, scenes: [{ duration: 2, elements: [{ type: 'text', text: 'Merhaba' }] }, { duration: 2, background: { image: '/dev/null' } }] },
            sure: 8,
            ozet: 'Deneme',
        });
        assert.equal(answer.isError, true);
        assert.match(answer.text, /kullanılamaz|bulamadım/);
        assert.equal(render.calls.length, 0);
        const ok = await gateway.callTool('create_video', { kompozisyon: { scenes: [{ duration: 1, elements: [{ type: 'text', text: 'Merhaba' }] }, { duration: 3, elements: [{ type: 'logo' }] }] }, sure: 8, platform: 'x', ozet: 'Deneme' });
        assert.equal(ok.isError, false, ok.text);
        const job = render.calls[0].body.job;
        assert.deepEqual(job.composition.scenes.map((scene) => scene.duration), [2, 6]);
        assert.ok(job.composition.scenes.every((scene) => scene.start === undefined));
        assert.deepEqual(job.size, { width: 1920, height: 1080, fps: 25 });
    });

    it('refuses before rendering: URLs, scripts, wrong assets, paths outside the shared folder, bad lengths', async () => {
        const render = fakeRender();
        const { gateway, root, images } = setup({ fetchImpl: render.fetchImpl });
        const cases = [
            [template({ parametreler: { baslik: 'Kayıt https://evil.example' } }), /adres ya da kod/],
            [template({ parametreler: { baslik: 'x', gorsel: 'https://evil.example/a.png' } }), /internet adresi verilemez/],
            [{ kompozisyon: { scenes: [{ duration: 1, elements: [{ type: 'text', text: '<script>fetch("/x")</script>' }] }] }, sure: 5, ozet: 'x' }, /adres ya da kod/],
            [template({ parametreler: { baslik: 'x', gorsel: join(root, 'secret.png') } }), /kullanılamaz/],
            [template({ parametreler: { baslik: 'x', gorsel: join(images, '..', 'secret.png') } }), /kullanılamaz/],
            [template({ parametreler: { baslik: 'x', gorsel: 'gen_voice1' } }), /bir ses; burada görsel gerekiyor/],
            [template({ parametreler: { baslik: 'x', gorsel: 'gen_pending' } }), /tamamlanmış bir üretim bulamadım/],
            [template({ muzik: 'gen_img1' }), /bir görsel; burada ses gerekiyor/],
            [template({ sure: 90 }), /3-60 saniye/],
            [template({ platform: 'myspace' }), /platform/],
            [{ sablon: 'etkinlik', kompozisyon: { scenes: [] }, sure: 10, ozet: 'x' }, /ikisi birden değil/],
        ];
        for (const [args, pattern] of cases) {
            const answer = await gateway.callTool('create_video', args);
            assert.equal(answer.isError, true, JSON.stringify(args));
            assert.match(answer.text, pattern);
        }
        assert.equal(render.calls.length, 0);
        // A picture the user sent is fine.
        assert.equal((await gateway.callTool('create_video', template({ parametreler: { baslik: 'x', gorsel: join(images, 'sent.jpg') } }))).isError, false);
    });

    it('allows at most dailyVideos a day', async () => {
        const render = fakeRender();
        const { gateway } = setup({ fetchImpl: render.fetchImpl, videoConfig: { dailyVideos: 2 } });
        assert.equal((await gateway.callTool('create_video', template())).isError, false);
        assert.equal((await gateway.callTool('create_video', template())).isError, false);
        const third = await gateway.callTool('create_video', template());
        assert.equal(third.isError, true);
        assert.match(third.text, /video sınırı doldu \(2\)/);
        assert.equal(render.calls.length, 2);
    });

    it('one render at a time; a slow render answers "preparing, about N minutes" and is pushed to WhatsApp when done', async () => {
        let finish;
        const render = fakeRender((path) => (path === '/render' ? new Promise((resolve) => (finish = () => resolve(new Response(MP4(), { headers: { 'X-Render-Info': '{"frames":375,"ms":45000,"seconds":15}' } })))) : null));
        const { gateway, tools, sent } = setup({ fetchImpl: render.fetchImpl, videoConfig: { waitSec: 0.05 } });
        const first = await gateway.callTool('create_video', template({ sure: 20 }));
        assert.equal(first.isError, false);
        assert.match(first.text, /Video hazırlanıyor \(video_id: vid_[a-z0-9]+\)\. Yaklaşık 2 dakika sürer/);
        const id = first.text.match(/vid_[a-z0-9]+/)[0];
        const busy = await gateway.callTool('create_video', template());
        assert.equal(busy.isError, true);
        assert.match(busy.text, /başka bir video hazırlanıyor/);
        assert.match((await gateway.callTool('get_video', { video_id: id })).text, /hâlâ hazırlanıyor/);
        finish();
        await tools.waitIdle();
        await tick();
        assert.deepEqual(sent[0], { upload: 'video/mp4' });
        assert.equal(sent[1].type, 'video');
        assert.equal(sent[1].to, '905551112233');
        assert.match(sent[1].video.caption, /🎬 Hackathon duyurusu hazır/);
        assert.equal(tools.get(id).notify_state, 'sent');
        assert.match((await gateway.callTool('get_video', { video_id: id })).text, /Video hazır/);
        // The learned speed (45000 ms / 375 frames) now drives the estimate.
        assert.equal(tools.estimateMinutes(60), 4);
    });

    it('a render error or timeout is reported once, not retried', async () => {
        const render = fakeRender(() => new Response(JSON.stringify({ error: 'Video 5 dakikada bitmedi ve durduruldu.' }), { status: 504 }));
        const { gateway } = setup({ fetchImpl: render.fetchImpl });
        const answer = await gateway.callTool('create_video', template());
        assert.equal(answer.isError, false);
        assert.match(answer.text, /Video oluşturulamadı: Video 5 dakikada bitmedi/);
        assert.equal(render.calls.length, 1);
        // The slot is free again.
        assert.match((await gateway.callTool('create_video', template())).text, /oluşturulamadı/);
    });

    it('re-encodes only the WhatsApp preview when the original is too big', async () => {
        const render = fakeRender((path) => new Response(path === '/render' ? MP4(2 * 1024 * 1024) : MP4(1000), { headers: { 'X-Render-Info': '{}' } }));
        const { gateway, settings } = setup({ fetchImpl: render.fetchImpl, videoConfig: { previewMaxMb: 1 } });
        const answer = await gateway.callTool('create_video', template());
        assert.deepEqual(render.calls.map((call) => call.path), ['/render', '/preview']);
        const id = answer.text.match(/vid_[a-z0-9]+/)[0];
        assert.ok(readFileSync(join(settings.originalsDir, `${id}.mp4`)).length > 2 * 1024 * 1024);
        assert.ok(readFileSync(join(settings.originalsDir, `${id}-preview.mp4`)).length < 2000);
        assert.match(answer.text, /küçültülmüş kopya/);
    });

    it('without ECHO_RENDER_TOKEN the tool explains that video is not set up', async () => {
        const render = fakeRender();
        const { tools } = setup({ fetchImpl: render.fetchImpl });
        const video = normalizeVideo({}, {});
        assert.equal(video.token, null);
        const settings = { timeZone: 'Europe/Istanbul', referenceDirs: [], originalsDir: tempDir(), previewDir: tempDir(), logoDir: tempDir() };
        const bare = withVideo({ tools: [], callTool: async () => ({}) }, createVideoTools({ settings, video, db: openVideoDatabase(':memory:'), store: { get: () => null }, fetchImpl: render.fetchImpl }));
        assert.match((await bare.callTool('create_video', template())).text, /henüz kurulmamış/);
        assert.ok(tools);
    });

    it('a render row left over from a restart is marked failed by the background check', async () => {
        const render = fakeRender();
        const first = setup({ fetchImpl: render.fetchImpl });
        const db = openVideoDatabase(':memory:');
        db.prepare("INSERT INTO videos (id, created_at, updated_at, day, status, mode, platform, seconds) VALUES ('vid_old', 1, 1, '2026-01-01', 'rendering', 'template', 'reels', 10)").run();
        const tools = createVideoTools({ settings: first.settings, video: normalizeVideo({}, { ECHO_RENDER_TOKEN: 'x'.repeat(20) }), db, store: { get: () => null }, fetchImpl: render.fetchImpl });
        await tools.checkPending();
        assert.equal(tools.get('vid_old').status, 'failed');
    });
});

describe('video tools: attach and transcribe', () => {
    it('attach_to_trypost with a video_id uploads the original MP4; image ids still go to the gateway', async () => {
        const uploads = [];
        const trypost = {
            uploadMedia: async ({ file, filename, mimeType }) => {
                uploads.push({ size: file.size, filename, mimeType });
                return { uploadToken: 'up-1' };
            },
            request: async (method, path, body) => {
                uploads.push({ method, path, body });
                return { data: { id: 'post-9' } };
            },
        };
        const { gateway } = setup({ fetchImpl: fakeRender().fetchImpl, trypost });
        const made = await gateway.callTool('create_video', template());
        const id = made.text.match(/vid_[a-z0-9]+/)[0];
        const answer = await gateway.callTool('attach_to_trypost', { generation_id: id, social_account_id: 'acc-1', content: 'Hackathon!' });
        assert.equal(answer.isError, false, answer.text);
        assert.match(answer.text, /yeni taslak oluşturuldu \(post_id: post-9\)/);
        assert.equal(uploads[0].mimeType, 'video/mp4');
        assert.equal(uploads[0].filename, `${id}.mp4`);
        assert.deepEqual(uploads[1].body, { status: 'draft', social_account_id: 'acc-1', content: 'Hackathon!', media: [{ upload_token: 'up-1' }] });
        assert.deepEqual(await gateway.callTool('attach_to_trypost', { generation_id: 'gen_img1', post_id: '5' }), { text: 'gateway:attach_to_trypost:gen_img1', isError: false });
        assert.match((await gateway.callTool('get_original_file', { generation_id: id })).text, /\[\[as_document\]\]/);
    });

    it('transcribe_audio returns timed Turkish text of a generated speech', async () => {
        const render = fakeRender((path, body) => {
            assert.equal(path, '/transcribe');
            assert.equal(body.audio.mime, 'audio/mpeg');
            return new Response(JSON.stringify({ text: 'Merhaba arkadaşlar', segments: [{ start: 0, end: 1.5, text: 'Merhaba arkadaşlar' }] }), { headers: { 'Content-Type': 'application/json' } });
        });
        const { gateway } = setup({ fetchImpl: render.fetchImpl });
        const answer = await gateway.callTool('transcribe_audio', { generation_id: 'gen_voice1' });
        assert.equal(answer.isError, false, answer.text);
        assert.match(answer.text, /\[0:00-0:01\] Merhaba arkadaşlar/);
        assert.equal((await gateway.callTool('transcribe_audio', { generation_id: 'gen_img1' })).isError, true);
    });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
describe('approval card: create_video', { skip: python ? false : 'python3 is not installed' }, () => {
    const render = (cases) => {
        const result = spawnSync(python, ['-B', '-I', join(ROOT, 'deploy/oracle/hermes/plugins/echo_onay_tr/render.py')], { input: JSON.stringify(cases), encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };

    it('shows platform, ratio, length, "kredi harcamaz" and the summary', () => {
        const [reels, slide, free, attach] = render([
            { server: 'studio', tool: 'create_video', args: { sablon: 'etkinlik', platform: 'reels', sure: 20, ozet: 'Hackathon duyuru videosu' } },
            { server: 'studio', tool: 'create_video', args: { sablon: 'slayt', platform: 'kare', sure: 15.4, ozet: 'Etkinlikten kareler', seslendirme: 'gen_1' } },
            { server: 'studio', tool: 'create_video', args: { kompozisyon: { scenes: [] }, sure: 10, ozet: 'Serbest' } },
            { server: 'studio', tool: 'attach_to_trypost', args: { generation_id: 'vid_abc', post_id: '7', ozet: 'Hackathon videosu' } },
        ]);
        assert.equal(reels, '🎬 Video oluşturulacak · Instagram Reels (9:16) · 20 sn · kredi harcamaz\nKonu: Hackathon duyuru videosu\nŞablon: etkinlik duyurusu');
        assert.equal(slide, '🎬 Video oluşturulacak · Kare (1:1) · 15 sn · kredi harcamaz\nKonu: Etkinlikten kareler\nŞablon: slayt gösterisi\nSeslendirme + altyazı');
        assert.equal(free, '🎬 Video oluşturulacak · Instagram Reels (9:16) · 10 sn · kredi harcamaz\nKonu: Serbest\nSerbest kompozisyon');
        assert.equal(attach, "📎 Üretilen video TryPost'taki gönderiye eklenecek\nKonu: Hackathon videosu");
    });
});
