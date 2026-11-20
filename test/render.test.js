import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findChrome } from '../src/render/cdp.js';
import { ffmpegArgs, renderVideo } from '../src/render/engine.js';
import { compositionHtml } from '../src/render/html.js';
import { assetKindsOf, runRenderJob } from '../src/render/job.js';
import { createRenderServer } from '../src/render/server.js';
import { LIMITS, RenderInputError, outputSize, safeString, validateComposition, validateJob, validateTemplate } from '../src/render/spec.js';
import { TEMPLATES, templateComposition } from '../src/render/templates.js';
import { captionsFrom, parseWhisperJson } from '../src/render/whisper.js';

/** The render service (src/render): input checks, page building, job flow, HTTP limits, one real render. */

const dirs = [];
const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-render-'));
    dirs.push(dir);
    return dir;
};
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'render-secret-0123456789abcdef';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const images = (ref, kind) => {
    if (kind !== 'image' || !['logo', 'a0'].includes(ref)) throw new RenderInputError(`bad asset ${ref}`);
    return ref;
};
const scene = (elements, extra = {}) => ({ duration: 5, elements, ...extra });
const check = (composition, seconds = 10) => validateComposition(composition, { seconds, asset: images });

describe('composition checks', () => {
    it('accepts a normal composition and lays scenes end to end, scaled to the length', () => {
        const out = check({
            background: { gradient: ['#3278f6', '#3cbdfa'], angle: 160 },
            scenes: [
                scene([{ type: 'text', text: 'Merhaba İstanbul', x: 10, y: 40, w: 80, size: 80, weight: 900, color: '#ffffff', align: 'center', animation: 'fade-up' }]),
                scene([{ type: 'image', asset: 'a0', x: 0, y: 0, w: 100, h: 100, kenburns: true }, { type: 'logo', variant: 'logo', x: 40, y: 85, w: 20 }], { transition: 'zoom', background: { image: 'a0', dim: 0.4 } }),
            ],
        }, 12);
        assert.deepEqual(out.scenes.map((s) => [s.start, s.duration]), [[0, 6], [6, 6]]);
        assert.equal(out.scenes[0].elements[0].text, 'Merhaba İstanbul');
    });

    it('rejects external URLs anywhere: text, asset fields, colours', () => {
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'Kayıt: https://evil.example/x' }])] }), /adres ya da kod/);
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'bak //evil.example' }])] }), RenderInputError);
        assert.throws(() => check({ scenes: [scene([{ type: 'image', asset: 'https://evil.example/a.png' }])] }), /bad asset/);
        assert.throws(() => check({ scenes: [scene([{ type: 'shape', color: 'url(https://x)' }])] }), /renk/);
        assert.throws(() => check({ background: { color: 'red; background: url(x)' }, scenes: [scene([])] }), /renk/);
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'data:text/html;base64,AAAA' }])] }), RenderInputError);
        // Without a scheme a site name is fine.
        assert.equal(check({ scenes: [scene([{ type: 'text', text: 'marmaraai.com/kayit' }])] }).scenes[0].elements[0].text, 'marmaraai.com/kayit');
    });

    it('rejects markup and scripts that fetch or open sockets', () => {
        for (const text of ['<script>fetch("/x")</script>', 'fetch("http://10.0.0.1")', 'new WebSocket("ws://x")', 'x = new XMLHttpRequest()', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', 'import("x")', '<iframe>']) {
            assert.throws(() => check({ scenes: [scene([{ type: 'text', text }])] }), RenderInputError, text);
        }
    });

    it('rejects unknown keys (no html/css/script field can be smuggled in) and wrong types', () => {
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'a', html: '<b>x</b>' }])] }), /bilinmeyen alan: html/);
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'a', style: 'color:red' }])] }), /bilinmeyen alan: style/);
        assert.throws(() => check({ script: 'x', scenes: [scene([])] }), /bilinmeyen alan: script/);
        assert.throws(() => check({ scenes: [scene([{ type: 'html', text: 'a' }])] }), /type/);
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'a', size: '80px' }])] }), /sayı/);
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'a', animation: 'spin' }])] }), /animation/);
        assert.throws(() => check({ scenes: [] }), /en az bir sahne/);
    });

    it('rejects oversized input: bytes, scenes, elements, text length', () => {
        const big = 'a'.repeat(250);
        const many = Array.from({ length: 12 }, () => ({ type: 'text', text: big }));
        assert.throws(() => check({ scenes: Array.from({ length: 12 }, () => scene(many)) }), /çok büyük/);
        assert.throws(() => check({ scenes: Array.from({ length: LIMITS.scenes + 1 }, () => scene([])) }), /en fazla 12 sahne/i);
        assert.throws(() => check({ scenes: [scene(Array.from({ length: LIMITS.elementsPerScene + 1 }, () => ({ type: 'shape' })))] }), /en fazla 12 öğe/);
        assert.throws(() => check({ scenes: [scene([{ type: 'text', text: 'x'.repeat(LIMITS.textChars + 1) }])] }), /en fazla 300 karakter/);
    });

    it('strips bidi overrides and control characters from text', () => {
        assert.equal(safeString('ab‮cd\u0007', 'f'), 'abcd');
    });

    it('checks template parameters: required ones, unknown ones, asset kinds', () => {
        assert.throws(() => validateTemplate('etkinlik', {}, { asset: images }), /"baslik" gerekli/);
        assert.throws(() => validateTemplate('etkinlik', { baslik: 'x', renk: '#fff' }, { asset: images }), /bilinmeyen alan: renk/);
        assert.throws(() => validateTemplate('yok', {}, { asset: images }), /Şablon/);
        assert.throws(() => validateTemplate('slayt', { gorseller: [] }, { asset: images }), /1-10/);
        assert.throws(() => validateTemplate('alinti', { alinti: 'a', kisi: 'b', foto: 'https://x.example/p.png' }, { asset: images }), /bad asset/);
        assert.deepEqual(validateTemplate('slayt', { gorseller: ['a0', 'a0'], yazilar: ['Bir', ''] }, { asset: images }), { gorseller: ['a0', 'a0'], yazilar: ['Bir', ''] });
    });

    it('validates a whole job: size caps, length caps, template xor composition, asset kinds', () => {
        const kinds = { a0: 'image', a1: 'audio', logo: 'image', 'logo-dark': 'image' };
        const base = { size: { width: 1080, height: 1920, fps: 30 }, seconds: 15, template: 'ozel_gun', params: { baslik: '29 Ekim' } };
        assert.equal(validateJob(base, { assetKinds: kinds }).seconds, 15);
        assert.throws(() => validateJob({ ...base, size: { width: 1920, height: 1920, fps: 30 } }, { assetKinds: kinds }), /1080x1920/);
        assert.throws(() => validateJob({ ...base, seconds: 61 }, { assetKinds: kinds }), /3-60 saniye/);
        assert.throws(() => validateJob({ ...base, size: { width: 1080, height: 1920, fps: 60 } }, { assetKinds: kinds }), /fps/);
        assert.throws(() => validateJob({ ...base, composition: { scenes: [scene([])] } }, { assetKinds: kinds }), /ikisi birden değil/);
        assert.throws(() => validateJob({ ...base, audio: { music: 'a0' } }, { assetKinds: kinds }), /ses olmalı/);
        assert.throws(() => validateJob({ ...base, audio: { music: 'a9' } }, { assetKinds: kinds }), /dosya yok/);
        assert.deepEqual(outputSize('reels', 720), { width: 720, height: 1280 });
        assert.deepEqual(outputSize('x', 1080), { width: 1920, height: 1080 });
    });

    it('checks job assets: count, type and size', () => {
        assert.throws(() => assetKindsOf({ a0: { mime: 'text/html', bytes: Buffer.from('x') } }), /Desteklenmeyen/);
        assert.throws(() => assetKindsOf({ '../x': { mime: 'image/png', bytes: PNG } }), /Geçersiz/);
        assert.throws(() => assetKindsOf({ a0: { mime: 'image/png', bytes: Buffer.alloc(LIMITS.assetBytes + 1) } }), /15 MB/);
        assert.deepEqual(assetKindsOf({ a0: { mime: 'image/png', bytes: PNG }, a1: { mime: 'audio/mpeg', bytes: Buffer.from('x') } }), { a0: 'image', a1: 'audio' });
    });
});

