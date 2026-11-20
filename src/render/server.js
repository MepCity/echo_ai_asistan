import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { probeDuration, run } from './engine.js';
import { runRenderJob } from './job.js';
import { RenderInputError } from './spec.js';
import { transcribe } from './whisper.js';

/**
 * The render service's HTTP API (port 8092 on the compose "render" network, which has no route out;
 * only the studio reaches it). Every call but GET /health needs `Authorization: Bearer
 * <ECHO_RENDER_TOKEN>`. One job at a time (a second gets 409), each under a wall-clock limit (the job
 * is killed: Chromium, ffmpeg, whisper).
 *
 * POST /render     JSON { job, assets: { id: { mime, data: base64 } } } → video/mp4 body,
 *                  X-Render-Info header { frames, ms, seconds, captions, width, height, fps }
 * POST /transcribe JSON { audio: { mime, data }, language? } → { text, segments }
 * POST /preview    MP4 body, ?max_mb=15 → a smaller MP4 (720p, bitrate for the size) for WhatsApp
 * Errors: 400 { error } (Turkish, for the user), 401, 409 busy, 413, 504 timeout, 500.
 */

const MB = 1024 * 1024;

export function bearerMatches(header, secret) {
    if (!secret) return false;
    const match = String(header ?? '').match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const given = createHash('sha256').update(match[1].trim()).digest();
    const expected = createHash('sha256').update(secret).digest();
    return timingSafeEqual(given, expected);
}

async function readBody(request, max) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > max) return null;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function decodeAssets(raw) {
    const out = {};
    if (raw === undefined) return out;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RenderInputError('assets bir nesne olmalı.');
    for (const [id, asset] of Object.entries(raw)) {
        if (!asset || typeof asset.mime !== 'string' || typeof asset.data !== 'string') throw new RenderInputError('Dosya biçimi hatalı.');
        out[id] = { mime: asset.mime, bytes: Buffer.from(asset.data, 'base64') };
    }
    return out;
}

/** deps: { runJob, transcribe, preview } injectable for tests. */
export function createRenderServer({ token, workRoot, timeoutSec = 300, maxBodyMb = 64, log = () => {}, deps = {} }) {
    if (!token || String(token).length < 16) throw new Error('ECHO_RENDER_TOKEN must be set (at least 16 characters)');
    const runJob = deps.runJob ?? runRenderJob;
    const speechToText = deps.transcribe ?? transcribe;
    const shrink = deps.preview ?? makePreview;
    let busy = false;

    const send = (response, status, body, headers = {}) => {
        if (response.headersSent) return response.end();
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(JSON.stringify(body));
    };

    /** Runs `work(signal)` as the one job, under the wall-clock limit. */
    async function exclusive(response, work) {
        if (busy) return send(response, 409, { error: 'Şu an başka bir video hazırlanıyor; o bitince tekrar dene.' });
        busy = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutSec * 1000);
        try {
            await work(controller.signal);
        } catch (error) {
            if (controller.signal.aborted) {
                log('warn', 'render job timed out', `${timeoutSec}s`);
                send(response, 504, { error: `Video ${Math.round(timeoutSec / 60)} dakikada bitmedi ve durduruldu. Daha kısa ya da daha sade bir video dene.` });
            } else if (error instanceof RenderInputError) {
                send(response, 400, { error: error.userMessage });
            } else {
                log('error', 'render job failed', String(error.message).slice(0, 500));
                send(response, 500, { error: 'Video oluşturulurken bir hata oldu.' });
            }
        } finally {
            clearTimeout(timer);
            busy = false;
        }
    }

    async function handle(request, response) {
        const url = new URL(request.url, 'http://render');
        if (url.pathname === '/health' && request.method === 'GET') return send(response, 200, { ok: true, busy });
        if (!['/render', '/transcribe', '/preview'].includes(url.pathname)) return send(response, 404, { error: 'not found' });
        if (!bearerMatches(request.headers.authorization, token)) return send(response, 401, { error: 'unauthorized' });
        if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });
        if (busy) return send(response, 409, { error: 'Şu an başka bir video hazırlanıyor; o bitince tekrar dene.' });
        const body = await readBody(request, maxBodyMb * MB);
        if (body === null) return send(response, 413, { error: 'İstek çok büyük.' });

        if (url.pathname === '/preview') {
            const maxMb = Math.min(Math.max(Number(url.searchParams.get('max_mb')) || 15, 1), 64);
            return exclusive(response, async (signal) => {
                const dir = mkdtempSync(join(workRoot, 'preview-'));
                try {
                    writeFileSync(join(dir, 'in.mp4'), body);
                    const out = await shrink(join(dir, 'in.mp4'), join(dir, 'out.mp4'), { maxMb, signal });
                    await stream(response, out, {});
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        }

        let parsed;
        try {
            parsed = JSON.parse(body.toString('utf8'));
        } catch {
            return send(response, 400, { error: 'İstek okunamadı.' });
        }
        if (url.pathname === '/transcribe') {
            return exclusive(response, async (signal) => {
                const assets = decodeAssets({ a0: parsed?.audio });
                if (!assets.a0.mime.startsWith('audio/')) throw new RenderInputError('Ses dosyası olmalı.');
                const dir = mkdtempSync(join(workRoot, 'stt-'));
                try {
                    writeFileSync(join(dir, 'in.audio'), assets.a0.bytes);
                    const language = /^[a-z]{2}$/.test(parsed?.language ?? '') ? parsed.language : 'tr';
                    const result = await speechToText(join(dir, 'in.audio'), { workDir: dir, language, signal });
                    send(response, 200, result);
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        }
        return exclusive(response, async (signal) => {
            const assets = decodeAssets(parsed?.assets);
            let result;
            try {
                result = await runJob({ job: parsed?.job, assets, workRoot, signal, log });
                const info = { frames: result.frames, ms: result.ms, seconds: result.seconds, captions: result.captions, width: result.width, height: result.height, fps: result.fps };
                log('info', `render done ${result.width}x${result.height} ${result.seconds}s ${result.frames} frames in ${result.ms} ms`);
                await stream(response, result.file, { 'X-Render-Info': JSON.stringify(info) });
            } finally {
                if (result?.workDir) rmSync(result.workDir, { recursive: true, force: true });
            }
        });
    }

    function stream(response, file, headers) {
        return new Promise((resolve, reject) => {
            response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': statSync(file).size, ...headers });
            const source = createReadStream(file);
            source.on('error', reject);
            response.on('finish', resolve);
            response.on('close', resolve);
            source.pipe(response);
        });
    }

    const server = createServer((request, response) => {
        handle(request, response).catch((error) => {
            log('error', 'render request failed', error.message);
            send(response, 500, { error: 'error' });
        });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    return server;
}

/** A WhatsApp-sized copy: shorter side 720, bitrate chosen so the file stays under maxMb. */
export async function makePreview(input, output, { maxMb = 15, signal, ffmpeg = 'ffmpeg' } = {}) {
    const seconds = (await probeDuration(input, { signal })) ?? 60;
    const audioKbps = 96;
    const videoKbps = Math.max(300, Math.floor(((maxMb * 8 * 1024 * 0.92) / seconds) - audioKbps));
    await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-vf', "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
        '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', output,
    ], { signal });
    return output;
}
