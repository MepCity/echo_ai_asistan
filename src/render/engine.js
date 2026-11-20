import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './cdp.js';

/**
 * Frames to MP4: the composition HTML is loaded in headless Chromium, every CSS animation is paused
 * and seeked to each frame's time (document.getAnimations(), the HyperFrames/Remotion approach: the
 * page never plays in real time, so a slow machine only renders slower, never drops frames), each
 * frame is a JPEG screenshot piped into ffmpeg (libx264, preset veryfast), and the audio is mixed in
 * by the same ffmpeg.
 *
 * The page is served from a made-up origin (https://render.invalid/) through the DevTools Fetch
 * domain: index.html and the job's own asset files are answered from memory/disk, every other request
 * (any other host, scheme or path) is failed before it leaves the browser. The container has no
 * network route either; this is the second wall.
 */

export const ORIGIN = 'https://render.invalid';

/** Runs ffmpeg/ffprobe; resolves { stdout, stderr }, rejects on a non-zero exit. */
export function run(command, args, { signal, input = null, maxOutput = 8 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], signal });
        let stdout = Buffer.alloc(0);
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            if (stdout.length < maxOutput) stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk.toString('utf8')).slice(-4000);
        });
        child.on('error', reject);
        child.on('close', (code, sig) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${command} failed (${sig ?? code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
        });
        if (input !== null) child.stdin.end(input);
    });
}

/** Duration in seconds of a media file (ffprobe), or null. */
export async function probeDuration(file, { signal, ffprobe = 'ffprobe' } = {}) {
    try {
        const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { signal });
        const value = Number(stdout.toString('utf8').trim());
        return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

/** ffmpeg arguments: JPEG frames on stdin, optional music/voiceover, H.264 + AAC MP4. */
export function ffmpegArgs({ fps, duration, output, music = null, musicVolume = 0.25, voiceover = null, voiceoverDelay = 0.4, crf = 23, preset = 'veryfast', threads = 2 }) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0'];
    const audio = [];
    if (music) {
        args.push('-stream_loop', '-1', '-i', music);
        audio.push('music');
    }
    if (voiceover) {
        args.push('-i', voiceover);
        audio.push('voiceover');
    }
    const filters = [];
    const fadeStart = Math.max(0, duration - 1.5).toFixed(2);
    audio.forEach((kind, index) => {
        const input = `${index + 1}:a`;
        if (kind === 'music') {
            // Quieter under a voiceover; faded out at the end either way.
            filters.push(`[${input}]volume=${voiceover ? Math.min(musicVolume, 0.18) : musicVolume},afade=t=in:d=0.6,afade=t=out:st=${fadeStart}:d=1.5[a${index}]`);
        } else {
            const ms = Math.round(voiceoverDelay * 1000);
            filters.push(`[${input}]adelay=${ms}|${ms},apad[a${index}]`);
        }
    });
    if (audio.length === 2) filters.push('[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]');
    const mapped = audio.length === 2 ? '[aout]' : audio.length === 1 ? '[a0]' : null;
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push('-map', '0:v');
    if (mapped) args.push('-map', mapped, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100');
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps), '-threads', String(threads), '-t', duration.toFixed(3), '-movflags', '+faststart', output);
    return args;
}

/**
 * Renders `html` (with `assets`: { "<path under ORIGIN>": { file, mime } }) to `output`.
 * size: { width, height, fps, duration }. audio: { music, voiceover, musicVolume } (files) or {}.
 * signal aborts (kills Chromium and ffmpeg). Returns { frames, ms }.
 */
export async function renderVideo({ html, assets = {}, size, audio = {}, output, signal, workDir, log = () => {}, ffmpeg = 'ffmpeg', chrome, quality = 90, onProgress = () => {} }) {
    const started = Date.now();
    const { width, height, fps, duration } = size;
    const frames = Math.round(duration * fps);
    const profile = mkdtempSync(join(workDir, 'chrome-'));
    const browser = launchChrome({ executable: chrome, userDataDir: profile, log });
    let encoder = null;
    const abort = () => {
        browser.process.kill('SIGKILL');
        encoder?.kill('SIGKILL');
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();
        const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
        const send = (method, params) => browser.send(method, params, sessionId);

        const blocked = [];
        browser.on('Fetch.requestPaused', (params, session) => {
            if (session !== sessionId) return;
            const url = String(params.request.url);
            const path = url.startsWith(`${ORIGIN}/`) ? url.slice(ORIGIN.length).split(/[?#]/)[0] : null;
            const answer = (body, mime) => send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: mime }, { name: 'Cache-Control', value: 'no-store' }], body: body.toString('base64') });
            let done;
            if (path === '/index.html') done = answer(Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
            else if (path && assets[path]) done = answer(readFileSync(assets[path].file), assets[path].mime);
            else {
                blocked.push(url.slice(0, 120));
                done = send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
            }
            done.catch((error) => log('warn', 'render fetch answer failed', error.message));
        });
        await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 15, g: 28, b: 71, a: 1 } });
        const loaded = new Promise((resolve) => browser.on('Page.loadEventFired', (_params, session) => session === sessionId && resolve()));
        const nav = await send('Page.navigate', { url: `${ORIGIN}/index.html` });
        if (nav.errorText) throw new Error(`composition did not load: ${nav.errorText}`);
        await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error('composition load timed out')), 30_000))]);
        const ready = await send('Runtime.evaluate', { expression: 'window.__ready()', awaitPromise: true, returnByValue: true });
        if (ready.exceptionDetails) throw new Error(`composition failed: ${ready.exceptionDetails.text}`);
        if (blocked.length) log('warn', `render blocked ${blocked.length} request(s)`, blocked.slice(0, 3).join(' '));

        encoder = spawn(ffmpeg, ffmpegArgs({ fps, duration, output, ...audio }), { stdio: ['pipe', 'ignore', 'pipe'] });
        let encoderError = '';
        encoder.stderr.on('data', (chunk) => {
            encoderError = (encoderError + chunk.toString('utf8')).slice(-4000);
        });
        const encoded = new Promise((resolve, reject) => {
            encoder.on('error', reject);
            encoder.on('close', (code, sig) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${sig ?? code}): ${encoderError.trim().split('\n').slice(-3).join(' | ')}`))));
        });
        encoded.catch(() => {});
        encoder.stdin.on('error', () => {});

        for (let frame = 0; frame < frames; frame++) {
            signal?.throwIfAborted();
            const time = frame / fps;
            await send('Runtime.evaluate', { expression: `window.__seek(${time.toFixed(5)})`, awaitPromise: true });
            const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true });
            const bytes = Buffer.from(shot.data, 'base64');
            if (!encoder.stdin.write(bytes)) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
            if (frame % fps === 0) onProgress(frame / frames);
        }
        encoder.stdin.end();
        await browser.close();
        await encoded;
        return { frames, ms: Date.now() - started, blocked: blocked.length };
    } finally {
        signal?.removeEventListener('abort', abort);
        const exited = browser.process.exitCode !== null || browser.process.signalCode ? Promise.resolve() : new Promise((done) => browser.process.once('exit', done));
        abort();
        // Chromium's helpers may still be writing the profile for a moment after the kill.
        await Promise.race([exited, new Promise((done) => setTimeout(done, 3000))]);
        try {
            rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch (error) {
            log('warn', 'render profile cleanup failed (the job folder is removed later)', error.message);
        }
    }
}