describe('composition page', () => {
    it('escapes text, serves only local assets and locks the page with a CSP', () => {
        const composition = { width: 1080, height: 1920, fps: 30, duration: 4, ...templateComposition('alinti', { alinti: 'Ali & Ayşe "yapay" zekâ', kisi: 'O\'Neil', foto: 'a0' }, 4) };
        const html = compositionHtml(composition, { assetPath: (id) => `/a/${id}.png`, captions: [{ start: 0.5, end: 2, text: 'altyazı <b>' }] });
        assert.match(html, /Ali &amp; Ayşe &quot;yapay&quot; zekâ/);
        assert.match(html, /altyazı &lt;b&gt;/);
        assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src https:\/\/render.invalid;/);
        assert.match(html, /connect-src 'none'/);
        assert.doesNotMatch(html, /https?:\/\/(?!render\.invalid)/);
        assert.equal((html.match(/<script/g) ?? []).length, 1);
    });

    it('every template builds a composition that passes the same checks as a free one', () => {
        const params = {
            etkinlik: { baslik: 'Atölye', tarih: '12 Mart', saat: '18.00', yer: 'B-201', gorsel: 'a0' },
            ozel_gun: { baslik: '23 Nisan' },
            alinti: { alinti: 'Söz', kisi: 'Ayşe', foto: 'a0' },
            slayt: { baslik: 'Hackathon', gorseller: ['a0', 'a0', 'a0'], yazilar: ['a', 'b'] },
        };
        const kinds = { a0: 'image', logo: 'image', 'logo-dark': 'image' };
        for (const name of Object.keys(TEMPLATES)) {
            const built = templateComposition(name, params[name], 15);
            const end = built.scenes.at(-1).start + built.scenes.at(-1).duration;
            assert.ok(Math.abs(end - 15) < 0.05, `${name} ends at ${end}`);
            const scenes = built.scenes.map(({ start, ...rest }) => rest);
            validateComposition({ background: built.background, scenes }, { seconds: 15, asset: (ref, kind) => (kinds[ref] === kind ? ref : assert.fail(`${name}: ${ref}`)) });
        }
    });
});

describe('brand palette', () => {
    // #3278f6, #3cbdfa, #0f1c47, #1e6bf5, #f1f5f9 and white; any alpha of these is fine.
    const PALETTE = new Set(['3278f6', '3cbdfa', '0f1c47', '1e6bf5', 'f1f5f9', 'ffffff']);
    const hex6 = (value) => {
        let hex = value.slice(1).toLowerCase();
        if (hex.length <= 4) hex = [...hex.slice(0, 3)].map((ch) => ch + ch).join('');
        return hex.slice(0, 6);
    };
    /** Every colour in a page: #hex and rgb()/rgba(), as 6-digit hex; named colours other than transparent fail. */
    function colours(html) {
        const found = new Set();
        const css = html.replace(/<script[\s\S]*?<\/script>/g, '');
        for (const match of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) found.add(hex6(match[0]));
        for (const match of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
            found.add(match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join(''));
        }
        for (const match of css.matchAll(/(?:color|background)\s*:\s*([a-z]+)\b/gi)) {
            if (!['transparent', 'linear', 'rgb', 'rgba'].includes(match[1].toLowerCase())) found.add(match[1]);
        }
        return found;
    }

    const PARAMS = {
        etkinlik: [{ baslik: 'Atölye', tarih: '12 Mart', saat: '18.00', yer: 'B-201', konusmaci: 'Ayşe', aciklama: 'Gel!', gorsel: 'a0' }, { baslik: 'Atölye', tarih: '12 Mart' }],
        ozel_gun: [{ baslik: '23 Nisan', mesaj: 'Kutlu olsun', gorsel: 'a0' }, { baslik: '23 Nisan' }],
        alinti: [{ alinti: 'Söz', kisi: 'Ayşe', unvan: 'Araştırmacı', foto: 'a0' }, { alinti: 'Söz', kisi: 'Ayşe' }],
        slayt: [{ baslik: 'Hackathon', gorseller: ['a0', 'a0'], yazilar: ['Bir', 'İki'], kapanis: 'Son' }],
    };

    it('every template, scene and subtitle uses only brand colours', () => {
        // The check itself sees off-brand colours in every form.
        assert.deepEqual([...colours('<div style="background: #16306e; color: red; border-color: rgba(90, 58, 63, .5); fill: #FFF"></div>')].sort(), ['16306e', '5a3a3f', 'ffffff', 'red']);
        for (const [name, variants] of Object.entries(PARAMS)) {
            for (const params of variants) {
                const composition = { width: 1080, height: 1920, fps: 25, duration: 15, ...templateComposition(name, params, 15) };
                const html = compositionHtml(composition, { assetPath: (id) => `/a/${id}.png`, captions: [{ start: 1, end: 2, text: 'altyazı' }] });
                const off = [...colours(html)].filter((colour) => !PALETTE.has(colour));
                assert.deepEqual(off, [], `${name}: off-brand colours ${off.join(', ')}`);
                // The scene specs themselves too (backgrounds, element colours, borders, gradients).
                const spec = JSON.stringify(composition);
                for (const match of spec.matchAll(/#[0-9a-f]{3,8}\b/gi)) assert.ok(PALETTE.has(hex6(match[0])), `${name}: ${match[0]}`);
            }
        }
    });

    it('a backdrop photo behind text is tinted to the brand blue; slideshow photos keep their colours', () => {
        const event = templateComposition('etkinlik', { baslik: 'x', gorsel: 'a0' }, 10);
        assert.equal(event.scenes[1].background.tint, true);
        const html = compositionHtml({ width: 1080, height: 1920, fps: 25, duration: 10, ...event }, { assetPath: (id) => `/a/${id}.png` });
        assert.match(html, /filter: grayscale\(1\)/);
        assert.match(html, /background: #1e6bf5; mix-blend-mode: color/);
        const slides = templateComposition('slayt', { gorseller: ['a0'] }, 10);
        assert.ok(slides.scenes.every((scene) => !scene.background?.tint));
    });
});

describe('subtitles', () => {
    it('reads whisper.cpp JSON and merges short segments into caption cards', () => {
        const segments = parseWhisperJson({ transcription: [
            { offsets: { from: 0, to: 900 }, text: ' Merhaba' },
            { offsets: { from: 900, to: 1800 }, text: ' arkadaşlar,' },
            { offsets: { from: 1800, to: 2000 }, text: ' [MUSIC]' },
            { offsets: { from: 2100, to: 5200 }, text: ' bugün yapay zekâ atölyemize hoş geldiniz.' },
        ] });
        assert.equal(segments.length, 3);
        const cards = captionsFrom(segments, { offset: 0.4 });
        assert.deepEqual(cards[0], { start: 0.4, end: 2.2, text: 'Merhaba arkadaşlar,' });
        assert.equal(cards[1].text, 'bugün yapay zekâ atölyemize hoş geldiniz.');
    });
});

describe('ffmpeg arguments', () => {
    it('encodes with veryfast, mixes a ducked music bed with a delayed voiceover', () => {
        const args = ffmpegArgs({ fps: 25, duration: 15, output: '/tmp/o.mp4', music: '/m.mp3', voiceover: '/v.mp3', musicVolume: 0.3 });
        const text = args.join(' ');
        assert.match(text, /-preset veryfast/);
        assert.match(text, /-stream_loop -1 -i \/m.mp3 -i \/v.mp3/);
        assert.match(text, /volume=0.18/);
        assert.match(text, /adelay=400\|400/);
        assert.match(text, /amix=inputs=2/);
        assert.match(text, /-t 15.000/);
        assert.doesNotMatch(ffmpegArgs({ fps: 25, duration: 5, output: '/o.mp4' }).join(' '), /-c:a/);
    });
});

describe('render job (fake renderer)', () => {
    const assets = { a0: { mime: 'image/png', bytes: PNG }, a1: { mime: 'audio/mpeg', bytes: Buffer.from('ID3fake') }, 'logo-dark': { mime: 'image/png', bytes: PNG } };

    it('a voiceover makes the video as long as the speech and adds subtitles', async () => {
        let rendered;
        const result = await runRenderJob({
            job: { size: { width: 720, height: 1280, fps: 25 }, seconds: 10, template: 'slayt', params: { gorseller: ['a0'] }, audio: { voiceover: 'a1', subtitles: true } },
            assets,
            workRoot: tempDir(),
            deps: {
                probe: async () => 14.2,
                transcribe: async () => ({ segments: [{ start: 0, end: 2, text: 'Merhaba' }, { start: 2.1, end: 3, text: 'dünya' }] }),
                render: async (input) => {
                    rendered = input;
                    return { frames: Math.round(input.size.duration * input.size.fps), ms: 5 };
                },
            },
        });
        assert.equal(result.seconds, 15.4);
        assert.equal(rendered.size.duration, 15.4);
        assert.equal(result.captions, 1);
        assert.match(rendered.html, /Merhaba dünya/);
        assert.ok(rendered.audio.voiceover.endsWith('a1.mp3'));
        // Only image files are served to the page; the audio goes to ffmpeg.
        assert.deepEqual(Object.keys(rendered.assets).sort(), ['/a/a0.png', '/a/logo-dark.png']);
    });

    it('never renders an invalid job', async () => {
        let called = false;
        await assert.rejects(
            runRenderJob({ job: { size: { width: 720, height: 1280, fps: 25 }, seconds: 10, composition: { scenes: [scene([{ type: 'text', text: 'fetch("https://x")' }])] } }, assets, workRoot: tempDir(), deps: { render: async () => (called = true) } }),
            RenderInputError,
        );
        assert.equal(called, false);
    });
});

describe('render HTTP service', () => {
    async function start(deps, options = {}) {
        const server = createRenderServer({ token: TOKEN, workRoot: tempDir(), deps, ...options });
        await new Promise((done) => server.listen(0, '127.0.0.1', done));
        const url = `http://127.0.0.1:${server.address().port}`;
        return { server, url, close: () => new Promise((done) => server.close(done)) };
    }
    const post = (url, body, token = TOKEN) => fetch(`${url}/render`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    it('needs the bearer, refuses bad input with a Turkish message', async () => {
        const svc = await start({});
        try {
            assert.equal((await post(svc.url, {}, 'wrong-token-0123456789')).status, 401);
            const bad = await post(svc.url, { job: { size: { width: 1080, height: 1920, fps: 30 }, seconds: 99, template: 'ozel_gun', params: { baslik: 'x' } } });
            assert.equal(bad.status, 400);
            assert.match((await bad.json()).error, /saniye/);
            assert.equal((await fetch(`${svc.url}/health`)).status, 200);
        } finally {
            await svc.close();
        }
    });

    it('runs one job at a time (409) and kills a job past the time limit (504)', async () => {
        let release;
        const svc = await start({
            runJob: ({ signal }) => new Promise((resolve, reject) => {
                release = resolve;
                signal.addEventListener('abort', () => reject(new Error('killed')));
            }),
        }, { timeoutSec: 0.3 });
        try {
            const first = post(svc.url, { job: {} });
            await new Promise((done) => setTimeout(done, 50));
            const second = await post(svc.url, { job: {} });
            assert.equal(second.status, 409);
            const timedOut = await first;
            assert.equal(timedOut.status, 504);
            assert.match((await timedOut.json()).error, /durduruldu/);
            // The slot is free again after the timeout.
            release?.();
            const third = post(svc.url, { job: {} });
            const answer = await third;
            assert.equal(answer.status, 504);
        } finally {
            await svc.close();
        }
    });
});

const chrome = findChrome();
const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
const canRender = existsSync(chrome) && ffmpegOk ? false : 'Chromium or ffmpeg is not installed';

describe('real render (Chromium + ffmpeg)', { skip: canRender }, () => {
    it('renders a template to a playable H.264 MP4 of the asked size and length', async () => {
        const work = tempDir();
        const logo = new URL('../deploy/oracle/brand/logo-dark.png', import.meta.url);
        const assets = { a0: { mime: 'image/png', bytes: PNG } };
        if (existsSync(logo)) assets['logo-dark'] = { mime: 'image/png', bytes: readFileSync(logo) };
        const logs = [];
        const result = await runRenderJob({
            job: { size: { width: 216, height: 384, fps: 24 }, seconds: 3, template: 'etkinlik', params: { baslik: 'Deneme Atölyesi', tarih: '1 Nisan', gorsel: 'a0' } },
            assets,
            workRoot: work,
            log: (...parts) => logs.push(parts.join(' ')),
        });
        assert.equal(result.frames, 72);
        assert.ok(statSync(result.file).size > 1000);
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', result.file], { encoding: 'utf8' });
        assert.equal(probe.stdout.trim(), 'h264,216,384');
    });

    it('blocks every request that is not the page or its own assets (images, fetch, sockets, navigation)', async () => {
        const work = tempDir();
        const html = `<!doctype html><html><body style="margin:0;background:#123">
<img src="https://example.com/x.png"><img src="http://10.0.0.1/y.png"><img src="/a/missing.png">
<script>
fetch('https://example.com/steal').catch(() => {});
try { new WebSocket('wss://example.com/s'); } catch (e) {}
window.__ready = async () => { await new Promise((r) => setTimeout(r, 300)); return true; };
window.__seek = () => true;
</script></body></html>`;
        const logs = [];
        const result = await renderVideo({ html, size: { width: 64, height: 64, fps: 10, duration: 0.5 }, output: join(work, 'o.mp4'), workDir: work, log: (...parts) => logs.push(parts.join(' ')) });
        assert.ok(result.blocked >= 4, `blocked ${result.blocked}: ${logs.join(' | ')}`);
        assert.ok(statSync(join(work, 'o.mp4')).size > 0);
    });

    it('a page that navigates away fails the render instead of loading anything', async () => {
        const work = tempDir();
        const html = `<!doctype html><html><body><script>
window.__ready = async () => { location.href = 'https://example.com/nav'; await new Promise((r) => setTimeout(r, 500)); return true; };
window.__seek = () => true;
</script></body></html>`;
        await assert.rejects(renderVideo({ html, size: { width: 64, height: 64, fps: 10, duration: 0.5 }, output: join(work, 'o.mp4'), workDir: work }));
    });
});
